import {
  AlertTriangle,
  ArrowLeftRight,
  AudioLines,
  Check,
  Copy,
  FileAudio,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  Replace,
  Sparkles,
  Tag,
  Undo2,
  Users,
  Wand2,
} from 'lucide-react';
import { useCallback, useMemo, useRef, useState } from 'react';
import { HistoryItem } from '../hooks/useHistory';
import { Session } from '../hooks/useTranscriber';
import { modelLabel } from '../shared/models';
import { Segment, formatTimestamp } from '../shared/transcript';
import { ExportDoc } from '../utils/export';
import {
  SpeakerNames,
  cleanSegments,
  countMatches,
  findReplace,
  speakerLabel,
  uniqueSpeakers,
} from '../utils/transcript';
import { ExportMenu } from './ExportMenu';
import { Popover } from './Popover';
import { SegmentRow } from './SegmentRow';

interface Props {
  item: HistoryItem | null;
  session: Session | null;
  isTranscribing: boolean;
  audioUrl: string | null;
  onTitle: (title: string) => void;
  onTag: (tag: string) => void;
  onSegments: (fn: (segments: Segment[]) => Segment[]) => void;
  onSpeakerNames: (fn: (names: SpeakerNames) => SpeakerNames) => void;
  onResume: () => void;
  onRetryChunk: (index: number) => void;
}

const subtleButton =
  'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-zinc-700 hover:bg-zinc-100 hover:text-zinc-900 transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:outline-none';

