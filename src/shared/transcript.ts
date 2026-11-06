/**
 * Shared transcript types and pure helpers.
 * Imported by both the Express server and the React client, so this file
 * must stay free of DOM / Node-only APIs.
 */

/** A single speaker turn as returned by the model (times relative or absolute, in seconds). */
export interface RawSegment {
  speaker: string;
  start: number;
  text: string;
}

/** A speaker turn stored in the app. `speaker` is a stable id such as "Speaker 1". */
export interface Segment extends RawSegment {
  id: string;
  /** Index of the audio part this turn came from (absent for migrated transcripts). */
  chunk?: number;
}

export type FlagCode =
  | 'low_coverage'
  | 'high_rate'
  | 'repetition'
  | 'empty'
  | 'truncated'
  | 'approx_timestamps'
  | 'model_fallback';

export interface QualityFlag {
  chunk: number;
  startSec: number;
  endSec: number;
  code: FlagCode;
  message: string;
}

export interface ChunkInfo {
  index: number;
  total: number;
  startSec: number;
  endSec: number;
}

export type TranscriptionStyle = 'verbatim' | 'clean';
export type LanguageHint = 'auto' | 'en' | 'fr' | 'ar';

export const LANGUAGE_LABELS: Record<LanguageHint, string> = {
  auto: 'Auto-detect',
  en: 'English',
  fr: 'French',
  ar: 'Arabic',
};

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

/**
 * Parses "m:ss", "mm:ss", "h:mm:ss", "ss", "12.5" or a number into seconds.
 * Returns null when the value cannot be interpreted.
 */
export function parseTimestamp(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? value : null;
  }
  if (typeof value !== 'string') return null;

  const cleaned = value.trim().replace(/[\[\]()]/g, '');
  if (!cleaned) return null;

  const parts = cleaned.split(':');
  if (parts.length > 3) return null;

  let total = 0;
  for (const part of parts) {
    if (!/^\d+(\.\d+)?$/.test(part.trim())) return null;
    total = total * 60 + parseFloat(part);
  }
  return Number.isFinite(total) ? total : null;
}

/** Formats seconds as "m:ss", or "h:mm:ss" from one hour up. */
export function formatTimestamp(seconds: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

// ---------------------------------------------------------------------------
// Speakers
// ---------------------------------------------------------------------------

/**
 * Normalises speaker labels so "speaker 1", "SPEAKER_1", "**Speaker1:**" and "S1"
 * all become "Speaker 1". Other labels are only trimmed.
 */
export function normalizeSpeaker(label: unknown): string {
  const raw = typeof label === 'string' ? label : '';
  const cleaned = raw.replace(/\*/g, '').replace(/:\s*$/, '').trim();
  if (!cleaned) return 'Speaker 1';

  const match = cleaned.match(/^(?:speaker|spk|voice|s)[\s_#-]*(\d{1,2})$/i);
  if (match) return `Speaker ${parseInt(match[1], 10)}`;
  return cleaned;
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

export function countWords(text: string): number {
  if (!text) return 0;
  return text.trim().split(/\s+/).filter(Boolean).length;
}

// ---------------------------------------------------------------------------
// Timestamp repair
// ---------------------------------------------------------------------------

/**
 * Models are decent but not perfect at timestamps. This validates them against the
 * clip duration; if they are clearly broken it falls back to spreading turns across
 * the clip proportionally to their text length (flagged as approximate).
 * Input and output are relative to the start of the clip.
 */
export function repairTimestamps(
  raw: Array<{ speaker: string; start: number | null; text: string }>,
  durationSec: number
): { segments: RawSegment[]; approximate: boolean } {
  if (raw.length === 0) return { segments: [], approximate: false };

  const duration = durationSec > 0 ? durationSec : Infinity;
  let violations = 0;
  let prev = 0;
  for (const seg of raw) {
    const s = seg.start;
    if (s === null || s < 0 || s > duration + 5 || s < prev - 0.5) {
      violations++;
    } else {
      prev = s;
    }
  }

  const broken = violations / raw.length > 0.15;
  if (broken && Number.isFinite(duration)) {
    const totalChars = raw.reduce((n, s) => n + Math.max(1, s.text.length), 0);
    let cum = 0;
    const segments = raw.map((seg) => {
      const start = (cum / totalChars) * duration;
      cum += Math.max(1, seg.text.length);
      return { speaker: seg.speaker, start, text: seg.text };
    });
    return { segments, approximate: true };
  }

  let last = 0;
  const segments = raw.map((seg) => {
    let s = seg.start ?? last;
    s = Math.max(0, Math.min(s, Number.isFinite(duration) ? duration : s));
    s = Math.max(s, last);
    last = s;
    return { speaker: seg.speaker, start: s, text: seg.text };
  });
  return { segments, approximate: false };
}

// ---------------------------------------------------------------------------
// Heuristic quality checks (these are NOT an accuracy score)
// ---------------------------------------------------------------------------

const MIN_WPM = 25;
const MAX_WPM = 320;

function hasPhraseLoop(text: string): boolean {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length < 24) return false;
  for (const n of [3, 4, 5]) {
    const counts = new Map<string, number>();
    for (let i = 0; i + n <= words.length; i++) {
      const key = words.slice(i, i + n).join(' ');
      const c = (counts.get(key) ?? 0) + 1;
      if (c >= 6) return true;
      counts.set(key, c);
    }
  }
  return false;
}

/** Flags chunks that look truncated, empty, or stuck in a repetition loop. */
export function runQualityChecks(
  segments: RawSegment[],
  chunk: { index: number; startSec: number; endSec: number }
): QualityFlag[] {
  const flags: QualityFlag[] = [];
  const duration = Math.max(0, chunk.endSec - chunk.startSec);
  const minutes = duration / 60;
  const base = { chunk: chunk.index, startSec: chunk.startSec, endSec: chunk.endSec };

  const words = segments.reduce((n, s) => n + countWords(s.text), 0);

  if (segments.length === 0 || words === 0) {
    if (minutes >= 0.25) {
      flags.push({
        ...base,
        code: 'empty',
        message: 'No speech was transcribed for this part. It may be silent, or the model may have missed it.',
      });
    }
    return flags;
  }

  if (minutes >= 0.5) {
    const wpm = words / minutes;
    if (wpm < MIN_WPM) {
      flags.push({
        ...base,
        code: 'low_coverage',
        message: `Only ~${Math.round(wpm)} words/min were transcribed; some speech may be missing.`,
      });
    } else if (wpm > MAX_WPM) {
      flags.push({
        ...base,
        code: 'high_rate',
        message: `~${Math.round(wpm)} words/min is unusually high; the text may contain invented or repeated content.`,
      });
    }
  }

  let run = 1;
  let looped = false;
  for (let i = 1; i < segments.length; i++) {
    const a = segments[i].text.trim().toLowerCase();
    const b = segments[i - 1].text.trim().toLowerCase();
    run = a.length >= 12 && a === b ? run + 1 : 1;
    if (run >= 3) {
      looped = true;
      break;
    }
  }
  if (!looped) looped = segments.some((s) => hasPhraseLoop(s.text));
  if (looped) {
    flags.push({
      ...base,
      code: 'repetition',
      message: 'Repeated text detected; the model may have got stuck in a loop.',
    });
  }

  return flags;
}
