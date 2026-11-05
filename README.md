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
3. The model must answer with a JSON schema (`speaker`, `start`, `text`). The server validates it, retries on rate limits and malformed output, repairs bad timestamps, and runs the quality checks.
4. Speaker ids are always `Speaker N`, so they stay stable between parts; give them real names afterwards with **Speakers**.

Which models appear in the dropdown comes from `src/shared/models.ts`, filtered at runtime against `models.list()` for your API key, so an unavailable model is hidden instead of failing every request.

## Limits

- Cloud Run rejects request bodies over 32 MB. Parts are ~10 MB, but if a file cannot be decoded in the browser it is uploaded as-is and may be too large.
- The audio player and *Retry part* are available for transcriptions made in the current browser session (the audio is not stored).
- Transcripts live in the browser's `localStorage` (about 5 MB). Export or delete old ones if the app warns that storage is full.
- Speaker separation and timestamps come from the model and are not perfect: review flagged parts, and use the speaker count hint for tricky recordings.
