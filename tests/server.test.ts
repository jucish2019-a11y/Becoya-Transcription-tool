import { describe, expect, it, vi } from 'vitest';
import { temperatureFor } from '../src/shared/models';
import {
  RequestError,
  UpstreamTimeoutError,
  buildPrompt,
  isRetryable,
  parseModelJson,
  transcribeChunk,
  validateRequest,
  withRetry,
} from '../server/transcribe';

const base = {
  base64Audio: 'QUJDREVGR0hJSktMTU5PUA==',
  mimeType: 'audio/webm;codecs=opus',
  model: 'gemini-3.7-flash',
  chunk: { index: 1, total: 3, startSec: 300, endSec: 600 },
};

describe('validateRequest', () => {
  it('normalises a valid request', () => {
    const r = validateRequest({ ...base, style: 'clean', language: 'ar', expectedSpeakers: 2 });
    expect(r.mimeType).toBe('audio/webm');
    expect(r.style).toBe('clean');
    expect(r.language).toBe('ar');
    expect(r.expectedSpeakers).toBe(2);
  });
  it('rejects unknown models, bad audio and non-audio types', () => {
    expect(() => validateRequest({ ...base, model: 'gpt-4' })).toThrow(RequestError);
    expect(() => validateRequest({ ...base, base64Audio: '' })).toThrow(RequestError);
    expect(() => validateRequest({ ...base, mimeType: 'text/html' })).toThrow(RequestError);
    expect(() => validateRequest(null)).toThrow(RequestError);
  });
  it('explains why the transcribe-only model cannot be used', () => {
    expect(() => validateRequest({ ...base, model: 'gemini-3.5-transcribe' })).toThrow(/different Google API/);
  });
  it('still accepts deprecated aliases that old saved transcripts may carry', () => {
    expect(validateRequest({ ...base, model: 'gemini-3.7-flash' }).model).toBe('gemini-3.7-flash');
    expect(validateRequest({ ...base, model: 'gemini-3.8-flash' }).model).toBe('gemini-3.8-flash');
  });
  it('falls back to safe defaults', () => {
    const r = validateRequest({ ...base, style: 'weird', language: 'xx', expectedSpeakers: 99 });
    expect(r.style).toBe('verbatim');
    expect(r.language).toBe('auto');
    expect(r.expectedSpeakers).toBeUndefined();
  });
});

describe('buildPrompt', () => {
  it('includes speaker continuity context and vocabulary', () => {
    const req = validateRequest({
      ...base,
      vocabulary: 'Becoya, SFDA',
      context: {
        speakers: ['Speaker 1', 'Speaker 2'],
        speakerProfiles: { 'Speaker 1': 'Deep male voice, slow pace', 'Speaker 2': 'High pitch female voice' },
        tail: [{ speaker: 'Speaker 2', text: 'and that was it.' }],
      },
    });
    const { userText, systemInstruction } = buildPrompt(req);
    expect(userText).toContain('part 2 of 3');
    expect(userText).toContain('5:00');
    expect(userText).toContain('Speaker 1, Speaker 2');
    expect(userText).toContain('Deep male voice, slow pace');
    expect(userText).toContain('[Speaker 2] and that was it.');
    expect(userText).toContain('Becoya, SFDA');
    expect(systemInstruction).toContain('NEVER translate');
    expect(systemInstruction).toContain('SPEAKER DIARIZATION');
  });
});

describe('parseModelJson', () => {
  it('parses an object, a bare array and fenced JSON', () => {
    const item = { speaker: 'speaker 2', start: '0:05', text: ' Hi ' };
    for (const payload of [{ segments: [item] }, [item]]) {
      const out = parseModelJson(JSON.stringify(payload));
      expect(out).toEqual([{ speaker: 'Speaker 2', start: 5, text: 'Hi' }]);
    }
    expect(parseModelJson('```json\n' + JSON.stringify({ segments: [item] }) + '\n```')).toHaveLength(1);
  });
  it('parses speakerProfiles along with segments', () => {
    const payload = {
      speakerProfiles: [
        { speaker: 'Speaker 1', voiceDescription: 'Deep male voice' },
        { speaker: 'Speaker 2', voiceDescription: 'High pitch female voice' },
      ],
      segments: [{ speaker: 'Speaker 1', start: '0:02', text: 'Hello' }],
    };
    const out: any = parseModelJson(JSON.stringify(payload));
    expect(out).toHaveLength(1);
    expect(out[0].speaker).toBe('Speaker 1');
    expect(out.speakerProfiles).toEqual({
      'Speaker 1': 'Deep male voice',
      'Speaker 2': 'High pitch female voice',
    });
  });
  it('drops empty turns and throws on garbage', () => {
    expect(parseModelJson(JSON.stringify({ segments: [{ speaker: 'S1', start: '0:00', text: '  ' }] }))).toEqual([]);
    expect(() => parseModelJson('not json')).toThrow();
  });
  it('handles null segments and empty objects without crashing', () => {
    expect(parseModelJson(JSON.stringify({ segments: null }))).toEqual([]);
    expect(parseModelJson('{}')).toEqual([]);
    expect(parseModelJson('null')).toEqual([]);
    expect(parseModelJson('{"segments": [null, {"speaker": "Speaker 1", "start": "0:01", "text": "Valid"}]}')).toEqual([
      { speaker: 'Speaker 1', start: 1, text: 'Valid' },
    ]);
  });
});

