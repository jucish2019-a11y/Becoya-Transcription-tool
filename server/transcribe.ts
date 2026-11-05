import { Type } from '@google/genai';
import { ALLOWED_MODEL_IDS, temperatureFor } from '../src/shared/models';
import {
  ChunkInfo,
  LanguageHint,
  LANGUAGE_LABELS,
  QualityFlag,
  RawSegment,
  TranscriptionStyle,
  formatTimestamp,
  normalizeSpeaker,
  parseTimestamp,
  repairTimestamps,
  runQualityChecks,
} from '../src/shared/transcript';

export interface TranscribeContext {
  /** Speaker ids identified in earlier parts, in order of first appearance. */
  speakers: string[];
  /** The last few turns of the previous part, for continuity. */
  tail: Array<{ speaker: string; text: string }>;
}

export interface TranscribeRequest {
  base64Audio: string;
  mimeType: string;
  model: string;
  style: TranscriptionStyle;
  language: LanguageHint;
  vocabulary: string;
  expectedSpeakers?: number;
  chunk: ChunkInfo;
  context?: TranscribeContext;
}

export interface TranscribeResponse {
  /** Turns with timestamps in seconds from the start of the full recording. */
  segments: RawSegment[];
  flags: QualityFlag[];
}

export class RequestError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

export interface GenerateParams {
  model: string;
  mimeType: string;
  base64Audio: string;
  systemInstruction: string;
  userText: string;
  temperature?: number;
}

export interface GenerateResult {
  text: string;
  finishReason?: string;
}

export type GenerateFn = (params: GenerateParams) => Promise<GenerateResult>;

const MAX_VOCAB_CHARS = 4000;
const LANGUAGES = new Set<string>(Object.keys(LANGUAGE_LABELS));

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

export function normalizeMimeType(mime: unknown): string {
  const base = typeof mime === 'string' ? mime.split(';')[0].trim().toLowerCase() : '';
  if (base === 'audio/x-wav' || base === 'audio/wave') return 'audio/wav';
  if (base === 'audio/mp3') return 'audio/mpeg';
  return base;
}

