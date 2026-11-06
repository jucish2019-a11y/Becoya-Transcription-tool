/**
 * Single source of truth for the models the app offers.
 *
 * The server also checks this list against `models.list()` for the configured API key
 * at runtime (see server/models.ts), so an ID that does not exist for your key is
 * hidden from the dropdown instead of failing every request.
 */

export interface ModelInfo {
  id: string;
  name: string;
  shortLabel: string;
  description: string;
  /** Target chunk length in seconds. */
  chunkSec: number;
  recommended?: boolean;
}

/**
 * Models offered in the dropdown, best first (the first entry is the default).
 *
 * Checked against Google's model and deprecation pages (Nov 2026):
 * - gemini-3.8-flash is the current GA Flash model.
 * - gemini-3.7-flash and gemini-3.5-flash are deprecated aliases that Google routes to
 *   3.8 Flash and 3.6 Flash. They stay valid for old saved transcripts but are not offered.
 * - gemini-3.5-transcribe is a different kind of model (see UNSUPPORTED_MODELS).
 */
export const MODELS: ModelInfo[] = [
  {
    id: 'gemini-3.8-flash',
    name: 'Gemini 3.8 Flash (recommended)',
    shortLabel: '3.8 Flash',
    description: 'Newest Flash model. Best accuracy for speaker separation, accents and Arabic/French.',
    chunkSec: 180,
    recommended: true,
  },
  {
    id: 'gemini-3.6-flash',
    name: 'Gemini 3.6 Flash',
    shortLabel: '3.6 Flash',
    description: 'Previous-generation Flash. Good second choice if 3.8 is busy.',
    chunkSec: 180,
  },
  {
    id: 'gemini-3.5-flash-lite',
    name: 'Gemini 3.5 Flash-Lite',
    shortLabel: '3.5 Flash-Lite',
    description: 'Faster and cheaper, with weaker speaker separation. Fine for clear two-person audio.',
    chunkSec: 180,
  },
  {
    id: 'gemini-3.1-flash-lite',
    name: 'Gemini 3.1 Flash-Lite (fastest)',
    shortLabel: '3.1 Flash-Lite',
    description: 'Fastest and cheapest. Weakest on crowded, noisy or overlapping speech.',
    chunkSec: 180,
  },
];

/** Used when a slow or overloaded model has to be swapped for a faster one. */
export const FALLBACK_MODEL_ID = 'gemini-3.1-flash-lite';

/** Valid for requests and old history, but not offered in the dropdown. */
const HIDDEN_MODEL_IDS = ['gemini-3.7-flash', 'gemini-3.5-flash', 'gemini-flash-latest'];

export const ALLOWED_MODEL_IDS = new Set<string>([...MODELS.map((m) => m.id), ...HIDDEN_MODEL_IDS]);

/**
 * Models that exist but cannot work through this app's request style (prompt + JSON
 * schema via generateContent). The value is the message shown to the user.
 */
export const UNSUPPORTED_MODELS: Record<string, string> = {
  'gemini-3.5-transcribe':
    'Gemini 3.5 Transcribe uses a different Google API (Interactions with transcriptionConfig) that this app does not support yet. Please choose a Gemini Flash model.',
};

export const DEFAULT_MODEL_ID = MODELS[0].id;

export function getModel(id: string | undefined | null): ModelInfo | undefined {
  return MODELS.find((m) => m.id === id);
}

/** Human-readable label, also for model IDs saved in old history items. */
export function modelLabel(id: string | undefined | null): string {
  if (!id) return '';
  return getModel(id)?.shortLabel ?? id;
}

/**
 * Google recommends leaving temperature at its default for Gemini 3.x models
 * (forcing it low can cause looping). Older models still benefit from a low value.
 */
export function temperatureFor(modelId: string): number | undefined {
  return /^gemini-3/.test(modelId) ? undefined : 0;
}

/**
 * Gemini 3.x Flash models "think" before answering by default, which adds many seconds of
 * latency and is pointless for transcription. Lite models already default to minimal thinking.
 */
export function usesLowThinking(modelId: string): boolean {
  return /^gemini-3[\d.]*-flash$/.test(modelId) || modelId === 'gemini-flash-latest';
}
