import { Type } from '@google/genai';
import { ALLOWED_MODEL_IDS, DEFAULT_MODEL_ID } from '../src/shared/models';
import { normalizeSpeaker } from '../src/shared/transcript';
import { RequestError } from './transcribe';

const MAX_TURNS = 1200;
const MAX_TEXT_CHARS = 400;

export interface FixTurn {
  id: string;
  speaker: string;
  text: string;
}

export interface FixRequest {
  turns: FixTurn[];
  /** Speaker ids that exist in the transcript; the model may only use these. */
  labels: string[];
  model: string;
  speakerNames: Record<string, string>;
}

export function validateFixRequest(body: any): FixRequest {
  const raw = body?.segments;
  if (!Array.isArray(raw) || raw.length === 0) throw new RequestError('There is no transcript to check.');
  if (raw.length > MAX_TURNS) {
    throw new RequestError(`This transcript has ${raw.length} turns; the speaker check supports up to ${MAX_TURNS}.`);
  }

  const turns: FixTurn[] = [];
  for (const s of raw) {
    if (!s || typeof s.id !== 'string' || typeof s.text !== 'string') continue;
    turns.push({ id: s.id, speaker: normalizeSpeaker(s.speaker), text: s.text.slice(0, MAX_TEXT_CHARS) });
  }
  if (turns.length === 0) throw new RequestError('There is no transcript to check.');

  const labels = [...new Set(turns.map((t) => t.speaker))];
  const names: Record<string, string> = {};
  if (body.speakerNames && typeof body.speakerNames === 'object' && !Array.isArray(body.speakerNames)) {
    for (const [k, v] of Object.entries(body.speakerNames)) {
      if (typeof v === 'string' && v.trim()) names[normalizeSpeaker(k)] = v.trim().slice(0, 60);
    }
  }

  const model = typeof body.model === 'string' && ALLOWED_MODEL_IDS.has(body.model) ? body.model : DEFAULT_MODEL_ID;
  return { turns, labels, model, speakerNames: names };
}

export function buildFixPrompt(req: FixRequest): { systemInstruction: string; prompt: string } {
  const systemInstruction = [
    'You review dialogue transcripts where speaker labels may have been mixed up between parts of a long recording.',
    'You can only read the text; you cannot hear the audio. Work from conversational flow: who asks and who answers, who introduces whom, references to earlier turns, and consistent roles.',
    'Be conservative. Only propose a change when the text clearly shows a turn belongs to a different speaker. If unsure, leave it alone.',
    'Return ONLY the turns whose label should change. Return an empty list if nothing is clearly wrong.',
  ].join('\n');

  const known = Object.entries(req.speakerNames).map(([id, n]) => `${id} = ${n}`);
  const lines = req.turns.map((t, i) => `${i + 1} [${t.speaker}]: ${t.text}`);
  const prompt = [
    `Allowed speaker labels: ${req.labels.join(', ')}. Do not invent any other label.`,
    known.length ? `Known speaker names: ${known.join('; ')}.` : '',
    'Turns (number [current label]: text):',
    lines.join('\n'),
  ]
    .filter(Boolean)
    .join('\n\n');
  return { systemInstruction, prompt };
}

export const FIX_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    corrections: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          turn: { type: Type.INTEGER, description: 'The turn number from the list.' },
          speaker: { type: Type.STRING, description: 'The corrected speaker label.' },
        },
        required: ['turn', 'speaker'],
      },
    },
  },
  required: ['corrections'],
};

/** Keeps only valid proposals: a real turn, an existing label, and an actual change. */
export function sanitizeCorrections(
  rawText: string,
  req: FixRequest
): Array<{ id: string; speaker: string }> {
  let data: any;
  try {
    data = JSON.parse(rawText || '{}');
  } catch {
    throw new RequestError('The model returned an unreadable answer. Please try again.', 502);
  }
  const list = Array.isArray(data?.corrections) ? data.corrections : [];
  const labels = new Set(req.labels);
  const seen = new Set<number>();
  const out: Array<{ id: string; speaker: string }> = [];

  for (const c of list) {
    const turn = Number(c?.turn);
    if (!Number.isInteger(turn) || turn < 1 || turn > req.turns.length || seen.has(turn)) continue;
    const speaker = normalizeSpeaker(c?.speaker);
    const current = req.turns[turn - 1];
    if (!labels.has(speaker) || speaker === current.speaker) continue;
    seen.add(turn);
    out.push({ id: current.id, speaker });
  }
  return out;
}
