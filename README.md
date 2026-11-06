# Audio Transcriber

Record or upload audio and get a **speaker-labelled transcript** you can edit, rename and export. Built with React + Express and the Gemini API.

## Features

- **Speaker-labelled turns with timestamps**, returned by the model as structured JSON (no fragile text parsing).
- **Consistent speakers across a long recording.** Each audio part is told which speakers were already identified and how the previous part ended.
- **No split words.** Long files are cut at the quietest moment near each part boundary, not at a fixed second.
- **Honest quality checks** instead of a made-up score: words-per-minute sanity, repetition loops, truncated output and unreliable timestamps are flagged per part, each with a *Retry part* button.
- **Editing:** click any turn to fix the text, reassign a turn to another speaker, rename speakers globally, find & replace, and remove fillers/stutters (with Undo).
- **Click a timestamp to play from there**, and the current turn highlights while audio plays.
- **Export:** Word (`.docx`, Arabic/RTL aware), SubRip (`.srt`), WebVTT (`.vtt`), plain text, Markdown, JSON.
- **Hints that improve accuracy:** language (auto / English / French / Arabic), number of speakers, and a custom vocabulary for names and acronyms.
- Pause / resume, and resume from the failed part after an error.
- Transcripts saved by the previous version are migrated automatically (timestamps are only known per part for those, marked `~`).

## Run locally

```bash
npm install
cp .env.example .env      # then put your key in GEMINI_API_KEY
npm run dev               # http://localhost:3000
```

| Script | What it does |
| --- | --- |
| `npm run dev` | Express + Vite dev middleware |
| `npm run build` | Production build into `dist/` |
| `npm start` | Production server (serves `dist/`, listens on `$PORT`) |
| `npm run lint` | Type check |
| `npm test` | Unit + component tests (Vitest) |

## Deploy to Cloud Run

The server reads `PORT` and serves the built app, and the `Dockerfile` builds both.

```bash
# store the key once
printf '%s' "YOUR_KEY" | gcloud secrets create gemini-api-key --data-file=-

gcloud run deploy audio-transcriber \
  --source . \
  --region YOUR_REGION \
  --set-secrets GEMINI_API_KEY=gemini-api-key:latest \
  --no-allow-unauthenticated
```

**Security:** the app has no login of its own, and anyone who can reach it can spend your Gemini quota and send audio through it. Keep `--no-allow-unauthenticated` and put it behind Identity-Aware Proxy (or access it with `gcloud run services proxy audio-transcriber`). Don't make it public as-is.

The API key is read only by the server at runtime. It is never included in the browser bundle.

## How accuracy is handled

1. The browser decodes the file at 16 kHz (so hour-long recordings do not exhaust memory), finds quiet points, and re-encodes each part as mono 16 kHz WAV.
2. Each part is sent to `/api/transcribe` with the language, speaker count, vocabulary, the speakers identified so far and the last few turns of the previous part.
3. The model must answer with a JSON schema (`speaker`, `start`, `text`). The server validates it, retries malformed output once, repairs bad timestamps, and runs the quality checks.
4. Speaker ids are always `Speaker N`, so they stay stable between parts; give them real names afterwards with **Speakers**.

## Models, speed and reliability

- **Default: Gemini 3.8 Flash**, called with low "thinking" (the default thinking depth adds many seconds and does nothing for transcription). `gemini-3.7-flash` and `gemini-3.5-flash` are deprecated aliases that Google routes to 3.8 and 3.6 Flash, so they are not offered but still work for old transcripts.
- Which models appear in the dropdown comes from `src/shared/models.ts`, filtered at runtime against `models.list()` for your API key, so an unavailable model is hidden instead of failing every request.
- **Time budget.** One request may take at most `GEMINI_BUDGET_MS` (default 50 s) so it ends before a proxy gives up. The selected model gets `GEMINI_TIMEOUT_MS` (default 35 s); if it is slow or overloaded, the call is **cancelled** and a single attempt is made on Gemini 3.1 Flash-Lite with the time left.
- **A swap is never silent.** If Flash-Lite had to step in, that part is flagged ("Retry part" re-runs it on the model you chose) and the response says which model produced it.
- **Automatic retries.** If a part fails for a temporary reason (busy model, timeout, network drop, or a proxy error page), the browser retries it twice (after 2 s and 5 s) before stopping. Pause and Cancel work during the wait; "Continue" resumes from the failed part.
- **Gemini 3.5 Transcribe** is a dedicated speech-to-text model that uses a different Google API (Interactions with `transcriptionConfig`), with its own `spk_N` speaker labels and no prompt, so it is not offered yet.

## Limits

- Cloud Run rejects request bodies over 32 MB. Parts are ~10 MB, but if a file cannot be decoded in the browser it is uploaded as-is and may be too large.
- The audio player and *Retry part* are available for transcriptions made in the current browser session (the audio is not stored).
- Transcripts live in the browser's `localStorage` (about 5 MB). Export or delete old ones if the app warns that storage is full.
- **Suggest speaker fixes** reads the text only (it cannot hear the audio), so it can only catch mix-ups that the conversation itself reveals. It never invents new speakers, changes nothing you have not been told about, and can be undone.
- Speaker separation and timestamps come from the model and are not perfect: review flagged parts, and use the speaker count hint for tricky recordings.
