import express, { NextFunction, Request, Response } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';
import {
  buildFixPrompt,
  FIX_SCHEMA,
  sanitizeCorrections,
  validateFixRequest,
} from './server/fixSpeakers';
import { createGenerate, defaultFailoverOptions, runWithFailover, thinkingConfigFor } from './server/generate';
import { listUsableModels } from './server/models';
import {
  ParseError,
  RequestError,
  UpstreamTimeoutError,
  isRetryable,
  transcribeChunk,
  validateRequest,
} from './server/transcribe';
import { modelLabel } from './src/shared/models';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';

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
      // The hosting proxy replaces 502/503/504 with an HTML warm-up page, so send errors as 500 (or 429)
      // with a JSON body the client can read.
      const status = typeof err?.status === 'number' && err.status === 429 ? 429 : 500;
      let message: string;
      let retryable: boolean;
      if (err instanceof UpstreamTimeoutError) {
        message = `${modelLabel(err.model)} did not answer in time. Retrying usually works.`;
        retryable = true;
      } else if (err instanceof ParseError) {
        message = 'The model returned an unreadable response. Please retry this part.';
        retryable = true;
      } else {
        message = err?.message || 'Failed to transcribe audio.';
        retryable = isRetryable(err);
      }
      res.status(status).json({ error: message, retryable });
    }
  });

  app.post('/api/fix-speakers', async (req: Request, res: Response) => {
    try {
      if (!ai) return res.status(500).json({ error: 'The server has no GEMINI_API_KEY configured.' });
      const fix = validateFixRequest(req.body);
      const { systemInstruction, prompt } = buildFixPrompt(fix);

      const { value } = await runWithFailover(
        fix.model,
        async (model, signal) => {
          const response = await ai.models.generateContent({
            model,
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            config: {
              abortSignal: signal,
              systemInstruction,
              responseMimeType: 'application/json',
              responseSchema: FIX_SCHEMA,
              maxOutputTokens: 8192,
              ...thinkingConfigFor(model),
            },
          });
          return response.text ?? '';
        },
        defaultFailoverOptions()
      );

      res.json({ corrections: sanitizeCorrections(value, fix) });
    } catch (err: any) {
      if (err instanceof RequestError) return res.status(err.status).json({ error: err.message });
      console.error('Fix speakers error:', err?.message ?? err);
      const message =
        err instanceof UpstreamTimeoutError
          ? 'The speaker check took too long. Please try again.'
          : err?.message || 'Failed to check speakers.';
      res.status(500).json({ error: message });
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