export function validateRequest(body: any): TranscribeRequest {
  if (!body || typeof body !== 'object') throw new RequestError('Invalid request body.');

  const { base64Audio, model, style, language, vocabulary, expectedSpeakers, chunk, context } = body;

  if (typeof base64Audio !== 'string' || base64Audio.length < 16) {
    throw new RequestError('Missing audio data.');
  }
  const mimeType = normalizeMimeType(body.mimeType);
  if (!mimeType.startsWith('audio/') && mimeType !== 'video/webm' && mimeType !== 'video/mp4') {
    throw new RequestError(`Unsupported audio type: ${mimeType || 'unknown'}.`);
  }
  if (typeof model !== 'string' || !ALLOWED_MODEL_IDS.has(model)) {
    throw new RequestError(`Unknown model: ${String(model)}.`);
  }

  const c = chunk ?? {};
  const info: ChunkInfo = {
    index: Number.isInteger(c.index) ? c.index : 0,
    total: Number.isInteger(c.total) && c.total > 0 ? c.total : 1,
    startSec: Number.isFinite(c.startSec) ? Math.max(0, c.startSec) : 0,
    endSec: Number.isFinite(c.endSec) ? Math.max(0, c.endSec) : 0,
  };

  let ctx: TranscribeContext | undefined;
  if (context && Array.isArray(context.speakers)) {
    ctx = {
      speakers: context.speakers.filter((s: unknown) => typeof s === 'string').slice(0, 20),
      tail: Array.isArray(context.tail)
        ? context.tail
            .filter((t: any) => t && typeof t.speaker === 'string' && typeof t.text === 'string')
            .slice(-4)
            .map((t: any) => ({ speaker: t.speaker, text: String(t.text).slice(0, 300) }))
        : [],
    };
  }

  const expected = Number.isInteger(expectedSpeakers) && expectedSpeakers >= 1 && expectedSpeakers <= 12
    ? expectedSpeakers
    : undefined;

  return {
    base64Audio,
    mimeType,
    model,
    style: style === 'clean' ? 'clean' : 'verbatim',
    language: LANGUAGES.has(language) ? language : 'auto',
    vocabulary: typeof vocabulary === 'string' ? vocabulary.slice(0, MAX_VOCAB_CHARS) : '',
    expectedSpeakers: expected,
    chunk: info,
    context: ctx,
  };
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

export function buildPrompt(req: TranscribeRequest): { systemInstruction: string; userText: string } {
  const verbatimRule =
    req.style === 'clean'
      ? 'Style: CLEAN. Omit filler sounds ("um", "uh", "er", "euh") and mindless "like"/"you know", and drop stutters and false starts, but keep every substantive word, sentence and turn.'
      : 'Style: VERBATIM. Keep everything that is said, including fillers, repetitions and false starts.';

  const systemInstruction = [
    'You are a professional transcriptionist producing an accurate, speaker-labelled transcript of an audio clip.',
    '',
    'Rules:',
    '1. Transcribe exactly what is said, in the language it is spoken. NEVER translate. If speakers switch language, keep each part in the language spoken.',
    '2. Label speakers "Speaker 1", "Speaker 2", and so on, by distinct voice. Do NOT use names or roles (such as Moderator) as labels, even if people introduce themselves. The same voice must always get the same label.',
    '3. Start a new turn whenever the speaker changes. Never put words from two speakers in one turn. Split a long monologue into turns at natural sentence breaks roughly every 30-60 seconds.',
    '4. Never invent, summarise, or paraphrase. Do not output text for silence, music or background noise. Use [inaudible] for words you cannot make out.',
    '5. Every turn has a "start" timestamp: the time the turn begins WITHIN THIS CLIP, where the clip itself starts at 00:00. Format MM:SS.',
    '6. Capitalise and punctuate normally. Do not add commentary, headings or notes.',
    verbatimRule,
  ].join('\n');

  const lines: string[] = ['Transcribe this audio clip.'];

  if (req.language !== 'auto') {
    lines.push(`The main language spoken is ${LANGUAGE_LABELS[req.language]}.`);
  }
  if (req.expectedSpeakers) {
    lines.push(`There are about ${req.expectedSpeakers} speaker(s) in the full recording.`);
  }
  const vocab = req.vocabulary.trim();
  if (vocab) {
    lines.push(`Spell these names, acronyms and terms exactly as written when you hear them:\n${vocab}`);
  }

  if (req.chunk.total > 1) {
    lines.push(
      `This clip is part ${req.chunk.index + 1} of ${req.chunk.total} of a longer recording, starting at ${formatTimestamp(req.chunk.startSec)} in the full recording. It may begin in the middle of a sentence.`
    );
  }
  if (req.context && req.context.speakers.length > 0) {
    lines.push(
      `Speakers identified so far: ${req.context.speakers.join(', ')}. Keep using these exact labels for the same voices. Only create a new label if you clearly hear a voice that is none of them.`
    );
    if (req.context.tail.length > 0) {
      const tail = req.context.tail.map((t) => `[${t.speaker}] ${t.text}`).join('\n');
      lines.push(`The previous part ended with the following (do NOT repeat it):\n${tail}`);
    }
  }

  return { systemInstruction, userText: lines.join('\n\n') };
}

export const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    segments: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          speaker: { type: Type.STRING, description: 'Speaker label, e.g. "Speaker 1".' },
          start: { type: Type.STRING, description: 'Start time within this clip, MM:SS.' },
          text: { type: Type.STRING, description: 'What the speaker said.' },
        },
        required: ['speaker', 'start', 'text'],
      },
    },
  },
  required: ['segments'],
};

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

export class ParseError extends Error {}

