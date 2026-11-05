/**
 * Audio chunking for long recordings.
 *
 * - Decodes at 16 kHz so a 1-hour stereo file needs ~460 MB instead of ~1.4 GB.
 * - Cuts at the quietest point near each target boundary, so words are not split
 *   mid-syllable (the old fixed-interval cut did exactly that).
 * - Always re-encodes to mono 16 kHz WAV, a format Gemini accepts everywhere.
 */

export { formatTimestamp as formatSecondsToTime } from '../shared/transcript';

export interface AudioChunk {
  blob: Blob;
  mimeType: string;
  startTimeSec: number;
  endTimeSec: number;
  index: number;
  total: number;
}

export interface ChunkResult {
  chunks: AudioChunk[];
  /** 0 when the file could not be decoded and was sent as-is. */
  durationSec: number;
}

const TARGET_SAMPLE_RATE = 16000;
const FRAME_SEC = 0.1;
/** Do not bother splitting if the file is only slightly longer than one chunk. */
const SPLIT_TOLERANCE = 1.15;

// ---------------------------------------------------------------------------
// Pure helpers (unit tested)
// ---------------------------------------------------------------------------

/** Mean-square energy per frame, averaged across channels. */
export function computeFrameEnergies(
  channels: Float32Array[],
  sampleRate: number,
  frameSec = FRAME_SEC
): Float32Array {
  const length = channels[0]?.length ?? 0;
  const frameSize = Math.max(1, Math.round(sampleRate * frameSec));
  const frames = Math.ceil(length / frameSize);
  const energies = new Float32Array(frames);

  for (const ch of channels) {
    for (let f = 0; f < frames; f++) {
      const start = f * frameSize;
      const end = Math.min(start + frameSize, length);
      let sum = 0;
      for (let i = start; i < end; i++) sum += ch[i] * ch[i];
      energies[f] += sum / Math.max(1, end - start) / channels.length;
    }
  }
  return energies;
}

/**
 * Chooses split times (seconds) near multiples of `targetSec`, each at the
 * quietest ~0.5 s stretch within +/- `searchSec` of the ideal point.
 */
export function findSplitPoints(
  energies: Float32Array,
  targetSec: number,
  searchSec = 20,
  frameSec = FRAME_SEC
): number[] {
  const duration = energies.length * frameSec;
  const points: number[] = [];
  const smoothFrames = 5;

  let cursor = 0;
  while (duration - cursor > targetSec * SPLIT_TOLERANCE) {
    const ideal = cursor + targetSec;
    const lo = Math.max(cursor + targetSec * 0.5, ideal - searchSec);
    const hi = Math.min(duration - 5, ideal + searchSec);

    let best = ideal;
    if (hi > lo) {
      const first = Math.floor(lo / frameSec);
      const last = Math.floor(hi / frameSec) - smoothFrames;
      let bestScore = Infinity;
      for (let f = first; f <= last; f++) {
        let score = 0;
        for (let k = 0; k < smoothFrames; k++) score += energies[f + k];
        // Slightly prefer points close to the ideal so chunks stay evenly sized.
        score *= 1 + Math.abs((f + smoothFrames / 2) * frameSec - ideal) / (searchSec * 40);
        if (score < bestScore) {
          bestScore = score;
          best = (f + smoothFrames / 2) * frameSec;
        }
      }
    }
    points.push(best);
    cursor = best;
  }
  return points;
}

/** Splits [0, duration] at the given points into [start, end] ranges. */
export function pointsToRanges(points: number[], duration: number): Array<[number, number]> {
  const edges = [0, ...points, duration];
  const ranges: Array<[number, number]> = [];
  for (let i = 0; i < edges.length - 1; i++) ranges.push([edges[i], edges[i + 1]]);
  return ranges;
}

// ---------------------------------------------------------------------------
// WAV encoding
// ---------------------------------------------------------------------------

function encodeWavMono(audioBuffer: AudioBuffer, startSec: number, endSec: number): Blob {
  const srcRate = audioBuffer.sampleRate;
  const startSample = Math.max(0, Math.floor(startSec * srcRate));
  const endSample = Math.min(audioBuffer.length, Math.floor(endSec * srcRate));
  const srcLength = endSample - startSample;
  if (srcLength <= 0) return new Blob([], { type: 'audio/wav' });

  const channels = audioBuffer.numberOfChannels;
  const mono = new Float32Array(srcLength);
  for (let c = 0; c < channels; c++) {
    const data = audioBuffer.getChannelData(c);
    for (let i = 0; i < srcLength; i++) mono[i] += data[startSample + i] / channels;
  }

  // Only needed when the browser ignored the requested 16 kHz context rate.
  let samples = mono;
  let rate = srcRate;
  if (srcRate !== TARGET_SAMPLE_RATE) {
    const ratio = srcRate / TARGET_SAMPLE_RATE;
    const outLength = Math.round(srcLength / ratio);
    const resampled = new Float32Array(outLength);
    for (let i = 0; i < outLength; i++) {
      const pos = i * ratio;
      const i1 = Math.floor(pos);
      const i2 = Math.min(i1 + 1, srcLength - 1);
      const frac = pos - i1;
      resampled[i] = mono[i1] * (1 - frac) + mono[i2] * frac;
    }
    samples = resampled;
    rate = TARGET_SAMPLE_RATE;
  }

  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, samples.length * 2, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

// ---------------------------------------------------------------------------
// Decoding + public API
// ---------------------------------------------------------------------------

async function decodeAudio(blob: Blob): Promise<AudioBuffer> {
  const Ctx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) throw new Error('Web Audio API is not available in this browser.');

  const data = await blob.arrayBuffer();
  let ctx: AudioContext;
  try {
    // Decoding straight to 16 kHz keeps memory low for long recordings.
    ctx = new Ctx({ sampleRate: TARGET_SAMPLE_RATE });
  } catch {
    ctx = new Ctx();
  }
  try {
    return await ctx.decodeAudioData(data.slice(0));
  } finally {
    if (ctx.state !== 'closed') await ctx.close();
  }
}

/** Strips codec parameters ("audio/webm;codecs=opus" -> "audio/webm"). */
export function baseMimeType(mime: string): string {
  return (mime || '').split(';')[0].trim().toLowerCase() || 'audio/mpeg';
}

export async function chunkAudio(
  audioBlob: Blob,
  mimeType: string,
  targetChunkSec = 300
): Promise<ChunkResult> {
  let audioBuffer: AudioBuffer;
  try {
    audioBuffer = await decodeAudio(audioBlob);
  } catch (err) {
    console.warn('Could not decode audio in the browser; uploading the original file.', err);
    return {
      chunks: [
        { blob: audioBlob, mimeType: baseMimeType(mimeType), startTimeSec: 0, endTimeSec: 0, index: 0, total: 1 },
      ],
      durationSec: 0,
    };
  }

  const duration = audioBuffer.duration;
  const channels: Float32Array[] = [];
  for (let c = 0; c < audioBuffer.numberOfChannels; c++) channels.push(audioBuffer.getChannelData(c));

  const energies = computeFrameEnergies(channels, audioBuffer.sampleRate);
  const ranges = pointsToRanges(findSplitPoints(energies, targetChunkSec), duration);

  const chunks: AudioChunk[] = ranges.map(([start, end], index) => ({
    blob: encodeWavMono(audioBuffer, start, end),
    mimeType: 'audio/wav',
    startTimeSec: start,
    endTimeSec: end,
    index,
    total: ranges.length,
  }));

  return { chunks, durationSec: duration };
}
