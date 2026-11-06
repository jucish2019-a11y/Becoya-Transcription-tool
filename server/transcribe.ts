import { Type } from '@google/genai';
import { ALLOWED_MODEL_IDS, UNSUPPORTED_MODELS, modelLabel, temperatureFor } from '../src/shared/models';
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
  /** Acoustic voice profiles of identified speakers so far (gender, pitch, timbre). */
  speakerProfiles?: Record<string, string>;
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
  /** The model that produced this part (can differ from the one requested after a failover). */
  modelUsed?: string;
  speakerProfiles?: Record<string, string>;
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
  /** The model that actually produced the text (differs from the request after a failover). */
  modelUsed?: string;
  /** Set when the requested model was swapped for a faster one. */
  fallbackFrom?: string;
  fallbackReason?: string;
}

/** The upstream model did not answer in time and the request was cancelled. */
export class UpstreamTimeoutError extends Error {
  constructor(public model: string, public timeoutMs: number) {
    super(`${model} did not answer within ${Math.round(timeoutMs / 1000)}s`);
    this.name = 'UpstreamTimeoutError';
  }
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
  if (typeof model === 'string' && UNSUPPORTED_MODELS[model]) {
    throw new RequestError(UNSUPPORTED_MODELS[model]);
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
    const profiles: Record<string, string> = {};
    if (context.speakerProfiles && typeof context.speakerProfiles === 'object' && !Array.isArray(context.speakerProfiles)) {
      for (const [k, v] of Object.entries(context.speakerProfiles)) {
        if (typeof v === 'string' && v.trim()) {
          profiles[normalizeSpeaker(k)] = v.trim().slice(0, 300);
        }
      }
    }
    ctx = {
      speakers: context.speakers.filter((s: unknown) => typeof s === 'string').slice(0, 20),
      speakerProfiles: Object.keys(profiles).length > 0 ? profiles : undefined,
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
    '2. SPEAKER DIARIZATION (CRITICAL - DO NOT MIX UP SPEAKERS):',
    '   - Identify speakers strictly by their distinct physical voice characteristics: vocal pitch, timbre, vocal tract resonance, cadence, and gender.',
    '   - Label speakers "Speaker 1", "Speaker 2", and so on. Do NOT use names or roles (such as Moderator) as labels, even if people introduce themselves.',
    '   - The exact same physical voice must ALWAYS receive the exact same speaker label throughout the entire recording.',
    '   - In the "speakerProfiles" field, document the physical voice characteristics for each distinct voice (e.g. "Speaker 1": "Adult male, deep pitch, steady pace", "Speaker 2": "Adult female, higher pitch, animated timbre").',
    '3. TURNS & CONVERSATIONAL EXCHANGES:',
    '   - Start a new turn immediately whenever the speaker changes. NEVER combine words from two different speakers into one turn.',
    '   - In rapid back-and-forth dialogue, interruptions, or brief interjections ("yeah", "uh-huh", "right", "exactly"), attribute each utterance to the specific voice that spoke it.',
    '   - Split a long monologue into turns at natural sentence breaks roughly every 30-60 seconds.',
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
    if (req.context.speakerProfiles && Object.keys(req.context.speakerProfiles).length > 0) {
      const profileLines = Object.entries(req.context.speakerProfiles)
        .map(([sp, desc]) => `- ${sp}: ${desc}`)
        .join('\n');
      lines.push(
        `ESTABLISHED SPEAKER ACOUSTIC PROFILES (CRITICAL FOR CONTINUITY):\n${profileLines}\n\nMatch every voice in this clip to the established speaker profiles above based on vocal pitch and timbre. Do NOT renumber or swap speakers based on who speaks first in this part!`
      );
    }
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
    speakerProfiles: {
      type: Type.ARRAY,
      description: 'Physical acoustic descriptions of each distinct voice heard (e.g. pitch, timbre, vocal tone, gender, cadence) to track them consistently across the audio.',
      items: {
        type: Type.OBJECT,
        properties: {
          speaker: { type: Type.STRING, description: 'Speaker label, e.g. "Speaker 1".' },
          voiceDescription: {
            type: Type.STRING,
            description:
              'Acoustic voice characteristics: gender/pitch (deep, mid, high), timbre, pacing, accent. E.g. "Deep male voice, slow pace, American accent" or "Higher-pitch female voice, fast speech".',
          },
        },
        required: ['speaker', 'voiceDescription'],
      },
    },
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

  // Handle { segments: [...] }, bare array [...], { segments: null }, or empty {}
  let list: any[] = [];
  if (Array.isArray(data)) {
    list = data;
  } else if (data && typeof data === 'object') {
    const s = (data as any).segments;
    if (Array.isArray(s)) {
      list = s;
    } else if (s === null || s === undefined) {
      // Model returned { segments: null } or {} when no speech/transcription occurred in this part
      list = [];
    } else {
      throw new ParseError('Model response had invalid segments format.');
    }
  } else if (data === null) {
    list = [];
  } else {
    throw new ParseError('Model response had no segments.');
  }

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

  // Extract speakerProfiles if provided
  const speakerProfiles: Record<string, string> = {};
  if (data && typeof data === 'object') {
    const rawProfiles = (data as any).speakerProfiles;
    if (Array.isArray(rawProfiles)) {
      for (const p of rawProfiles) {
        if (p && typeof p.speaker === 'string' && typeof p.voiceDescription === 'string') {
          const norm = normalizeSpeaker(p.speaker);
          const desc = p.voiceDescription.trim();
          if (norm && desc) speakerProfiles[norm] = desc;
        }
      }
    } else if (rawProfiles && typeof rawProfiles === 'object') {
      for (const [k, v] of Object.entries(rawProfiles)) {
        if (typeof v === 'string' && v.trim()) {
          speakerProfiles[normalizeSpeaker(k)] = v.trim();
        }
      }
    }
  }
  if (Object.keys(speakerProfiles).length > 0) {
    (out as any).speakerProfiles = speakerProfiles;
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
  // The failover layer has already used the time budget; retrying here would multiply it.
  if (err instanceof UpstreamTimeoutError) return false;
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
  let used: GenerateResult | null = null;
  let lastError: unknown;
  for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
    const result = await withRetry(() => generate(params), retryOpts);
    try {
      parsed = parseModelJson(result.text);
      used = result;
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

  const modelUsed = used?.modelUsed ?? req.model;
  if (used?.fallbackFrom || modelUsed !== req.model) {
    const from = used?.fallbackFrom ?? req.model;
    flags.push({
      ...flagBase,
      code: 'model_fallback',
      message: `${modelLabel(from)} was slow or busy (${used?.fallbackReason ?? 'no answer in time'}), so ${modelLabel(modelUsed)} transcribed this part. Speaker separation may be weaker; use Retry part when it is less busy.`,
    });
  }

  return {
    segments,
    flags,
    modelUsed,
    speakerProfiles: (parsed as any)?.speakerProfiles,
  };
}
