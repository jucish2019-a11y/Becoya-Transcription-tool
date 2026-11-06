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
    id: 'gemini-3.1-flash-lite',
    name: 'Gemini 3.1 Flash-Lite (★ Ultra-Fast, No Spikes)',
    shortLabel: '3.1 Flash-Lite',
    description: 'Fastest response time (~1s). Zero thinking delay, resilient to high demand spikes.',
    chunkSec: 180,
    recommended: true,
  },
  {
    id: 'gemini-3.8-flash',
    name: 'Gemini 3.8 Flash (★ 1M Context Window)',
    shortLabel: 'gemini-3.8-flash',
    description: 'Premier multimodal model with massive 1M context window and acoustic voice tracking.',
    chunkSec: 180,
  },
  {
    id: 'gemini-3.5-flash',
    name: 'Gemini 3.5 Flash (High Throughput & Stable)',
    shortLabel: '3.5 Flash',
    description: 'Proven high-throughput model with fast audio inference and reliable quotas.',
    chunkSec: 180,
  },
  {
    id: 'gemini-3.7-flash',
    name: 'Gemini 3.7 Flash (High Accuracy - Fast Mode)',
    shortLabel: '3.7 Flash',
    description: 'Multimodal reasoning model tuned for rapid transcription with minimal thinking latency.',
    chunkSec: 180,
  },
  {
    id: 'gemini-3.5-transcribe',
    name: 'Gemini 3.5 Transcribe (Google Dedicated Audio Engine)',
    shortLabel: '3.5 Transcribe',
    description: 'Specialized audio transcription engine optimized for verbatim accuracy on speech.',
    chunkSec: 180,
  },
  {
    id: 'gemini-3.6-flash',
    name: 'Gemini 3.6 Flash (Fast & Accurate)',
    shortLabel: '3.6 Flash',
    description: 'Multimodal model with robust speaker separation and consistent availability.',
    chunkSec: 180,
  },
  {
    id: 'gemini-2.5-flash',
    name: 'Gemini 2.5 Flash',
    shortLabel: '2.5 Flash',
    description: 'Legacy fallback model for compatibility.',
    chunkSec: 180,
  },
];

export const ALLOWED_MODEL_IDS = new Set([
  ...MODELS.map((m) => m.id),
  'gemini-flash-latest',
]);

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
