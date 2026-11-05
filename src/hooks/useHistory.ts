import { useCallback, useEffect, useRef, useState } from 'react';
import { QualityFlag, Segment } from '../shared/transcript';
import { SpeakerNames, parseLegacyMarkdown, segmentsToMarkdown } from '../utils/transcript';

export interface HistoryItem {
  id: string;
  title: string;
  date: string;
  /** Plain-text mirror of the transcript, used for sidebar search. */
  content: string;
  segments: Segment[];
  speakerNames: SpeakerNames;
  flags: QualityFlag[];
  model?: string;
  tag?: string;
  isArchived?: boolean;
  isPartial?: boolean;
  completedParts?: number;
  totalParts?: number;
  durationSec?: number;
  /** True for transcripts saved by the old version; timestamps are only per part. */
  legacy?: boolean;
  /** @deprecated The old app stored a fabricated score here. It is ignored. */
  confidenceScore?: number;
}

const STORAGE_KEY = 'transcriptionHistory';

function hydrate(raw: any): HistoryItem {
  const segments: Segment[] = Array.isArray(raw.segments)
    ? raw.segments
    : raw.content
      ? parseLegacyMarkdown(String(raw.content))
      : [];
  const { confidenceScore: _drop, ...rest } = raw;
  return {
    ...rest,
    content: String(raw.content ?? ''),
    segments,
    speakerNames: raw.speakerNames ?? {},
    flags: raw.flags ?? [],
    legacy: Array.isArray(raw.segments) ? raw.legacy : segments.length > 0,
  } as HistoryItem;
}

function load(): HistoryItem[] {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    const parsed = saved ? JSON.parse(saved) : [];
    return Array.isArray(parsed) ? parsed.map(hydrate) : [];
  } catch (err) {
    console.error('Could not read saved transcripts:', err);
    return [];
  }
}

export function useHistory() {
  const [history, setHistory] = useState<HistoryItem[]>(load);
  const [storageError, setStorageError] = useState('');
  const latest = useRef(history);
  latest.current = history;

  const persist = useCallback(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(latest.current));
      setStorageError((prev) => (prev ? '' : prev));
    } catch (err) {
      console.error('Could not save transcripts:', err);
      setStorageError('Browser storage is full, so recent changes are not being saved. Export or delete old transcripts.');
    }
  }, []);

  // Debounced so typing edits do not serialise the whole library on every keystroke.
  useEffect(() => {
    const t = setTimeout(persist, 400);
    return () => clearTimeout(t);
  }, [history, persist]);

  useEffect(() => {
    const flush = () => persist();
    window.addEventListener('pagehide', flush);
    return () => window.removeEventListener('pagehide', flush);
  }, [persist]);

  const addItem = useCallback((item: HistoryItem) => setHistory((prev) => [item, ...prev]), []);

  /** Applies `fn` to one item and keeps the searchable `content` mirror in sync. */
  const updateItem = useCallback((id: string, fn: (item: HistoryItem) => HistoryItem) => {
    setHistory((prev) =>
      prev.map((item) => {
        if (item.id !== id) return item;
        const next = fn(item);
        if (next.segments !== item.segments || next.speakerNames !== item.speakerNames) {
          return { ...next, content: segmentsToMarkdown(next.segments, next.speakerNames) };
        }
        return next;
      })
    );
  }, []);

  const removeItem = useCallback((id: string) => setHistory((prev) => prev.filter((i) => i.id !== id)), []);

  return { history, setHistory, addItem, updateItem, removeItem, storageError };
}
