import { describe, expect, it } from 'vitest';
import { computeFrameEnergies, findSplitPoints, pointsToRanges, baseMimeType } from '../src/utils/audioChunker';
import { cleanText, findReplace, parseLegacyMarkdown } from '../src/utils/transcript';
import { buildCues, formatCueTime, toSrt, toTxt, toVtt, ExportDoc } from '../src/utils/export';

describe('silence-aware splitting', () => {
  // 100 ms frames; loud everywhere except a quiet gap near 295 s.
  const frames = (seconds: number, quiet: Array<[number, number]>) => {
    const e = new Float32Array(Math.round(seconds * 10)).fill(0.2);
    for (const [a, b] of quiet) for (let f = Math.round(a * 10); f < Math.round(b * 10); f++) e[f] = 0.0001;
    return e;
  };

  it('cuts inside the silent gap, not at the fixed mark', () => {
    const points = findSplitPoints(frames(700, [[292, 296]]), 300);
    expect(points[0]).toBeGreaterThan(292);
    expect(points[0]).toBeLessThan(296);
  });
  it('does not split a file barely longer than one chunk', () => {
    expect(findSplitPoints(frames(320, []), 300)).toEqual([]);
  });
  it('produces contiguous ranges covering the whole file', () => {
    const duration = 1000;
    const ranges = pointsToRanges(findSplitPoints(frames(duration, []), 300), duration);
    expect(ranges[0][0]).toBe(0);
    expect(ranges[ranges.length - 1][1]).toBe(duration);
    for (let i = 1; i < ranges.length; i++) expect(ranges[i][0]).toBe(ranges[i - 1][1]);
    expect(Math.max(...ranges.map(([a, b]) => b - a))).toBeLessThan(300 * 1.15 + 25);
  });
  it('computes energies per frame', () => {
    const e = computeFrameEnergies([new Float32Array(16000).fill(0.5)], 16000);
    expect(e).toHaveLength(10);
    expect(e[0]).toBeCloseTo(0.25, 5);
  });
  it('strips codec params from mime types', () => {
    expect(baseMimeType('audio/webm;codecs=opus')).toBe('audio/webm');
    expect(baseMimeType('')).toBe('audio/mpeg');
  });
});

describe('parseLegacyMarkdown', () => {
  it('migrates the old chunked markdown format', () => {
    const md = [
      '### [0:00 - 5:00]',
      '**Speaker 1:** Hello there.',
      '**Speaker 2:** Hi, how are you?',
      '### [5:00 - 10:00]',
      '**Moderator:** Next question.',
      'continuing line',
    ].join('\n\n');
    const segs = parseLegacyMarkdown(md);
    // The trailing header-less line is merged into the previous Moderator turn.
    expect(segs.map((s) => [s.speaker, s.start])).toEqual([
      ['Speaker 1', 0],
      ['Speaker 2', 0],
      ['Moderator', 300],
    ]);
    expect(segs[2].text).toContain('Next question.');
    expect(segs[2].text).toContain('continuing line');
  });
  it('treats text without headers as one part starting at 0', () => {
    const segs = parseLegacyMarkdown('**Speaker 1:** Just this.');
    expect(segs).toHaveLength(1);
    expect(segs[0].start).toBe(0);
  });
});

describe('cleanText', () => {
  it('removes fillers and stutters', () => {
    expect(cleanText('Um, I I think we we should go.')).toBe('I think we should go.');
    expect(cleanText('So uh the the plan is ok')).toBe('So the plan is ok');
  });
  it('keeps legitimate repeated words and does not touch normal words', () => {
    expect(cleanText('He said that that was fine.')).toBe('He said that that was fine.');
    expect(cleanText('She had had enough.')).toBe('She had had enough.');
    expect(cleanText('The summer was hot')).toBe('The summer was hot');
  });
});

describe('findReplace', () => {
  const segs = [
    { id: '1', speaker: 'Speaker 1', start: 0, text: 'Beacoya and beacoya again' },
    { id: '2', speaker: 'Speaker 2', start: 5, text: 'nothing here' },
  ];
  it('replaces case-insensitively by default and counts', () => {
    const r = findReplace(segs, 'beacoya', 'Becoya');
    expect(r.count).toBe(2);
    expect(r.segments[0].text).toBe('Becoya and Becoya again');
    expect(r.segments[1]).toBe(segs[1]);
  });
  it('treats the search as literal text', () => {
    expect(findReplace(segs, '.*', 'x').count).toBe(0);
  });
});

describe('exports', () => {
  const doc: ExportDoc = {
    title: 'Interview',
    date: '2026-11-05T10:00:00Z',
    model: '3.7 Flash',
    speakerNames: { 'Speaker 1': 'Dr. Ali' },
    segments: [
      { id: 'a', speaker: 'Speaker 1', start: 0, text: 'Hello and welcome to the session, today we discuss market access in the region.' },
      { id: 'b', speaker: 'Speaker 2', start: 12.5, text: 'Thanks.' },
    ],
  };

  it('formats cue times', () => {
    expect(formatCueTime(3723.456, ',')).toBe('01:02:03,456');
    expect(formatCueTime(1.5, '.')).toBe('00:00:01.500');
  });
  it('builds non-overlapping, ordered cues with at most two lines', () => {
    const cues = buildCues(doc);
    for (let i = 0; i < cues.length; i++) {
      expect(cues[i].end).toBeGreaterThan(cues[i].start);
      if (i > 0) expect(cues[i].start).toBeGreaterThanOrEqual(cues[i - 1].end - 1e-6);
      expect(cues[i].text.split('\n').length).toBeLessThanOrEqual(2);
    }
    expect(cues[0].text.startsWith('Dr. Ali:')).toBe(true);
  });
  it('writes valid SRT and VTT', () => {
    const srt = toSrt(doc);
    expect(srt.startsWith('1\n00:00:00,000 -->')).toBe(true);
    expect(toVtt(doc).startsWith('WEBVTT\n\n00:00:00.000 -->')).toBe(true);
  });
  it('writes txt with renamed speakers and optional timestamps', () => {
    expect(toTxt(doc, { timestamps: true })).toContain('[0:12] Speaker 2: Thanks.');
    expect(toTxt(doc, { timestamps: false })).toContain('Dr. Ali: Hello');
  });
});
