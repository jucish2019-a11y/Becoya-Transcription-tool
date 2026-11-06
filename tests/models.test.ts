import { describe, expect, it } from 'vitest';
import {
  ALLOWED_MODEL_IDS,
  DEFAULT_MODEL_ID,
  FALLBACK_MODEL_ID,
  MODELS,
  UNSUPPORTED_MODELS,
  getModel,
  modelLabel,
} from '../src/shared/models';

describe('model registry', () => {
  it('defaults to the strongest model, not the fastest', () => {
    expect(DEFAULT_MODEL_ID).toBe('gemini-3.8-flash');
    expect(DEFAULT_MODEL_ID).not.toMatch(/lite/);
    expect(getModel(DEFAULT_MODEL_ID)?.recommended).toBe(true);
  });

  it('has unique ids and sane chunk lengths', () => {
    const ids = MODELS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const m of MODELS) expect(m.chunkSec).toBeGreaterThanOrEqual(60);
  });

  it('only recommends one model', () => {
    expect(MODELS.filter((m) => m.recommended)).toHaveLength(1);
  });

  it('does not offer deprecated aliases or the transcribe-only model in the dropdown', () => {
    const ids = MODELS.map((m) => m.id);
    for (const id of ['gemini-3.7-flash', 'gemini-3.5-flash', 'gemini-3.5-transcribe']) expect(ids).not.toContain(id);
  });

  it('still accepts deprecated aliases from old transcripts, but not the unsupported model', () => {
    expect(ALLOWED_MODEL_IDS.has('gemini-3.7-flash')).toBe(true);
    expect(ALLOWED_MODEL_IDS.has('gemini-3.5-transcribe')).toBe(false);
    expect(UNSUPPORTED_MODELS['gemini-3.5-transcribe']).toBeTruthy();
  });

  it('keeps the failover target in the list so it is verified like any other model', () => {
    expect(MODELS.map((m) => m.id)).toContain(FALLBACK_MODEL_ID);
  });

  it('labels old and unknown ids without breaking', () => {
    expect(modelLabel('gemini-3.8-flash')).toBe('3.8 Flash');
    expect(modelLabel('some-retired-model')).toBe('some-retired-model');
    expect(modelLabel(undefined)).toBe('');
  });
});
