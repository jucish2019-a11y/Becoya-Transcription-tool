/**
 * Audio chunking utility for handling long audio files and preventing token limit errors.
 * Splits audio using the browser Web Audio API, downmixing to mono and resampling to 16kHz WAV.
 */

export interface AudioChunk {
  blob: Blob;
  mimeType: string;
  startTimeSec: number;
  endTimeSec: number;
  index: number;
  total: number;
}

/**
 * Splits an audio blob into manageable chunks (default 8 minutes / 480 seconds)
 * encoded as mono 16kHz WAV, which is universally compatible and token-efficient.
 * If decoding fails (e.g., unsupported format), returns the original blob as a fallback.
 */
export async function chunkAudioIfNeeded(
  audioBlob: Blob,
  mimeType: string,
  maxChunkDurationSec = 300
): Promise<AudioChunk[]> {
  const AudioContextClass =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;

  if (!AudioContextClass) {
    return [{ blob: audioBlob, mimeType, startTimeSec: 0, endTimeSec: 0, index: 0, total: 1 }];
  }

  try {
    const arrayBuffer = await audioBlob.arrayBuffer();
    const audioCtx = new AudioContextClass();

    let audioBuffer: AudioBuffer;
    try {
      // arrayBuffer.slice(0) to prevent ArrayBuffer detachment issues in some browsers
      audioBuffer = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
    } finally {
      if (audioCtx.state !== 'closed') {
        await audioCtx.close();
      }
    }

    const duration = audioBuffer.duration;

    // If duration is within the safe limit
    if (duration <= maxChunkDurationSec) {
      // If duration is longer than 5 minutes or the file size is large, converting to mono 16kHz WAV
      // saves significant tokens and upload bandwidth
      if (duration > 300 || audioBlob.size > 15 * 1024 * 1024) {
        const wavBlob = audioBufferToWavBlob(audioBuffer, 0, duration, 16000);
        return [{
          blob: wavBlob,
          mimeType: 'audio/wav',
          startTimeSec: 0,
          endTimeSec: duration,
          index: 0,
          total: 1,
        }];
      }

      return [{
        blob: audioBlob,
        mimeType,
        startTimeSec: 0,
        endTimeSec: duration,
        index: 0,
        total: 1,
      }];
    }

    // Split into chunks of maxChunkDurationSec
    const chunks: AudioChunk[] = [];
    const totalChunks = Math.ceil(duration / maxChunkDurationSec);

    for (let i = 0; i < totalChunks; i++) {
      const startSec = i * maxChunkDurationSec;
      const endSec = Math.min((i + 1) * maxChunkDurationSec, duration);
      const chunkWavBlob = audioBufferToWavBlob(audioBuffer, startSec, endSec, 16000);

      chunks.push({
        blob: chunkWavBlob,
        mimeType: 'audio/wav',
        startTimeSec: startSec,
        endTimeSec: endSec,
        index: i,
        total: totalChunks,
      });
    }

    return chunks;
  } catch (decodeErr) {
    console.warn("Could not decode audio with Web Audio API, using direct upload:", decodeErr);
    return [{ blob: audioBlob, mimeType, startTimeSec: 0, endTimeSec: 0, index: 0, total: 1 }];
  }
}

/**
 * Converts an AudioBuffer slice into a 16-bit PCM mono WAV blob.
 * Downmixing to mono and resampling to 16kHz drastically reduces token counts and upload payload.
 */
function audioBufferToWavBlob(
  audioBuffer: AudioBuffer,
  startSec: number,
  endSec: number,
  targetSampleRate = 16000
): Blob {
  const srcSampleRate = audioBuffer.sampleRate;
  const startSample = Math.floor(startSec * srcSampleRate);
  const endSample = Math.min(Math.floor(endSec * srcSampleRate), audioBuffer.length);
  const srcLength = endSample - startSample;

  if (srcLength <= 0) {
    return new Blob([], { type: 'audio/wav' });
  }

  // Downmix to mono float array
  const numChannels = audioBuffer.numberOfChannels;
  const monoSamples = new Float32Array(srcLength);
  for (let c = 0; c < numChannels; c++) {
    const channelData = audioBuffer.getChannelData(c);
    for (let i = 0; i < srcLength; i++) {
      monoSamples[i] += channelData[startSample + i] / numChannels;
    }
  }

  // Resample to targetSampleRate if specified and different
  let finalSamples = monoSamples;
  let finalSampleRate = srcSampleRate;

  if (targetSampleRate && srcSampleRate !== targetSampleRate) {
    const ratio = srcSampleRate / targetSampleRate;
    const targetLength = Math.round(srcLength / ratio);
    const resampled = new Float32Array(targetLength);
    for (let i = 0; i < targetLength; i++) {
      const srcIdx = i * ratio;
      const i1 = Math.floor(srcIdx);
      const i2 = Math.min(i1 + 1, srcLength - 1);
      const frac = srcIdx - i1;
      resampled[i] = monoSamples[i1] * (1 - frac) + monoSamples[i2] * frac;
    }
    finalSamples = resampled;
    finalSampleRate = targetSampleRate;
  }

  const length = finalSamples.length;
  const wavBuffer = new ArrayBuffer(44 + length * 2);
  const view = new DataView(wavBuffer);

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  // RIFF header
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + length * 2, true);
  writeString(8, 'WAVE');

  // fmt subchunk
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true); // Subchunk1Size (16 for PCM)
  view.setUint16(20, 1, true); // AudioFormat (1 = PCM)
  view.setUint16(22, 1, true); // NumChannels (1 = mono)
  view.setUint32(24, finalSampleRate, true); // SampleRate
  view.setUint32(28, finalSampleRate * 2, true); // ByteRate (sampleRate * 1 * 2)
  view.setUint16(32, 2, true); // BlockAlign (1 * 2)
  view.setUint16(34, 16, true); // BitsPerSample (16-bit)

  // data subchunk
  writeString(36, 'data');
  view.setUint32(40, length * 2, true);

  // Write PCM samples
  let offset = 44;
  for (let i = 0; i < length; i++) {
    const s = Math.max(-1, Math.min(1, finalSamples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    offset += 2;
  }

  return new Blob([wavBuffer], { type: 'audio/wav' });
}

export function formatSecondsToTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}
