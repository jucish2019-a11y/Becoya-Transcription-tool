import { Segment, formatTimestamp } from '../shared/transcript';
import { SpeakerNames, isMostlyRtl, speakerLabel } from './transcript';

export interface ExportDoc {
  title: string;
  date: string;
  model?: string;
  segments: Segment[];
  speakerNames: SpeakerNames;
}

export interface ExportOptions {
  timestamps: boolean;
}

export type ExportFormat = 'docx' | 'srt' | 'vtt' | 'txt' | 'md' | 'json';

export interface Cue {
  start: number;
  end: number;
  text: string;
}

// ---------------------------------------------------------------------------
// Plain formats
// ---------------------------------------------------------------------------

export function toTxt(doc: ExportDoc, opts: ExportOptions): string {
  return doc.segments
    .map((s) => {
      const ts = opts.timestamps ? `[${formatTimestamp(s.start)}] ` : '';
      return `${ts}${speakerLabel(s.speaker, doc.speakerNames)}: ${s.text}`;
    })
    .join('\n\n');
}

export function toMarkdownDoc(doc: ExportDoc, opts: ExportOptions): string {
  const body = doc.segments
    .map((s) => {
      const ts = opts.timestamps ? ` \`${formatTimestamp(s.start)}\`` : '';
      return `**${speakerLabel(s.speaker, doc.speakerNames)}:**${ts} ${s.text}`;
    })
    .join('\n\n');
  return `# ${doc.title}\n\n_${new Date(doc.date).toLocaleString()}${doc.model ? ` · ${doc.model}` : ''}_\n\n${body}\n`;
}

export function toJson(doc: ExportDoc): string {
  return JSON.stringify(
    {
      title: doc.title,
      date: doc.date,
      model: doc.model,
      speakers: doc.speakerNames,
      segments: doc.segments.map((s) => ({
        speaker: s.speaker,
        name: speakerLabel(s.speaker, doc.speakerNames),
        start: Math.round(s.start * 100) / 100,
        text: s.text,
      })),
    },
    null,
    2
  );
}

// ---------------------------------------------------------------------------
// Subtitles
// ---------------------------------------------------------------------------

const MAX_LINE_CHARS = 42;
const MAX_CUE_CHARS = MAX_LINE_CHARS * 2;
const CHARS_PER_SEC = 15;

export function wrapWords(text: string, maxChars: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + word.length > maxChars) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** Splits turns into subtitle-sized cues (two lines max) with proportional timing. */
export function buildCues(doc: ExportDoc): Cue[] {
  const cues: Cue[] = [];
  const segs = doc.segments;

  segs.forEach((seg, i) => {
    const label = speakerLabel(seg.speaker, doc.speakerNames);
    const text = `${label}: ${seg.text}`;
    const next = segs[i + 1]?.start ?? Infinity;
    const speechDur = Math.max(1.5, seg.text.length / CHARS_PER_SEC);
    const end = Math.max(seg.start + 0.5, Math.min(next, seg.start + speechDur * 1.3));
    const span = end - seg.start;

    // Group wrapped lines into cues of up to two lines.
    const lines = wrapWords(text, MAX_LINE_CHARS);
    const groups: string[][] = [];
    for (let l = 0; l < lines.length; l += 2) groups.push(lines.slice(l, l + 2));

    const totalChars = groups.reduce((n, g) => n + g.join(' ').length, 0) || 1;
    let cursor = seg.start;
    groups.forEach((g) => {
      const share = (g.join(' ').length / totalChars) * span;
      cues.push({ start: cursor, end: cursor + share, text: g.join('\n') });
      cursor += share;
    });
  });

  return cues;
}

function pad(n: number, w = 2): string {
  return n.toString().padStart(w, '0');
}

export function formatCueTime(sec: number, sep: ',' | '.'): string {
  const ms = Math.round(Math.max(0, sec) * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(ms % 1000, 3)}`;
}

export function toSrt(doc: ExportDoc): string {
  return (
    buildCues(doc)
      .map((c, i) => `${i + 1}\n${formatCueTime(c.start, ',')} --> ${formatCueTime(c.end, ',')}\n${c.text}`)
      .join('\n\n') + '\n'
  );
}

export function toVtt(doc: ExportDoc): string {
  return (
    'WEBVTT\n\n' +
    buildCues(doc)
      .map((c) => `${formatCueTime(c.start, '.')} --> ${formatCueTime(c.end, '.')}\n${c.text}`)
      .join('\n\n') +
    '\n'
  );
}

// ---------------------------------------------------------------------------
// Word (.docx)
// ---------------------------------------------------------------------------

export async function toDocxBlob(doc: ExportDoc, opts: ExportOptions): Promise<Blob> {
  // Loaded on demand so the Word library stays out of the initial bundle.
  const { Document, Packer, Paragraph, TextRun, HeadingLevel } = await import('docx');

  const meta = [new Date(doc.date).toLocaleString(), doc.model].filter(Boolean).join('  ·  ');

  const children = [
    new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: doc.title })] }),
    new Paragraph({
      spacing: { after: 280 },
      children: [new TextRun({ text: meta, color: '777777', size: 18 })],
    }),
    ...doc.segments.map((s) => {
      const rtl = isMostlyRtl(s.text);
      const runs = [new TextRun({ text: `${speakerLabel(s.speaker, doc.speakerNames)}: `, bold: true, rightToLeft: rtl })];
      if (opts.timestamps) {
        runs.push(new TextRun({ text: `[${formatTimestamp(s.start)}] `, color: '888888', size: 18 }));
      }
      runs.push(new TextRun({ text: s.text, rightToLeft: rtl }));
      return new Paragraph({ spacing: { after: 160 }, bidirectional: rtl, children: runs });
    }),
  ];

  const document = new Document({
    creator: 'Audio Transcriber',
    title: doc.title,
    styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
    sections: [{ children }],
  });
  return Packer.toBlob(document);
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

export function safeFilename(title: string): string {
  const cleaned = title.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  return cleaned || 'transcript';
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function exportDoc(doc: ExportDoc, format: ExportFormat, opts: ExportOptions): Promise<void> {
  const base = safeFilename(doc.title);
  switch (format) {
    case 'docx':
      return downloadBlob(await toDocxBlob(doc, opts), `${base}.docx`);
    case 'srt':
      return downloadBlob(new Blob([toSrt(doc)], { type: 'application/x-subrip' }), `${base}.srt`);
    case 'vtt':
      return downloadBlob(new Blob([toVtt(doc)], { type: 'text/vtt' }), `${base}.vtt`);
    case 'md':
      return downloadBlob(new Blob([toMarkdownDoc(doc, opts)], { type: 'text/markdown' }), `${base}.md`);
    case 'json':
      return downloadBlob(new Blob([toJson(doc)], { type: 'application/json' }), `${base}.json`);
    default:
      return downloadBlob(new Blob([toTxt(doc, opts)], { type: 'text/plain' }), `${base}.txt`);
  }
}