/** Parses the model's JSON, tolerating code fences and a bare array. */
export function parseModelJson(text: string): Array<{ speaker: string; start: number | null; text: string }> {
  let body = (text || '').trim();
  const fence = body.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) body = fence[1];

  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    throw new ParseError('Model returned invalid JSON.');
  }

  const list = Array.isArray(data) ? data : (data as any)?.segments;
  if (!Array.isArray(list)) throw new ParseError('Model response had no segments.');

  const out: Array<{ speaker: string; start: number | null; text: string }> = [];
  for (const item of list) {
    if (!item || typeof item.text !== 'string') continue;
    const text = item.text.trim();
    if (!text) continue;
    out.push({
      speaker: normalizeSpeaker(item.speaker),
      start: parseTimestamp(item.start),
      text,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Retry
// ---------------------------------------------------------------------------

function errorStatus(err: any): number | undefined {
  const s = err?.status ?? err?.code ?? err?.error?.code;
  return typeof s === 'number' ? s : undefined;
}

export function isRetryable(err: unknown): boolean {
  if (err instanceof RequestError) return false;
  const status = errorStatus(err);
  if (status && [408, 429, 500, 502, 503, 504].includes(status)) return true;
  const msg = String((err as any)?.message ?? err).toLowerCase();
  return /overloaded|unavailable|resource_exhausted|timed? ?out|fetch failed|econnreset|socket hang up/.test(msg);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { retries?: number; baseMs?: number; sleepFn?: (ms: number) => Promise<void> } = {}
): Promise<T> {
  const retries = opts.retries ?? 3;
  const baseMs = opts.baseMs ?? 1500;
  const wait = opts.sleepFn ?? sleep;
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || !isRetryable(err)) throw err;
      const delay = baseMs * 2 ** attempt + Math.random() * 400;
      attempt++;
      await wait(delay);
    }
  }
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export async function transcribeChunk(
  generate: GenerateFn,
  req: TranscribeRequest,
  retryOpts?: Parameters<typeof withRetry>[1]
): Promise<TranscribeResponse> {
  const { systemInstruction, userText } = buildPrompt(req);
  const params: GenerateParams = {
    model: req.model,
    mimeType: req.mimeType,
    base64Audio: req.base64Audio,
    systemInstruction,
    userText,
    temperature: temperatureFor(req.model),
  };

  // Up to two attempts for malformed/truncated output; transport errors have their own retry.
  let parsed: ReturnType<typeof parseModelJson> | null = null;
  let truncated = false;
  let lastError: unknown;
  for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
    const result = await withRetry(() => generate(params), retryOpts);
    try {
      parsed = parseModelJson(result.text);
      truncated = result.finishReason === 'MAX_TOKENS';
    } catch (err) {
      lastError = err;
    }
  }
  if (!parsed) throw lastError instanceof Error ? lastError : new ParseError('Could not parse model output.');

  const duration = req.chunk.endSec > req.chunk.startSec ? req.chunk.endSec - req.chunk.startSec : 0;
  const repaired = repairTimestamps(parsed, duration);

  const segments: RawSegment[] = repaired.segments.map((s) => ({
    speaker: s.speaker,
    start: req.chunk.startSec + s.start,
    text: s.text,
  }));

  const checkInfo = { index: req.chunk.index, startSec: req.chunk.startSec, endSec: req.chunk.endSec };
  const flagBase = { chunk: req.chunk.index, startSec: req.chunk.startSec, endSec: req.chunk.endSec };
  const flags = runQualityChecks(segments, checkInfo);
  if (truncated) {
    flags.push({
      ...flagBase,
      code: 'truncated',
      message: 'The model ran out of output space; the end of this part may be cut off. Retry the part.',
    });
  }
  if (repaired.approximate) {
    flags.push({
      ...flagBase,
      code: 'approx_timestamps',
      message: 'Timestamps for this part were unreliable and are approximate.',
    });
  }

  return { segments, flags };
}
