import {
  RawSegment,
  Segment,
  formatTimestamp,
  normalizeSpeaker,
  parseTimestamp,
} from '../shared/transcript';

export type SpeakerNames = Record<string, string>;

export function newId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function withIds(raw: RawSegment[]): Segment[] {
  return raw.map((s) => ({ ...s, id: newId() }));
}

/** The name to show for a speaker id (custom name if one was set). */
export function speakerLabel(id: string, names: SpeakerNames): string {
  return names[id]?.trim() || id;
}

/** Speaker ids in order of first appearance. */
export function uniqueSpeakers(segments: Array<{ speaker: string }>): string[] {
  const seen: string[] = [];
  for (const s of segments) if (!seen.includes(s.speaker)) seen.push(s.speaker);
  return seen;
}

export function segmentsToMarkdown(
  segments: Segment[],
  names: SpeakerNames,
  opts: { timestamps?: boolean } = {}
): string {
  return segments
    .map((s) => {
      const ts = opts.timestamps ? ` [${formatTimestamp(s.start)}]` : '';
      return `**${speakerLabel(s.speaker, names)}:**${ts} ${s.text}`;
    })
    .join('\n\n');
}

// ---------------------------------------------------------------------------
// Legacy format (markdown with "### [00:00 - 05:00]" headers and **Speaker N:** tags)
// ---------------------------------------------------------------------------

const LEGACY_HEADER = /^#{1,6}\s*\[\s*([\d:]+)\s*-\s*([\d:]+)\s*\]\s*$/;
const LEGACY_TURN = /^\*\*([^*\n]+?):?\*\*:?\s*([\s\S]*)$/;

/**
 * Converts a transcript saved by the old version into segments so it can be
 * renamed, edited and exported like a new one. Timestamps are only known per part,
 * so every turn in a part gets that part's start time.
 */
export function parseLegacyMarkdown(markdown: string): Segment[] {
  const out: Segment[] = [];
  let partStart = 0;

  for (const block of markdown.split(/\n\s*\n/)) {
    const text = block.trim();
    if (!text) continue;

    const header = text.match(LEGACY_HEADER);
    if (header) {
      partStart = parseTimestamp(header[1]) ?? partStart;
      continue;
    }

    const turn = text.match(LEGACY_TURN);
    if (turn) {
      const body = turn[2].replace(/\s*\n\s*/g, ' ').trim();
      if (body) out.push({ id: newId(), speaker: normalizeSpeaker(turn[1]), start: partStart, text: body });
    } else {
      const body = text.replace(/\s*\n\s*/g, ' ');
      const prev = out[out.length - 1];
      if (prev && prev.start === partStart) prev.text += ' ' + body;
      else out.push({ id: newId(), speaker: prev?.speaker ?? 'Speaker 1', start: partStart, text: body });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Clean-up: deterministic, no AI involved, so no words can be silently lost
// ---------------------------------------------------------------------------

const FILLER = /\b(?:uh+|um+|uhm+|erm|er|euh+)\b[,.]?\s*/gi;
const REPEATABLE =
  'i|we|you|they|he|she|it|the|a|an|to|and|but|so|is|in|of|my|our|your|this';
const WORD_STUTTER = new RegExp(`\\b(${REPEATABLE})(?:\\s+\\1)+\\b`, 'gi');
const HYPHEN_STUTTER = /\b([A-Za-z]{1,6})-\s+\1\b/gi;

export function cleanText(text: string): string {
  let t = text.replace(FILLER, '');
  t = t.replace(HYPHEN_STUTTER, '$1').replace(WORD_STUTTER, '$1');
  t = t
    .replace(/\s+([.,!?;:])/g, '$1')
    .replace(/,\s*,/g, ',')
    .replace(/^[\s,]+/, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  // Re-capitalise if a leading filler was removed.
  return t.replace(/^(\p{Ll})/u, (c) => c.toUpperCase()).replace(/([.!?]\s+)(\p{Ll})/gu, (_, p, c) => p + c.toUpperCase());
}

export function cleanSegments(segments: Segment[]): { segments: Segment[]; changed: number } {
  let changed = 0;
  const out: Segment[] = [];
  for (const s of segments) {
    const cleaned = cleanText(s.text);
    if (cleaned !== s.text) changed++;
    if (cleaned) out.push({ ...s, text: cleaned });
  }
  return { segments: out, changed };
}

// ---------------------------------------------------------------------------
// Find & replace
// ---------------------------------------------------------------------------

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function findReplace(
  segments: Segment[],
  find: string,
  replace: string,
  opts: { caseSensitive?: boolean } = {}
): { segments: Segment[]; count: number } {
  if (!find) return { segments, count: 0 };
  const re = new RegExp(escapeRegExp(find), opts.caseSensitive ? 'g' : 'gi');
  let count = 0;
  const out = segments.map((s) => {
    const next = s.text.replace(re, () => {
      count++;
      return replace;
    });
    return next === s.text ? s : { ...s, text: next };
  });
  return { segments: out, count };
}

export function countMatches(segments: Segment[], find: string, caseSensitive = false): number {
  if (!find) return 0;
  const re = new RegExp(escapeRegExp(find), caseSensitive ? 'g' : 'gi');
  return segments.reduce((n, s) => n + (s.text.match(re)?.length ?? 0), 0);
}

export function isMostlyRtl(text: string): boolean {
  const letters = text.match(/\p{L}/gu);
  if (!letters || letters.length === 0) return false;
  const rtl = text.match(/[\u0590-\u08FF]/g)?.length ?? 0;
  return rtl / letters.length > 0.5;
}
