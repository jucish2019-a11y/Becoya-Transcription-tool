import { describe, expect, it, vi } from 'vitest';
import {
  RequestError,
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
  it('does not send temperature for Gemini 3.x but does for older models', async () => {
    const generate = vi.fn().mockResolvedValue({ text: good });
    await transcribeChunk(generate, validateRequest(base));
    expect(generate.mock.calls[0][0].temperature).toBeUndefined();
    await transcribeChunk(generate, validateRequest({ ...base, model: 'gemini-2.5-flash' }));
    expect(generate.mock.calls[1][0].temperature).toBe(0);
  });
});