export function TranscriptPanel({
  item,
  session,
  isTranscribing,
  audioUrl,
  onTitle,
  onTag,
  onSegments,
  onSpeakerNames,
  onResume,
  onRetryChunk,
}: Props) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [isCopied, setIsCopied] = useState(false);
  const [notice, setNotice] = useState<{ text: string; undo?: Segment[] } | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const [find, setFind] = useState('');
  const [replace, setReplace] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);

  const segments = item?.segments ?? [];
  const names = item?.speakerNames ?? {};
  const speakers = useMemo(() => uniqueSpeakers(segments), [segments]);
  const colorIndex = useMemo(() => new Map(speakers.map((s, i) => [s, i])), [speakers]);

  const showNotice = useCallback((text: string, undo?: Segment[]) => {
    setNotice({ text, undo });
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 15000);
  }, []);

  const activeId = useMemo(() => {
    if (!audioUrl) return null;
    let active: string | null = null;
    for (const s of segments) {
      if (s.start <= currentTime + 0.05) active = s.id;
      else break;
    }
    return active;
  }, [segments, currentTime, audioUrl]);

  const seek = useCallback((t: number) => {
    const el = audioRef.current;
    if (!el) return;
    el.currentTime = t;
    void el.play().catch(() => undefined);
  }, []);

  const editText = useCallback(
    (id: string, text: string) => onSegments((segs) => segs.map((s) => (s.id === id ? { ...s, text } : s))),
    [onSegments]
  );
  const setSpeaker = useCallback(
    (id: string, speaker: string) =>
      onSegments((segs) => segs.map((s) => (s.id === id ? { ...s, speaker } : s))),
    [onSegments]
  );

  const [isFixingSpeakers, setIsFixingSpeakers] = useState(false);

  const doSwapSpeakers = useCallback(
    (spA: string, spB: string) => {
      if (!spA || !spB || spA === spB) return;
      const snapshot = segments;
      onSegments((segs) =>
        segs.map((s) => {
          if (s.speaker === spA) return { ...s, speaker: spB };
          if (s.speaker === spB) return { ...s, speaker: spA };
          return s;
        })
      );
      onSpeakerNames((prev) => {
        const next = { ...prev };
        const nameA = next[spA];
        const nameB = next[spB];
        if (nameA !== undefined) next[spB] = nameA;
        else delete next[spB];
        if (nameB !== undefined) next[spA] = nameB;
        else delete next[spA];
        return next;
      });
      showNotice(`Swapped ${speakerLabel(spA, names)} ⇄ ${speakerLabel(spB, names)}.`, snapshot);
    },
    [segments, onSegments, onSpeakerNames, names, showNotice]
  );

  const doUntangleSpeakers = useCallback(async () => {
    if (!segments.length || isFixingSpeakers) return;
    setIsFixingSpeakers(true);
    try {
      const res = await fetch('/api/fix-speakers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          segments: segments.map((s) => ({ id: s.id, speaker: s.speaker, text: s.text, start: s.start })),
          expectedSpeakers: speakers.length,
          speakerNames: names,
        }),
      });
      if (!res.ok) throw new Error('Failed to untangle speakers.');
      const data = await res.json();
      const corrections: Array<{ id: string; speaker: string }> = data.corrections || [];
      if (!corrections.length) {
        showNotice('No speaker changes needed; dialogue is aligned.');
        return;
      }
      const corrMap = new Map(corrections.map((c) => [c.id, c.speaker]));
      let changed = 0;
      const snapshot = segments;
      onSegments((segs) =>
        segs.map((s) => {
          const corrected = corrMap.get(s.id);
          if (corrected && corrected !== s.speaker) {
            changed++;
            return { ...s, speaker: corrected };
          }
          return s;
        })
      );
      showNotice(
        changed > 0 ? `Untangled speakers: corrected ${changed} turn(s).` : 'Speakers are already consistently aligned.',
        snapshot
      );
    } catch (err: any) {
      showNotice(err?.message || 'Could not untangle speakers.');
    } finally {
      setIsFixingSpeakers(false);
    }
  }, [segments, isFixingSpeakers, speakers.length, names, onSegments, showNotice]);

  const doReplace = (close: () => void) => {
    const snapshot = segments;
    const r = findReplace(segments, find, replace, { caseSensitive });
    if (r.count === 0) return;
    onSegments(() => r.segments);
    showNotice(`Replaced ${r.count} occurrence${r.count === 1 ? '' : 's'}.`, snapshot);
    close();
  };

  const doCleanUp = () => {
    const snapshot = segments;
    const r = cleanSegments(segments);
    if (r.changed === 0) return showNotice('Nothing to clean up: no fillers or stutters found.');
    onSegments(() => r.segments);
    showNotice(`Cleaned ${r.changed} turn${r.changed === 1 ? '' : 's'}.`, snapshot);
  };

  if (!item) {
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center text-zinc-500 p-6 text-center">
        <div className="w-16 h-16 mb-4 rounded-full bg-zinc-100 flex items-center justify-center border border-zinc-200">
          <AudioLines className="w-6 h-6 text-zinc-400" aria-hidden="true" />
        </div>
        <p className="text-sm font-medium text-zinc-700">No transcription yet</p>
        <p className="text-xs mt-1 max-w-[250px] text-zinc-600">
          Record audio or upload a file to see the transcription appear here.
        </p>
      </div>
    );
  }

  const hasText = segments.length > 0;
  const approx =
    !!item.legacy || item.flags.some((f) => f.code === 'approx_timestamps');
  const doc: ExportDoc = {
    title: item.title || 'Transcript',
    date: item.date,
    model: modelLabel(item.model) || undefined,
    segments,
    speakerNames: names,
  };

  const matchCount = countMatches(segments, find, caseSensitive);

  const copyAll = async () => {
    const text = segments.map((s) => `${speakerLabel(s.speaker, names)}: ${s.text}`).join('\n\n');
    try {
      await navigator.clipboard.writeText(text);
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy text:', err);
    }
  };

  const flagsByChunk = new Map<number, typeof item.flags>();
  for (const f of item.flags) flagsByChunk.set(f.chunk, [...(flagsByChunk.get(f.chunk) ?? []), f]);
  const warnFlags = item.flags.filter((f) => f.code !== 'approx_timestamps');
  const canRetry = !!session && session.historyId === item.id && !isTranscribing;
  const paused = session && session.historyId === item.id && (session.status === 'paused' || session.status === 'failed');

  return (
    <>
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-6 py-3 border-b border-zinc-100 bg-zinc-50/50">
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          <FileAudio className="w-4 h-4 text-zinc-500 shrink-0" aria-hidden="true" />
          <input
            type="text"
            value={item.title}
            onChange={(e) => onTitle(e.target.value)}
            className="text-sm font-medium text-zinc-900 bg-transparent border border-transparent hover:border-zinc-200 focus:bg-white focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 rounded px-2 py-0.5 w-48 sm:w-64 transition-all"
            placeholder="Transcription Title"
            aria-label="Transcription Title"
          />
          {item.isPartial && (
            <span className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-semibold bg-amber-100 text-amber-900 border border-amber-200">
              <Pause className="w-3 h-3 fill-current text-amber-700" />
              Partial ({item.completedParts || 0}/{item.totalParts || 1})
            </span>
          )}
          {item.model && (
            <span className="px-2 py-1 rounded-md text-xs font-medium bg-zinc-100 text-zinc-700 border border-zinc-200" title="Model used">
              {modelLabel(item.model)}
            </span>
          )}
          <label className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium bg-zinc-100 text-zinc-700 border border-zinc-200 focus-within:ring-2 focus-within:ring-indigo-500">
            <Tag className="w-3 h-3" aria-hidden="true" />
            <input
              type="text"
              value={item.tag || ''}
              onChange={(e) => onTag(e.target.value)}
              placeholder="Add tag"
              aria-label="Tag"
              className="bg-transparent w-20 focus:outline-none placeholder:text-zinc-500"
            />
          </label>
        </div>

        {hasText && (
          <div className="flex flex-wrap items-center gap-1">
            <Popover
              ariaLabel="Rename speakers"
              title="Speakers & Alignment"
              label={
                <>
                  <Users className="h-3.5 w-3.5" aria-hidden="true" />
                  Speakers
                </>
              }
            >
              {() => (
                <div className="space-y-3 w-72">
                  <div>
                    <div className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider mb-1">
                      Speaker Names
                    </div>
                    <p className="text-xs text-zinc-600 leading-snug mb-2">
                      Give each speaker a name. It updates the whole transcript and every export.
                    </p>
                    <div className="space-y-1.5">
                      {speakers.map((sp) => {
                        const turns = segments.filter((s) => s.speaker === sp).length;
                        return (
                          <div key={sp} className="flex items-center gap-2">
                            <span className="w-24 shrink-0 text-[11px] text-zinc-500 truncate" title={sp}>
                              {sp} · {turns}
                            </span>
                            <input
                              type="text"
                              defaultValue={names[sp] ?? ''}
                              placeholder="Name or role"
                              aria-label={`Name for ${sp}`}
                              onBlur={(e) => {
                                const v = e.target.value.trim();
                                if ((names[sp] ?? '') !== v) {
                                  onSpeakerNames((prev) => {
                                    const next = { ...prev };
                                    if (v) next[sp] = v;
                                    else delete next[sp];
                                    return next;
                                  });
                                }
                              }}
                              className="flex-1 min-w-0 text-xs p-1.5 border border-zinc-200 rounded focus:outline-none focus:ring-2 focus:ring-indigo-500"
                            />
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {speakers.length >= 2 && (
                    <div className="pt-2 border-t border-zinc-100">
                      <div className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider mb-1.5">
                        Swap Inverted Speakers
                      </div>
                      <p className="text-[11px] text-zinc-500 mb-2 leading-tight">
                        If two speakers got mixed up or swapped, switch all their turns with one click:
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        {speakers.length === 2 ? (
                          <button
                            type="button"
                            onClick={() => doSwapSpeakers(speakers[0], speakers[1])}
                            className="w-full inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-md bg-indigo-50 text-indigo-700 hover:bg-indigo-100 border border-indigo-200 transition-colors"
                          >
                            <ArrowLeftRight className="w-3.5 h-3.5" />
                            Swap {speakerLabel(speakers[0], names)} ⇄ {speakerLabel(speakers[1], names)}
                          </button>
                        ) : (
                          speakers.map((spA, i) =>
                            speakers.slice(i + 1).map((spB) => (
                              <button
                                key={`${spA}-${spB}`}
                                type="button"
                                onClick={() => doSwapSpeakers(spA, spB)}
                                className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium rounded bg-zinc-100 hover:bg-indigo-50 hover:text-indigo-700 border border-zinc-200 transition-colors"
                              >
                                <ArrowLeftRight className="w-3 h-3" />
                                {speakerLabel(spA, names)} ⇄ {speakerLabel(spB, names)}
                              </button>
                            ))
                          )
                        )}
                      </div>
                    </div>
                  )}

                  <div className="pt-2 border-t border-zinc-100">
                    <button
                      type="button"
                      disabled={isFixingSpeakers}
                      onClick={doUntangleSpeakers}
                      className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-indigo-50 text-indigo-700 hover:bg-indigo-100 border border-indigo-200 disabled:opacity-50 transition-colors"
                    >
                      {isFixingSpeakers ? (
                        <>
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          Untangling speaker turns...
                        </>
                      ) : (
                        <>
                          <Sparkles className="w-3.5 h-3.5 text-indigo-600" />
                          Fix Speaker Mix-Up with AI
                        </>
                      )}
                    </button>
                  </div>
                </div>
              )}
            </Popover>

            <Popover
              ariaLabel="Find and replace"
              title="Find and replace"
              label={
                <>
                  <Replace className="h-3.5 w-3.5" aria-hidden="true" />
                  Replace
                </>
              }
            >
              {(close) => (
                <div className="space-y-2">
                  <input
                    type="text"
                    value={find}
                    onChange={(e) => setFind(e.target.value)}
                    placeholder="Find"
                    aria-label="Find"
                    className="w-full text-xs p-1.5 border border-zinc-200 rounded focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                  <input
                    type="text"
                    value={replace}
                    onChange={(e) => setReplace(e.target.value)}
                    placeholder="Replace with"
                    aria-label="Replace with"
                    className="w-full text-xs p-1.5 border border-zinc-200 rounded focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                  <label className="flex items-center gap-2 text-xs text-zinc-700 cursor-pointer">
                    <input type="checkbox" checked={caseSensitive} onChange={(e) => setCaseSensitive(e.target.checked)} />
                    Match case
                  </label>
                  <div className="flex items-center justify-between pt-1">
                    <span className="text-[11px] text-zinc-500">
                      {find ? `${matchCount} match${matchCount === 1 ? '' : 'es'}` : 'Fix a recurring misspelling'}
                    </span>
                    <button
                      type="button"
                      onClick={() => doReplace(close)}
                      disabled={matchCount === 0}
                      className="px-2.5 py-1 rounded-md bg-zinc-900 text-white text-xs font-medium disabled:opacity-40"
                    >
                      Replace all
                    </button>
                  </div>
                </div>
              )}
            </Popover>

            <button
              type="button"
              onClick={doCleanUp}
              disabled={isTranscribing}
              className={subtleButton}
              title="Remove fillers (um, uh, euh) and stutters. Only these words are removed, nothing is rewritten."
              aria-label="Clean up fillers and stutters"
            >
              <Wand2 className="h-3.5 w-3.5" aria-hidden="true" />
              Clean up
            </button>

            {speakers.length >= 2 && (
              <button
                type="button"
                onClick={doUntangleSpeakers}
                disabled={isTranscribing || isFixingSpeakers}
                className={subtleButton}
                title="AI analyzes conversation flow and automatically aligns swapped or misattributed speaker turns"
                aria-label="Fix speakers"
              >
                {isFixingSpeakers ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-indigo-600" aria-hidden="true" />
                ) : (
                  <Sparkles className="h-3.5 w-3.5 text-indigo-600" aria-hidden="true" />
                )}
                {isFixingSpeakers ? 'Fixing…' : 'Fix speakers'}
              </button>
            )}

            <button type="button" onClick={copyAll} className={subtleButton} aria-label={isCopied ? 'Copied to clipboard' : 'Copy to clipboard'}>
              {isCopied ? <Check className="h-3.5 w-3.5 text-emerald-600" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
              {isCopied ? 'Copied' : 'Copy'}
            </button>

            <ExportMenu doc={doc} approxTimestamps={approx} />
          </div>
        )}
      </div>

      {/* Banners */}
      {paused && session && session.nextChunkIndex < session.chunks.length && (
        <div className="bg-amber-50/90 border-b border-amber-200/90 px-6 py-2.5 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 text-xs text-amber-900">
            <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
            <span>
              <span className="font-semibold">{session.status === 'paused' ? 'Paused' : 'Stopped'}:</span> showing parts 1 to{' '}
              {session.nextChunkIndex} of {session.chunks.length}.
            </span>
          </div>
          <button
            type="button"
            onClick={onResume}
            disabled={isTranscribing}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-zinc-900 hover:bg-zinc-800 text-white rounded-lg text-xs font-medium shrink-0"
          >
            <Play className="w-3 h-3 fill-current" />
            Continue from where it stopped
          </button>
        </div>
      )}

      {notice && (
        <div className="bg-emerald-50 border-b border-emerald-200 px-6 py-2 flex items-center justify-between gap-3 text-xs text-emerald-900" role="status">
          <span>{notice.text}</span>
          {notice.undo && (
            <button
              type="button"
              onClick={() => {
                const snap = notice.undo!;
                onSegments(() => snap);
                setNotice(null);
              }}
              className="inline-flex items-center gap-1 font-semibold underline underline-offset-2"
            >
              <Undo2 className="w-3 h-3" /> Undo
            </button>
          )}
        </div>
      )}

      {item.legacy && hasText && (
        <div className="bg-zinc-50 border-b border-zinc-200 px-6 py-2 text-xs text-zinc-600">
          Saved by an earlier version: speakers can be renamed and exported, but timestamps are only known per part (marked ~).
        </div>
      )}

      {warnFlags.length > 0 && (
        <details className="border-b border-amber-200 bg-amber-50/70 px-6 py-2 text-xs text-amber-950">
          <summary className="cursor-pointer font-semibold flex items-center gap-2 select-none">
            <AlertTriangle className="w-3.5 h-3.5 text-amber-600" />
            Automatic checks flagged {new Set(warnFlags.map((f) => f.chunk)).size} part(s) worth reviewing
          </summary>
          <p className="mt-1.5 text-[11px] text-amber-900/80">
            These are simple heuristics (words per minute, repetition), not an accuracy score.
          </p>
          <ul className="mt-2 space-y-1.5">
            {warnFlags.map((f, i) => (
              <li key={`${f.chunk}-${f.code}-${i}`} className="flex items-start justify-between gap-3">
                <span>
                  <span className="font-mono text-[11px] bg-white/80 px-1.5 py-0.5 rounded mr-1.5">
                    {formatTimestamp(f.startSec)}–{formatTimestamp(f.endSec)}
                  </span>
                  {f.message}
                </span>
                {canRetry && (
                  <button
                    type="button"
                    onClick={() => onRetryChunk(f.chunk)}
                    className="shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded-md bg-white border border-amber-300 text-amber-900 font-medium hover:bg-amber-100"
                  >
                    <RefreshCw className="w-3 h-3" /> Retry part
                  </button>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}

      {audioUrl && hasText && (
        <div className="px-6 py-2 border-b border-zinc-100 bg-white">
          <audio
            ref={audioRef}
            src={audioUrl}
            controls
            preload="metadata"
            onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
            className="w-full h-9"
          />
        </div>
      )}

      {/* Turns */}
      <div className="flex-1 p-3 sm:p-4 overflow-y-auto relative" aria-label="Transcription text">
        {hasText ? (
          <div className="space-y-0.5">
            {segments.map((seg) => (
              <SegmentRow
                key={seg.id}
                seg={seg}
                speakers={speakers}
                names={names}
                colorIndex={colorIndex.get(seg.speaker) ?? 0}
                isActive={activeId === seg.id}
                canSeek={!!audioUrl}
                approxTime={!!item.legacy}
                onSeek={seek}
                onEditText={editText}
                onSetSpeaker={setSpeaker}
              />
            ))}
          </div>
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-zinc-500">
            {isTranscribing ? 'Transcribing… text will appear here as each part finishes.' : 'This transcript is empty.'}
          </div>
        )}
      </div>
    </>
  );
}
