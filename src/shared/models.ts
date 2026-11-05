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
  /** Target chunk length in seconds. Weaker/smaller models do better on shorter clips. */
  chunkSec: number;
  recommended?: boolean;
}

export const MODELS: ModelInfo[] = [
  {
    id: 'gemini-3.7-flash',
    name: 'Gemini 3.7 Flash',
    shortLabel: '3.7 Flash',
    description: 'Newest Flash model. Best default for accuracy and speaker separation.',
    chunkSec: 300,
    recommended: true,
  },
  {
    id: 'gemini-3.6-flash',
    name: 'Gemini 3.6 Flash',
    shortLabel: '3.6 Flash',
    description: 'Previous-generation Flash. Good fallback if 3.7 is rate-limited.',
    chunkSec: 300,
  },
  {
    id: 'gemini-3.5-flash',
    name: 'Gemini 3.5 Flash',
    shortLabel: '3.5 Flash',
    description: 'Stable general-purpose multimodal model.',
    chunkSec: 300,
  },
  {
    id: 'gemini-3.1-flash-lite',
    name: 'Gemini 3.1 Flash-Lite',
    shortLabel: '3.1 Flash-Lite',
    description: 'Fastest and cheapest. Fine for clear two-speaker audio; weaker on crowded or noisy recordings.',
    chunkSec: 180,
  },
  {
    id: 'gemini-2.5-flash',
    name: 'Gemini 2.5 Flash',
    shortLabel: '2.5 Flash',
    description: 'Older but widely available fallback.',
    chunkSec: 300,
  },
];

export const ALLOWED_MODEL_IDS = new Set(MODELS.map((m) => m.id));

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
