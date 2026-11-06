// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/utils/audioChunker', async (orig) => {
  const real = await orig<typeof import('../src/utils/audioChunker')>();
  return {
    ...real,
    chunkAudio: vi.fn(async () => ({
      durationSec: 900,
      chunks: [0, 1, 2].map((i) => ({
        blob: new Blob(['audio-' + i], { type: 'audio/wav' }),
        mimeType: 'audio/wav',
        startTimeSec: i * 300,
        endTimeSec: (i + 1) * 300,
        index: i,
        total: 3,
      })),
    })),
  };
});

import { useHistory } from '../src/hooks/useHistory';
import { TranscribeOptions, useTranscriber } from '../src/hooks/useTranscriber';

const options: TranscribeOptions = {
  model: 'gemini-3.7-flash',
  style: 'verbatim',
  language: 'auto',
  vocabulary: 'Becoya',
};

function useBoth() {
  const history = useHistory();
  const t = useTranscriber({ addItem: history.addItem, updateItem: history.updateItem, onStarted: () => {} });
  return { ...history, t };
}

/** Fake server: part N returns one turn per speaker present so far. */
function mockServer(opts: { delayMs?: number; failPart?: number } = {}) {
  const calls: any[] = [];
  const fetchMock = vi.fn(async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (opts.failPart === body.chunk.index) {
      return { ok: false, status: 502, json: async () => ({ error: 'boom' }) };
    }
    const i = body.chunk.index;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        segments: [
          { speaker: 'Speaker 1', start: body.chunk.startSec + 1, text: `part ${i} from speaker one` },
          { speaker: 'Speaker 2', start: body.chunk.startSec + 20, text: `part ${i} from speaker two` },
        ],
        flags: i === 1 ? [{ chunk: 1, startSec: 300, endSec: 600, code: 'low_coverage', message: 'few words' }] : [],
      }),
    };
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('useTranscriber', () => {
  it('transcribes every part in order and hands speaker context to later parts', async () => {
    const { calls } = mockServer();
    const { result } = renderHook(useBoth);

    await act(async () => {
      await result.current.t.start(new Blob(['x']), 'audio/mpeg', 'Interview', options);
    });

    expect(calls.map((c) => c.chunk.index)).toEqual([0, 1, 2]);
    expect(calls[0].context).toBeUndefined(); // nothing known yet
    expect(calls[1].context.speakers).toEqual(['Speaker 1', 'Speaker 2']);
    expect(calls[1].context.tail.at(-1).text).toBe('part 0 from speaker two');
    expect(calls[2].context.tail.at(-1).text).toBe('part 1 from speaker two');
    expect(calls[0].vocabulary).toBe('Becoya');

    const item = result.current.history[0];
    expect(item.segments.map((s) => s.text)).toEqual([
      'part 0 from speaker one', 'part 0 from speaker two',
      'part 1 from speaker one', 'part 1 from speaker two',
      'part 2 from speaker one', 'part 2 from speaker two',
    ]);
    expect(item.segments[2].start).toBe(301); // absolute time in the full recording
    expect(item.isPartial).toBe(false);
    expect(item.title).toBe('Interview');
    expect(item.flags.map((f) => f.chunk)).toEqual([1]);
    expect(result.current.t.session?.status).toBe('completed');
  });

  it('stops on failure and resumes from the failed part without redoing earlier ones', async () => {
    const first = mockServer({ failPart: 1 });
    const { result } = renderHook(useBoth);

    await act(async () => {
      await result.current.t.start(new Blob(['x']), 'audio/mpeg', 'Interview', options);
    });
    expect(result.current.t.session?.status).toBe('failed');
    expect(result.current.t.session?.nextChunkIndex).toBe(1);
    expect(result.current.history[0].segments).toHaveLength(2);
    expect(result.current.history[0].isPartial).toBe(true);
    expect(result.current.t.error).toContain('Part 2 of 3');

    const second = mockServer();
    await act(async () => {
      await result.current.t.resume();
    });
    expect(first.calls.length).toBe(2);
    expect(second.calls.map((c) => c.chunk.index)).toEqual([1, 2]);
    expect(result.current.history[0].segments).toHaveLength(6);
    expect(result.current.t.session?.status).toBe('completed');
  });

  it('retrying one part replaces only that part and keeps edits made elsewhere', async () => {
    mockServer();
    const { result } = renderHook(useBoth);
    await act(async () => {
      await result.current.t.start(new Blob(['x']), 'audio/mpeg', 'Interview', options);
    });
    const id = result.current.history[0].id;

    // User edits a turn in part 0 and renames a speaker.
    act(() => {
      result.current.updateItem(id, (i) => ({
        ...i,
        segments: i.segments.map((s, k) => (k === 0 ? { ...s, text: 'EDITED by user' } : s)),
        speakerNames: { 'Speaker 1': 'Moderator' },
      }));
    });

    const retry = mockServer();
    await act(async () => {
      await result.current.t.retryChunk(1);
    });

    expect(retry.calls.map((c) => c.chunk.index)).toEqual([1]);
    const item = result.current.history[0];
    expect(item.segments).toHaveLength(6);
    expect(item.segments[0].text).toBe('EDITED by user');
    expect(item.speakerNames['Speaker 1']).toBe('Moderator');
    expect(item.segments.filter((s) => s.chunk === 1)).toHaveLength(2);
    expect(item.flags.filter((f) => f.chunk === 1)).toHaveLength(1); // replaced, not duplicated
    expect(result.current.t.session?.status).toBe('completed');
  });

  it('retrying a part does not hide the resume card of a failed session', async () => {
    mockServer({ failPart: 2 });
    const { result } = renderHook(useBoth);
    await act(async () => {
      await result.current.t.start(new Blob(['x']), 'audio/mpeg', 'Interview', options);
    });
    expect(result.current.t.session?.status).toBe('failed');

    mockServer();
    await act(async () => {
      await result.current.t.retryChunk(1);
    });
    expect(result.current.t.session?.status).toBe('failed');
    expect(result.current.t.session?.nextChunkIndex).toBe(2);
  });

  it('cancelling mid-upload does not resurrect the session afterwards', async () => {
    mockServer({ delayMs: 50 });
    const { result } = renderHook(useBoth);

    let done!: Promise<void>;
    act(() => {
      done = result.current.t.start(new Blob(['x']), 'audio/mpeg', 'Interview', options);
    });
    await waitFor(() => expect(result.current.t.session).not.toBeNull());

    act(() => result.current.t.cancel());
    await act(async () => {
      await done;
      await new Promise((r) => setTimeout(r, 120));
    });

    expect(result.current.t.session).toBeNull();
    expect(result.current.t.isTranscribing).toBe(false);
  });

  it('handles empty segments parts without crashing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ segments: [], flags: [{ chunk: 0, startSec: 0, endSec: 300, code: 'empty', message: 'Silent' }] }),
      })
    );
    const { result } = renderHook(useBoth);
    await act(async () => {
      await result.current.t.start(new Blob(['x']), 'audio/mpeg', 'Interview', options);
    });
    expect(result.current.t.session?.status).toBe('completed');
    expect(result.current.history[0].segments).toHaveLength(0);
    expect(result.current.history[0].flags).toHaveLength(3); // 3 chunks, each returned the flag
  });

  it('handles invalid server responses with clear errors instead of throwing Cannot read properties of null', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => null,
      })
    );
    const { result } = renderHook(useBoth);
    await act(async () => {
      await result.current.t.start(new Blob(['x']), 'audio/mpeg', 'Interview', options);
    });
    expect(result.current.t.session?.status).toBe('failed');
    expect(result.current.t.error).toContain('Server returned an invalid response');
    expect(result.current.t.error).not.toContain('Cannot read properties of null');
  });
});
