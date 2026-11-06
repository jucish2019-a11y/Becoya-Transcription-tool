import express, { NextFunction, Request, Response } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import { listUsableModels } from './server/models';
import {
  GenerateFn,
  GenerateResult,
  ParseError,
  RESPONSE_SCHEMA,
  RequestError,
  isRetryable,
  transcribeChunk,
  validateRequest,
} from './server/transcribe';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';

function createGenerate(ai: GoogleGenAI): GenerateFn {
  return async (p) => {
    async function executeWithModel(modelName: string): Promise<GenerateResult> {
      // ThinkingLevel.LOW eliminates deep reasoning pauses for models with thinking enabled (3.7 Flash only)
      const thinkingConfig =
        modelName === 'gemini-3.7-flash'
          ? { thinkingLevel: ThinkingLevel.LOW }
          : undefined;

      const callPromise = ai.models.generateContent({
        model: modelName,
        contents: [
          {
            role: 'user',
            parts: [{ inlineData: { mimeType: p.mimeType, data: p.base64Audio } }, { text: p.userText }],
          },
        ],
        config: {
          systemInstruction: p.systemInstruction,
          responseMimeType: 'application/json',
          responseSchema: RESPONSE_SCHEMA,
          maxOutputTokens: 8192,
          ...(thinkingConfig ? { thinkingConfig } : {}),
          ...(p.temperature !== undefined ? { temperature: p.temperature } : {}),
        },
      });

      // 18s timeout per model attempt to prevent hanging on demand spikes
      const timeoutMs = 18000;
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Model ${modelName} request timed out after 18s`)), timeoutMs)
      );

      const response = await Promise.race([callPromise, timeoutPromise]);
      return { text: response.text ?? '', finishReason: response.candidates?.[0]?.finishReason };
    }

    try {
      return await executeWithModel(p.model);
    } catch (err: any) {
      const status = err?.status ?? err?.code ?? err?.error?.code;
      const msg = String(err?.message ?? err).toLowerCase();
      const isDemandSpikeOrTimeoutOrQuota =
        status === 503 ||
        status === 429 ||
        status === 404 ||
        /timed? ?out|demand|unavailable|overloaded|resource_exhausted|not found|no longer available/.test(msg);

      if (isDemandSpikeOrTimeoutOrQuota && p.model !== 'gemini-3.1-flash-lite') {
        console.warn(
          `[Speed & Reliability Optimizer] Model ${p.model} encountered ${status || 'timeout/spike'}. Instantly failing over to gemini-3.1-flash-lite.`
        );
        return await executeWithModel('gemini-3.1-flash-lite');
      }
      throw err;
    }
  };
}

async function main() {
  const app = express();
  app.disable('x-powered-by');
  // Cloud Run rejects request bodies above 32 MB, so stay under that.
  app.use(express.json({ limit: '30mb' }));

  const apiKey = process.env.GEMINI_API_KEY;
  const ai = apiKey
    ? new GoogleGenAI({ apiKey, httpOptions: { headers: { 'User-Agent': 'aistudio-build' } } })
    : null;
  if (!ai) console.warn('GEMINI_API_KEY is not set: transcription requests will fail.');
  const generate = ai ? createGenerate(ai) : null;

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/api/models', async (_req, res) => {
    res.json(await listUsableModels(ai));
  });

  app.post('/api/transcribe', async (req: Request, res: Response) => {
    try {
      if (!generate) {
        return res.status(500).json({ error: 'The server has no GEMINI_API_KEY configured.' });
      }
      const parsed = validateRequest(req.body);
      const result = await transcribeChunk(generate, parsed);
      res.json(result);
    } catch (err: any) {
      if (err instanceof RequestError) {
        return res.status(err.status).json({ error: err.message });
      }
      console.error('Transcription error:', err?.message ?? err);
      // NGINX has error_page 502 503 504 configured to serve warmup.html; use 500 so JSON errors reach the client
      const status = typeof err?.status === 'number' && err.status === 429 ? 429 : 500;
      const message =
        err instanceof ParseError
          ? 'The model returned an unreadable response. Please retry this part.'
          : err?.message || 'Failed to transcribe audio.';
      res.status(status).json({ error: message, retryable: isRetryable(err) || err instanceof ParseError });
    }
  });

  app.post('/api/fix-speakers', async (req: Request, res: Response) => {
    try {
      if (!ai) {
        return res.status(500).json({ error: 'The server has no GEMINI_API_KEY configured.' });
      }
      const { segments, expectedSpeakers, speakerNames } = req.body ?? {};
      if (!Array.isArray(segments) || segments.length === 0) {
        return res.status(400).json({ error: 'Missing segments to fix.' });
      }

      const turnsText = segments
        .map((s: any, idx: number) => `Turn ${idx + 1} [id: ${s.id}] [${s.speaker}]: ${s.text}`)
        .join('\n');

      const prompt = [
        'Analyze the dialogue turns below where speaker labels may have been mixed up or swapped across parts.',
        'Evaluate the conversational flow (question vs answer, topics, introductions, references, turn-taking).',
        expectedSpeakers ? `There are about ${expectedSpeakers} speaker(s) in this conversation.` : '',
        speakerNames && Object.keys(speakerNames).length > 0
          ? `Known speaker names: ${JSON.stringify(speakerNames)}`
          : '',
        'Assign each turn to the correct speaker label (e.g. "Speaker 1", "Speaker 2").',
        'Output a correction entry for EVERY segment ID provided.',
        '',
        turnsText,
      ]
        .filter(Boolean)
        .join('\n\n');

      const response = await ai.models.generateContent({
        model: 'gemini-3.1-flash-lite',
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config: {
          systemInstruction:
            'You are an expert dialogue editor. You align and untangle mixed up speaker turns in conversation transcripts based on dialogue flow, questions/answers, and topic coherence. Output the corrected speaker label for every segment ID without omitting any.',
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              corrections: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    id: { type: Type.STRING },
                    speaker: { type: Type.STRING },
                  },
                  required: ['id', 'speaker'],
                },
              },
            },
            required: ['corrections'],
          },
        },
      });

      const parsed = JSON.parse(response.text || '{}');
      const corrections = Array.isArray(parsed?.corrections) ? parsed.corrections : [];
      res.json({ corrections });
    } catch (err: any) {
      console.error('Fix speakers error:', err?.message ?? err);
      res.status(500).json({ error: err?.message || 'Failed to untangle speakers.' });
    }
  });

  if (IS_PROD) {
    const dist = path.join(__dirname, 'dist');
    app.use(express.static(dist, { index: false, maxAge: '1h' }));
    app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({ server: { middlewareMode: true } });
    app.use(vite.middlewares);
  }

  // JSON errors (for example an oversized body) instead of Express's HTML page.
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    if (err?.type === 'entity.too.large') {
      return res.status(413).json({ error: 'This audio part is too large to upload. Try a shorter file.' });
    }
    if (err?.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'Request body is not valid JSON.' });
    }
    console.error('Unhandled error:', err?.message ?? err);
    res.status(500).json({ error: 'Internal server error.' });
  });

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT} (${IS_PROD ? 'production' : 'development'})`);
  });
}

main();