describe('retry', () => {
  it('classifies errors', () => {
    expect(isRetryable({ status: 503 })).toBe(true);
    expect(isRetryable({ status: 429 })).toBe(true);
    expect(isRetryable(new Error('The model is overloaded'))).toBe(true);
    expect(isRetryable({ status: 400 })).toBe(false);
    expect(isRetryable(new RequestError('bad'))).toBe(false);
  });
  it('retries transient failures then succeeds', async () => {
    const fn = vi.fn().mockRejectedValueOnce({ status: 503 }).mockRejectedValueOnce({ status: 429 }).mockResolvedValue('ok');
    await expect(withRetry(fn, { sleepFn: async () => {} })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });
  it('does not retry permanent errors', async () => {
    const fn = vi.fn().mockRejectedValue({ status: 400 });
    await expect(withRetry(fn, { sleepFn: async () => {} })).rejects.toEqual({ status: 400 });
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('transcribeChunk', () => {
  const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');
  const good = JSON.stringify({
    segments: [
      { speaker: 'Speaker 1', start: '0:00', text: words(300) },
      { speaker: 'Speaker 2', start: '2:30', text: words(300) },
    ],
  });

  it('shifts timestamps to the full recording', async () => {
    const generate = vi.fn().mockResolvedValue({ text: good, finishReason: 'STOP' });
    const r = await transcribeChunk(generate, validateRequest(base), { sleepFn: async () => {} });
    expect(r.segments.map((s) => s.start)).toEqual([300, 450]);
    expect(r.flags).toEqual([]);
  });
  it('retries once on malformed JSON', async () => {
    const generate = vi.fn().mockResolvedValueOnce({ text: 'oops' }).mockResolvedValueOnce({ text: good });
    const r = await transcribeChunk(generate, validateRequest(base), { sleepFn: async () => {} });
    expect(r.segments).toHaveLength(2);
    expect(generate).toHaveBeenCalledTimes(2);
  });
  it('fails after two unreadable responses', async () => {
    const generate = vi.fn().mockResolvedValue({ text: 'oops' });
    await expect(transcribeChunk(generate, validateRequest(base))).rejects.toThrow();
    expect(generate).toHaveBeenCalledTimes(2);
  });
  it('flags truncated output', async () => {
    const generate = vi.fn().mockResolvedValue({ text: good, finishReason: 'MAX_TOKENS' });
    const r = await transcribeChunk(generate, validateRequest(base));
    expect(r.flags.map((f) => f.code)).toContain('truncated');
  });
  it('does not send a temperature for Gemini 3.x models', async () => {
    const generate = vi.fn().mockResolvedValue({ text: good });
    await transcribeChunk(generate, validateRequest(base));
    expect(generate.mock.calls[0][0].temperature).toBeUndefined();
    expect(temperatureFor('gemini-3.8-flash')).toBeUndefined();
    expect(temperatureFor('gemini-2.5-flash')).toBe(0);
  });

  it('reports which model produced the part and flags a fallback', async () => {
    const generate = vi.fn().mockResolvedValue({
      text: good,
      modelUsed: 'gemini-3.1-flash-lite',
      fallbackFrom: 'gemini-3.8-flash',
      fallbackReason: 'no answer within 35s',
    });
    const r = await transcribeChunk(generate, validateRequest({ ...base, model: 'gemini-3.8-flash' }));
    expect(r.modelUsed).toBe('gemini-3.1-flash-lite');
    const flag = r.flags.find((f) => f.code === 'model_fallback');
    expect(flag?.chunk).toBe(1);
    expect(flag?.message).toContain('3.8 Flash');
    expect(flag?.message).toContain('3.1 Flash-Lite');
  });

  it('does not flag anything when the requested model answered', async () => {
    const generate = vi.fn().mockResolvedValue({ text: good, modelUsed: 'gemini-3.8-flash' });
    const r = await transcribeChunk(generate, validateRequest({ ...base, model: 'gemini-3.8-flash' }));
    expect(r.flags.map((f) => f.code)).not.toContain('model_fallback');
  });

  it('never retries an upstream timeout (the failover layer already spent the time budget)', async () => {
    const generate = vi.fn().mockRejectedValue(new UpstreamTimeoutError('gemini-3.8-flash', 35000));
    await expect(transcribeChunk(generate, validateRequest(base), { sleepFn: async () => {} })).rejects.toBeInstanceOf(
      UpstreamTimeoutError
    );
    expect(generate).toHaveBeenCalledTimes(1);
  });
});
