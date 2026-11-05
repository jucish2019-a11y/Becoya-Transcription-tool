import { useCallback, useEffect, useRef, useState } from 'react';
import { getModel } from '../shared/models';
import {
  LanguageHint,
  QualityFlag,
  Segment,
  TranscriptionStyle,
  formatTimestamp,
} from '../shared/transcript';
import { AudioChunk, chunkAudio } from '../utils/audioChunker';
import { newId, uniqueSpeakers, withIds } from '../utils/transcript';
import { HistoryItem } from './useHistory';

export interface TranscribeOptions {
  model: string;
  style: TranscriptionStyle;
  language: LanguageHint;
  expectedSpeakers?: number;
  vocabulary: string;
}

interface ChunkOutput {
  segments: Segment[];
  flags: QualityFlag[];
}

export type SessionStatus = 'transcribing' | 'paused' | 'failed' | 'completed';

export interface Session {
  historyId: string;
  audioBlob: Blob;
  mimeType: string;
  sourceName: string;
  chunks: AudioChunk[];
  results: Record<number, ChunkOutput>;
  nextChunkIndex: number;
  status: SessionStatus;
  error?: string;
  options: TranscribeOptions;
}

interface Deps {
  addItem: (item: HistoryItem) => void;
  updateItem: (id: string, fn: (item: HistoryItem) => HistoryItem) => void;
  onStarted: (id: string) => void;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      if (typeof reader.result !== 'string') return reject(new Error('Failed to read audio.'));
      resolve(reader.result.split(',')[1] ?? '');
    };
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read audio.'));
    reader.readAsDataURL(blob);
  });
}

const rangeLabel = (c: AudioChunk) => `${formatTimestamp(c.startTimeSec)} - ${formatTimestamp(c.endTimeSec)}`;
const DEFAULT_TITLES = ['Voice Recording', 'New Transcription'];

