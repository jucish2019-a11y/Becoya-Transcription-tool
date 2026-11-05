import { GoogleGenAI } from '@google/genai';
import { MODELS, ModelInfo } from '../src/shared/models';

const CACHE_MS = 10 * 60 * 1000;
let cache: { at: number; ids: Set<string> | null } | null = null;

/** Names of the models the configured API key can actually use, or null if the lookup failed. */
async function fetchAvailableIds(ai: GoogleGenAI): Promise<Set<string> | null> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.ids;

  let ids: Set<string> | null = null;
  try {
    const found = new Set<string>();
    const pager = await ai.models.list();
    for await (const m of pager) {
      if (m.name) found.add(m.name.replace(/^models\//, ''));
    }
    ids = found.size > 0 ? found : null;
  } catch (err) {
    console.warn('Could not list models; showing the full configured list.', (err as Error)?.message);
  }
  cache = { at: Date.now(), ids };
  return ids;
}

export interface ModelListResult {
  models: ModelInfo[];
  /** False when the availability lookup failed and the list is unfiltered. */
  verified: boolean;
}

export async function listUsableModels(ai: GoogleGenAI | null): Promise<ModelListResult> {
  if (!ai) return { models: MODELS, verified: false };
  const available = await fetchAvailableIds(ai);
  if (!available) return { models: MODELS, verified: false };

  const usable = MODELS.filter((m) => available.has(m.id));
  // If nothing matched, something is off with the lookup; do not leave the user with an empty dropdown.
  return usable.length > 0 ? { models: usable, verified: true } : { models: MODELS, verified: false };
}
