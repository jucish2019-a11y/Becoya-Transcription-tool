import { describe, expect, it } from 'vitest';
import {
  formatTimestamp,
  normalizeSpeaker,
  parseTimestamp,
  repairTimestamps,
  runQualityChecks,
} from '../src/shared/transcript';

describe('parseTimestamp', () => {
  it('parses common formats', () => {
    expect(parseTimestamp('01:30')).toBe(90);
    expect(parseTimestamp('1:02:03')).toBe(3723);
    expect(parseTimestamp('[00:15]')).toBe(15);
    expect(parseTimestamp('12.5')).toBe(12.5);
    expect(parseTimestamp(42)).toBe(42);
  });
  it('rejects garbage', () => {
    expect(parseTimestamp('abc')).toBeNull();
    expect(parseTimestamp('')).toBeNull();
    expect(parseTimestamp('1:2:3:4')).toBeNull();
    expect(parseTimestamp(-5)).toBeNull();
    expect(parseTimestamp(undefined)).toBeNull();
  });
});

describe('formatTimestamp', () => {
  it('formats minutes and hours', () => {
    expect(formatTimestamp(0)).toBe('0:00');
    expect(formatTimestamp(65)).toBe('1:05');
    expect(formatTimestamp(3723)).toBe('1:02:03');
  });
});

describe('normalizeSpeaker', () => {
  it('unifies label variants', () => {
    for (const v of ['speaker 1', 'SPEAKER_1', '**Speaker 1:**', 'Speaker1', 'S1', 'Speaker 01']) {
      expect(normalizeSpeaker(v)).toBe('Speaker 1');
    }
  });
  it('keeps real names and defaults empties', () => {
    expect(normalizeSpeaker('Dr. Ali')).toBe('Dr. Ali');
    expect(normalizeSpeaker('')).toBe('Speaker 1');
    expect(normalizeSpeaker(undefined)).toBe('Speaker 1');
  });
});

describe('repairTimestamps', () => {
  const seg = (start: number | null, text = 'hello there') => ({ speaker: 'Speaker 1', start, text });

  it('keeps good timestamps and enforces monotonic order', () => {
    const r = repairTimestamps([seg(0), seg(10), seg(9.8), seg(30)], 60);
    expect(r.approximate).toBe(false);
    expect(r.segments.map((s) => s.start)).toEqual([0, 10, 10, 30]);
  });
  it('falls back to proportional timing when timestamps are broken', () => {
    const r = repairTimestamps([seg(500), seg(2), seg(null), seg(900)], 100);
    expect(r.approximate).toBe(true);
    const starts = r.segments.map((s) => s.start);
    expect(starts[0]).toBe(0);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
    expect(starts[3]).toBeLessThan(100);
  });
  it('handles empty input', () => {
    expect(repairTimestamps([], 60)).toEqual({ segments: [], approximate: false });
  });
});

describe('runQualityChecks', () => {
  const info = { index: 0, startSec: 0, endSec: 300 };
  const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');

  it('passes a normal part', () => {
    expect(runQualityChecks([{ speaker: 'Speaker 1', start: 0, text: words(700) }], info)).toEqual([]);
  });
  it('flags low coverage', () => {
    const f = runQualityChecks([{ speaker: 'Speaker 1', start: 0, text: words(40) }], info);
    expect(f.map((x) => x.code)).toEqual(['low_coverage']);
  });
  it('flags an empty part', () => {
    expect(runQualityChecks([], info).map((x) => x.code)).toEqual(['empty']);
  });
  it('does not flag short silent clips', () => {
    expect(runQualityChecks([], { index: 0, startSec: 0, endSec: 5 })).toEqual([]);
  });
  it('flags repetition loops', () => {
    const rep = Array.from({ length: 4 }, () => ({ speaker: 'Speaker 1', start: 0, text: 'thank you very much indeed' }));
    expect(runQualityChecks(rep, { index: 0, startSec: 0, endSec: 30 }).map((x) => x.code)).toContain('repetition');
    const phrase = Array.from({ length: 10 }, () => 'and then we went').join(' ');
    const f = runQualityChecks([{ speaker: 'Speaker 1', start: 0, text: phrase }], { index: 0, startSec: 0, endSec: 10 });
    expect(f.map((x) => x.code)).toContain('repetition');
  });
});
