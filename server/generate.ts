import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import { FALLBACK_MODEL_ID, temperatureFor, usesLowThinking } from '../src/shared/models';
import { GenerateFn, RESPONSE_SCHEMA, UpstreamTimeoutError } from './transcribe';

export interface FailoverOptions {
  /** How long the selected model may take before the call is cancelled (ms). */
  primaryTimeoutMs: number;
  /** Total time one request may take, failover included (ms). Keep this below any proxy timeout. */
  budgetMs: number;
  /** Do not start a failover attempt with less than this left (ms). */
  minFallbackMs: number;
  fallbackModel: string;
}

const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

export function defaultFailoverOptions(env: NodeJS.ProcessEnv = process.env): FailoverOptions {
  return {
    primaryTimeoutMs: num(env.GEMINI_TIMEOUT_MS, 35_000),
    budgetMs: num(env.GEMINI_BUDGET_MS, 50_000),
    minFallbackMs: 6_000,
    fallbackModel: FALLBACK_MODEL_ID,
  };
}

function statusOf(err: any): number | undefined {
  const s = err?.status ?? err?.code ?? err?.error?.code;
  return typeof s === 'number' ? s : undefined;
}

/** Would trying a different (faster) model plausibly help? Auth and bad-request errors will not. */
export function isFailoverEligible(err: unknown): boolean {
  if (err instanceof UpstreamTimeoutError) return true;
  const status = statusOf(err);
  if (status && [404, 408, 429, 500, 502, 503, 504].includes(status)) return true;
  const msg = String((err as any)?.message ?? err).toLowerCase();
  return /overloaded|unavailable|resource_exhausted|demand|no longer available|not found/.test(msg);
}

function describe(err: unknown): string {
  if (err instanceof UpstreamTimeoutError) return `no answer within ${Math.round(err.timeoutMs / 1000)}s`;
  const status = statusOf(err);
  return status ? `HTTP ${status}` : String((err as any)?.message ?? err).slice(0, 80);
}

export interface FailoverResult<T> {
  value: T;
  modelUsed: string;
  fallback?: { from: string; reason: string };
}

/**
 * Runs `call` on the requested model. If it times out or the service is overloaded, makes at
 * most ONE attempt on the fallback model within the remaining time budget. Every attempt is
 * cancelled when it times out, so abandoned calls do not keep running (and billing).
 */
export async function runWithFailover<T>(
  primary: string,
  call: (model: string, signal: AbortSignal) => Promise<T>,
  opts: FailoverOptions,
  now: () => number = Date.now
): Promise<FailoverResult<T>> {
  const start = now();

  const attempt = async (model: string, timeoutMs: number): Promise<T> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await call(model, controller.signal);
    } catch (err) {
      if (controller.signal.aborted) throw new UpstreamTimeoutError(model, timeoutMs);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    const value = await attempt(primary, Math.min(opts.primaryTimeoutMs, opts.budgetMs));
    return { value, modelUsed: primary };
  } catch (err) {
    if (primary === opts.fallbackModel || !isFailoverEligible(err)) throw err;
    const remaining = opts.budgetMs - (now() - start);
    if (remaining < opts.minFallbackMs) throw err;

    console.warn(`Model ${primary} failed (${describe(err)}); trying ${opts.fallbackModel}.`);
    try {
      const value = await attempt(opts.fallbackModel, remaining);
      return { value, modelUsed: opts.fallbackModel, fallback: { from: primary, reason: describe(err) } };
    } catch (fallbackErr) {
      console.warn(`Fallback ${opts.fallbackModel} failed too (${describe(fallbackErr)}).`);
      // Report the model the user selected, not the emergency fallback.
      throw err;
    }
  }
}

export function thinkingConfigFor(model: string) {
  return usesLowThinking(model) ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } } : {};
}

export function createGenerate(
  ai: Pick<GoogleGenAI, 'models'>,
  opts: FailoverOptions = defaultFailoverOptions()
): GenerateFn {
  return async (p) => {
    const { value, modelUsed, fallback } = await runWithFailover(
      p.model,
      async (model, signal) => {
        const temperature = temperatureFor(model);
        const response = await ai.models.generateContent({
          model,
          contents: [
            {
              role: 'user',
              parts: [{ inlineData: { mimeType: p.mimeType, data: p.base64Audio } }, { text: p.userText }],
            },
          ],
          config: {
            abortSignal: signal,
            systemInstruction: p.systemInstruction,
            responseMimeType: 'application/json',
            responseSchema: RESPONSE_SCHEMA,
            maxOutputTokens: 8192,
            ...thinkingConfigFor(model),
            ...(temperature !== undefined ? { temperature } : {}),
          },
        });
        return { text: response.text ?? '', finishReason: response.candidates?.[0]?.finishReason };
      },
      opts
    );
    return { ...value, modelUsed, fallbackFrom: fallback?.from, fallbackReason: fallback?.reason };
  };
}
