import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FailoverOptions,
  createGenerate,
  isFailoverEligible,
  runWithFailover,
  thinkingConfigFor,
} from '../server/generate';
import { UpstreamTimeoutError } from '../server/transcribe';
import { FALLBACK_MODEL_ID, usesLowThinking } from '../src/shared/models';

const opts: FailoverOptions = {
  primaryTimeoutMs: 60,
  budgetMs: 150,
  minFallbackMs: 20,
  fallbackModel: FALLBACK_MODEL_ID,
};

/** A call that resolves after `ms` unless its signal aborts first (like the real SDK). */
function slowCall(ms: number, value = 'ok') {
  return (_model: string, signal: AbortSignal) =>
    new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => resolve(value), ms);
      signal.addEventListener('abort', () => {
        clearTimeout(t);
        reject(new DOMException('Aborted', 'AbortError'));
      });
    });
}

describe('runWithFailover', () => {
  it('uses the requested model when it answers in time', async () => {
    const call = vi.fn(slowCall(10, 'primary-answer'));
    const r = await runWithFailover('gemini-3.8-flash', call, opts);
    expect(r).toEqual({ value: 'primary-answer', modelUsed: 'gemini-3.8-flash' });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('cancels a slow model and falls back once, reporting why', async () => {
    const signals: AbortSignal[] = [];
    const call = vi.fn((model: string, signal: AbortSignal) => {
      signals.push(signal);
      return model === 'gemini-3.8-flash' ? slowCall(1000)(model, signal) : slowCall(10, 'fast')(model, signal);
    });
    const r = await runWithFailover('gemini-3.8-flash', call, opts);
    expect(r.modelUsed).toBe(FALLBACK_MODEL_ID);
    expect(r.value).toBe('fast');
    expect(r.fallback?.from).toBe('gemini-3.8-flash');
    expect(r.fallback?.reason).toMatch(/no answer within/);
    expect(signals[0].aborted).toBe(true); // the abandoned call was really cancelled
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('never makes more than two attempts and stays inside the time budget', async () => {
    const call = vi.fn(slowCall(10_000));
    const started = Date.now();
    await expect(runWithFailover('gemini-3.8-flash', call, opts)).rejects.toBeInstanceOf(UpstreamTimeoutError);
    expect(Date.now() - started).toBeLessThan(opts.budgetMs + 100);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('reports the model the user selected when both attempts fail', async () => {
    const call = vi.fn(slowCall(10_000));
    const err = await runWithFailover('gemini-3.8-flash', call, opts).catch((e) => e);
    expect(err).toBeInstanceOf(UpstreamTimeoutError);
    expect(err.model).toBe('gemini-3.8-flash');
  });

  it('skips the fallback when too little of the budget is left', async () => {
    const tight: FailoverOptions = { ...opts, primaryTimeoutMs: 60, budgetMs: 70, minFallbackMs: 50 };
    const call = vi.fn(slowCall(10_000));
    await expect(runWithFailover('gemini-3.8-flash', call, tight)).rejects.toBeInstanceOf(UpstreamTimeoutError);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('does not fall back for errors another model cannot fix (bad request, auth)', async () => {
    for (const status of [400, 401, 403]) {
      const call = vi.fn().mockRejectedValue({ status, message: 'nope' });
      await expect(runWithFailover('gemini-3.8-flash', call, opts)).rejects.toMatchObject({ status });
      expect(call).toHaveBeenCalledTimes(1);
    }
  });

  it('falls back immediately on overload, rate limit and missing model', async () => {
    for (const status of [429, 503, 404]) {
      const call = vi.fn().mockRejectedValueOnce({ status, message: 'x' }).mockResolvedValueOnce('lite');
      const r = await runWithFailover('gemini-3.8-flash', call, opts);
      expect(r.modelUsed).toBe(FALLBACK_MODEL_ID);
    }
  });

  it('does not fall back when the fallback model itself was requested', async () => {
    const call = vi.fn().mockRejectedValue({ status: 503, message: 'overloaded' });
    await expect(runWithFailover(FALLBACK_MODEL_ID, call, opts)).rejects.toMatchObject({ status: 503 });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('classifies errors', () => {
    expect(isFailoverEligible(new UpstreamTimeoutError('m', 1000))).toBe(true);
    expect(isFailoverEligible(new Error('The model is overloaded'))).toBe(true);
    expect(isFailoverEligible({ status: 400 })).toBe(false);
  });
});

describe('createGenerate', () => {
  afterEach(() => vi.restoreAllMocks());

  const params = {
    model: 'gemini-3.8-flash',
    mimeType: 'audio/wav',
    base64Audio: 'AAAA',
    systemInstruction: 'sys',
    userText: 'go',
  };

  function fakeAi(handler: (req: any) => Promise<any>) {
    const generateContent = vi.fn(handler);
    return { ai: { models: { generateContent } } as any, generateContent };
  }

  it('sends low thinking, an abort signal and the schema for full Flash models', async () => {
    const { ai, generateContent } = fakeAi(async () => ({ text: '{"segments":[]}', candidates: [{ finishReason: 'STOP' }] }));
    const r = await createGenerate(ai, opts)(params);
    const cfg = generateContent.mock.calls[0][0].config;
    expect(cfg.thinkingConfig).toEqual({ thinkingLevel: 'LOW' });
    expect(cfg.abortSignal).toBeInstanceOf(AbortSignal);
    expect(cfg.responseMimeType).toBe('application/json');
    expect(cfg.responseSchema).toBeTruthy();
    expect(cfg.temperature).toBeUndefined();
    expect(r).toMatchObject({ text: '{"segments":[]}', finishReason: 'STOP', modelUsed: 'gemini-3.8-flash' });
  });

  it('sends no thinking override to Lite models', async () => {
    const { ai, generateContent } = fakeAi(async () => ({ text: '{}' }));
    await createGenerate(ai, opts)({ ...params, model: 'gemini-3.1-flash-lite' });
    expect(generateContent.mock.calls[0][0].config.thinkingConfig).toBeUndefined();
  });

  it('switches model on a timeout and tells the caller', async () => {
    const { ai, generateContent } = fakeAi((req) =>
      req.model === 'gemini-3.8-flash'
        ? new Promise((_res, rej) => req.config.abortSignal.addEventListener('abort', () => rej(new Error('aborted'))))
        : Promise.resolve({ text: '{"segments":[]}' })
    );
    const r = await createGenerate(ai, opts)(params);
    expect(generateContent.mock.calls.map((c) => c[0].model)).toEqual(['gemini-3.8-flash', FALLBACK_MODEL_ID]);
    expect(r.modelUsed).toBe(FALLBACK_MODEL_ID);
    expect(r.fallbackFrom).toBe('gemini-3.8-flash');
    expect(r.fallbackReason).toMatch(/no answer/);
  });
});

describe('thinking rule', () => {
  it('applies to full Flash models only', () => {
    for (const id of ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.7-flash', 'gemini-3.5-flash']) {
      expect(usesLowThinking(id)).toBe(true);
    }
    for (const id of ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite', 'gemini-2.5-flash']) {
      expect(usesLowThinking(id)).toBe(false);
    }
    expect(thinkingConfigFor('gemini-3.1-flash-lite')).toEqual({});
  });
});