export function useTranscriber({ addItem, updateItem, onStarted }: Deps) {
  const [session, setSession] = useState<Session | null>(null);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [statusText, setStatusText] = useState('');
  const [error, setError] = useState('');

  const sessionRef = useRef<Session | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const pausedRef = useRef(false);
  /** Bumped by every new run and by cancel(), so a stale (aborted) run can never publish state. */
  const runIdRef = useRef(0);

  const publish = useCallback((s: Session | null) => {
    sessionRef.current = s;
    setSession(s);
  }, []);

  useEffect(() => () => abortRef.current?.abort(), []);

  /** Speakers and last turns from the parts before `index`, so labels stay consistent. */
  const buildContext = (s: Session, index: number) => {
    const speakers: string[] = [];
    let tail: Segment[] = [];
    for (let k = 0; k < index; k++) {
      const r = s.results[k];
      if (!r) continue;
      for (const sp of uniqueSpeakers(r.segments)) if (!speakers.includes(sp)) speakers.push(sp);
      if (r.segments.length > 0) tail = r.segments;
    }
    if (speakers.length === 0) return undefined;
    return { speakers, tail: tail.slice(-4).map((t) => ({ speaker: t.speaker, text: t.text })) };
  };

  const transcribeOne = async (s: Session, index: number, signal: AbortSignal): Promise<ChunkOutput> => {
    const chunk = s.chunks[index];
    const base64Audio = await blobToBase64(chunk.blob);
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

    const response = await fetch('/api/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        base64Audio,
        mimeType: chunk.mimeType,
        model: s.options.model,
        style: s.options.style,
        language: s.options.language,
        expectedSpeakers: s.options.expectedSpeakers,
        vocabulary: s.options.vocabulary,
        chunk: { index, total: s.chunks.length, startSec: chunk.startTimeSec, endSec: chunk.endTimeSec },
        context: buildContext(s, index),
      }),
    });

    let data: any = null;
    try {
      data = await response.json();
    } catch {
      /* non-JSON error page */
    }
    if (!response.ok) {
      throw new Error(data?.error || `Transcription failed (HTTP ${response.status}).`);
    }

    const segments = withIds(data.segments ?? []).map((seg) => ({ ...seg, chunk: index }));
    return { segments, flags: (data.flags ?? []) as QualityFlag[] };
  };

  const commitChunk = (s: Session, index: number, output: ChunkOutput) => {
    s.results[index] = output;
    const completed = Object.keys(s.results).length;
    const total = s.chunks.length;

    updateItem(s.historyId, (item) => {
      // Replace only this part so edits made to other parts are never overwritten.
      const others = item.segments.filter((seg) => seg.chunk !== index);
      const segments = [...others, ...output.segments].sort(
        (a, b) => (a.chunk ?? -1) - (b.chunk ?? -1) || a.start - b.start
      );
      const flags = [...item.flags.filter((f) => f.chunk !== index), ...output.flags].sort(
        (a, b) => a.chunk - b.chunk
      );
      return {
        ...item,
        segments,
        flags,
        isPartial: completed < total,
        completedParts: completed,
        totalParts: total,
        model: s.options.model,
      };
    });
  };

  const finish = (s: Session) => {
    setIsTranscribing(false);
    setStatusText('Complete!');
    setProgress(100);
    updateItem(s.historyId, (item) => {
      const first = item.segments[0]?.text.split(/\s+/).filter(Boolean) ?? [];
      const generated = first.slice(0, 5).join(' ') + (first.length > 5 ? '...' : '');
      const useGenerated =
        generated && (!item.title || DEFAULT_TITLES.includes(item.title) || item.title.startsWith('Recording'));
      return { ...item, title: useGenerated ? generated : item.title, isPartial: false };
    });
    publish({ ...s, status: 'completed', nextChunkIndex: s.chunks.length, error: undefined });
    setTimeout(() => {
      setProgress(0);
      setStatusText('');
    }, 2000);
  };

  const runChunks = async (s: Session, indices: number[], sequential: boolean) => {
    setIsTranscribing(true);
    setError('');
    pausedRef.current = false;
    const myRun = ++runIdRef.current;
    const total = s.chunks.length;

    for (const i of indices) {
      const chunk = s.chunks[i];
      if (runIdRef.current !== myRun) return;
      if (pausedRef.current) {
        if (sequential) publish({ ...s, status: 'paused', nextChunkIndex: i });
        setIsTranscribing(false);
        setStatusText(`Paused at part ${i + 1} of ${total} (${rangeLabel(chunk)})`);
        return;
      }

      setStatusText(
        total > 1 ? `Transcribing part ${i + 1} of ${total} (${rangeLabel(chunk)})...` : 'Uploading & transcribing audio...'
      );
      setProgress(Math.round(((Object.keys(s.results).length + 0.15) / total) * 100));

      abortRef.current = new AbortController();
      try {
        const output = await transcribeOne(s, i, abortRef.current.signal);
        if (runIdRef.current !== myRun) return;
        commitChunk(s, i, output);
        if (sequential) s.nextChunkIndex = i + 1;
        // Re-running a single part must not change the session's overall status.
        publish({ ...s, results: { ...s.results }, ...(sequential ? { status: 'transcribing' as const } : {}) });
        setProgress(Math.round((Object.keys(s.results).length / total) * 100));
      } catch (err: any) {
        if (runIdRef.current !== myRun) return;
        if (pausedRef.current || err?.name === 'AbortError') {
          if (sequential) publish({ ...s, status: 'paused', nextChunkIndex: i });
          setIsTranscribing(false);
          setStatusText(`Paused at part ${i + 1} of ${total} (${rangeLabel(chunk)})`);
          return;
        }
        console.error(`Transcription error on part ${i + 1}:`, err);
        const message = `Part ${i + 1} of ${total} (${rangeLabel(chunk)}) failed: ${err?.message || 'unknown error'}`;
        setError(message);
        if (sequential) publish({ ...s, status: 'failed', nextChunkIndex: i, error: message });
        setIsTranscribing(false);
        setStatusText(`Stopped at part ${i + 1} of ${total}`);
        return;
      }
    }

    if (sequential) finish(s);
    else {
      setIsTranscribing(false);
      setStatusText('');
      setProgress(0);
    }
  };

  const start = useCallback(
    async (blob: Blob, mimeType: string, sourceName: string, options: TranscribeOptions) => {
      setIsTranscribing(true);
      setError('');
      setProgress(0);
      setStatusText('Preparing audio segments...');
      pausedRef.current = false;

      try {
        const { chunks, durationSec } = await chunkAudio(blob, mimeType, getModel(options.model)?.chunkSec ?? 300);
        const id = newId();
        onStarted(id);

        const s: Session = {
          historyId: id,
          audioBlob: blob,
          mimeType,
          sourceName,
          chunks,
          results: {},
          nextChunkIndex: 0,
          status: 'transcribing',
          options,
        };
        publish(s);
        addItem({
          id,
          title: sourceName || 'New Transcription',
          date: new Date().toISOString(),
          content: '',
          segments: [],
          speakerNames: {},
          flags: [],
          model: options.model,
          isPartial: chunks.length > 1,
          completedParts: 0,
          totalParts: chunks.length,
          durationSec,
        });
        await runChunks(s, chunks.map((_, i) => i), true);
      } catch (err) {
        setIsTranscribing(false);
        setProgress(0);
        setStatusText('');
        setError(err instanceof Error ? err.message : 'Failed to analyze audio.');
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  const resume = useCallback(async (modelOverride?: string) => {
    const s = sessionRef.current;
    if (!s) return;
    const next: Session = {
      ...s,
      status: 'transcribing',
      error: undefined,
      options: modelOverride ? { ...s.options, model: modelOverride } : s.options,
    };
    publish(next);
    const remaining = next.chunks.map((_, i) => i).filter((i) => i >= next.nextChunkIndex);
    await runChunks(next, remaining, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Re-runs one part (for example one the quality checks flagged). */
  const retryChunk = useCallback(async (index: number) => {
    const s = sessionRef.current;
    if (!s || !s.chunks[index]) return;
    await runChunks(s, [index], false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pause = useCallback(() => {
    pausedRef.current = true;
    abortRef.current?.abort();
    setIsTranscribing(false);
    setStatusText('Transcription paused.');
    const s = sessionRef.current;
    if (s && s.status === 'transcribing') publish({ ...s, status: 'paused' });
  }, [publish]);

  const cancel = useCallback(() => {
    pausedRef.current = true;
    runIdRef.current++;
    abortRef.current?.abort();
    publish(null);
    setIsTranscribing(false);
    setError('');
    setStatusText('');
    setProgress(0);
  }, [publish]);

  const clearError = useCallback(() => setError(''), []);

  return { session, isTranscribing, progress, statusText, error, start, resume, retryChunk, pause, cancel, clearError };
}
