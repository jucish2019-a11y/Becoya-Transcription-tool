import express from 'express';
import { GoogleGenAI } from '@google/genai';
import { createServer as createViteServer } from 'vite';

async function createServer() {
  const app = express();
  app.use(express.json({ limit: '50mb' }));

  const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });

  function countWords(str: string): number {
    if (!str) return 0;
    return str.trim().split(/\s+/).filter(Boolean).length;
  }

  function cleanTranscriptOutput(rawText: string): string {
    if (!rawText) return '';
    let text = rawText.trim();

    // Strip common conversational preamble prefixes from generative models
    const preambleRegex = /^(here (is|are) (the|your)? (verbatim )?(audio )?transcript(ion)?( of the audio| below)?:\s*|sure, here is the transcript(ion)?:\s*|transcript:\s*)/i;
    text = text.replace(preambleRegex, '');

    // Strip trailing conversational sign-offs only if they appear on their own at the very end
    const trailerRegex = /(\n\s*(let me know if you need (anything else|further edits|any changes)|hope this helps!|end of (transcript|audio|recording))\s*)$/i;
    text = text.replace(trailerRegex, '');

    // Strip wrapping markdown code blocks if the model enclosed the whole transcript in ```markdown ... ```
    if (text.startsWith('```markdown') && text.endsWith('```')) {
      text = text.slice(11, -3).trim();
    } else if (text.startsWith('```') && text.endsWith('```')) {
      text = text.slice(3, -3).trim();
    }

    return text.trim();
  }

  function formatSpeakerTags(text: string): string {
    if (!text) return '';
    let formatted = text;

    // Pattern matching common speaker designations (bold or unbolded)
    const speakerNamesPattern = '(?:Speaker\\s*\\d+|Moderator|Stakeholder|Interviewer|Interviewee|Host|Guest|Participant\\s*\\d*|Attendee\\s*\\d*|[A-Z][a-z]+(?:\\s+[A-Z][a-z]+)?)';

    // 1. Separate inline bold speaker tags if merged on the same line (e.g. "...sentence. **Speaker 2:** ...")
    const inlineBoldSpeaker = new RegExp(`([^\\n])\\s+(\\*\\*${speakerNamesPattern}:\\*\\*)`, 'g');
    formatted = formatted.replace(inlineBoldSpeaker, '$1\n\n$2');

    // 2. Separate inline unbolded speaker tags if merged on the same line (e.g. "...sentence. Speaker 2: ...")
    const inlinePlainSpeaker = new RegExp(`([^\\n])\\s+(${speakerNamesPattern}:)(?!\\*)`, 'g');
    formatted = formatted.replace(inlinePlainSpeaker, '$1\n\n**$2**');

    // 3. Ensure any speaker tags at start of lines or paragraphs are bolded
    const lineStartSpeaker = new RegExp(`(^|\\n)(${speakerNamesPattern}:)(?!\\*)`, 'gm');
    formatted = formatted.replace(lineStartSpeaker, (match, prefix, speaker) => {
      return `${prefix}**${speaker.trim()}**`;
    });

    // 4. Normalize excessive newlines
    formatted = formatted.replace(/\n{3,}/g, '\n\n');

    return formatted;
  }

  function stripAllTimestamps(text: string): string {
    if (!text) return '';
    return text
      // 1. Remove markdown header timestamps e.g. "### [00:00 - 02:00]" or "## [00:15]"
      .replace(/#{1,6}\s*\[?\s*\d{1,2}:\d{2}(?::\d{2})?(?:\s*-\s*\d{1,2}:\d{2}(?::\d{2})?)?\s*\]?[^\n]*\n*/gi, '')
      // 2. Remove standalone timestamp lines
      .replace(/(?:^|\n)\s*\[?\s*\d{1,2}:\d{2}(?::\d{2})?(?:\s*-\s*\d{1,2}:\d{2}(?::\d{2})?)?\s*\]?\s*(?:\n|$)/gm, '\n')
      // 3. Remove inline bracketed timestamps e.g. [00:15] or [00:15 - 01:30]
      .replace(/\[\s*\d{1,2}:\d{2}(?::\d{2})?(?:\s*-\s*\d{1,2}:\d{2}(?::\d{2})?)?\s*\]/g, '')
      // 4. Remove inline parenthesized timestamps e.g. (00:15)
      .replace(/\(\s*\d{1,2}:\d{2}(?::\d{2})?(?:\s*-\s*\d{1,2}:\d{2}(?::\d{2})?)?\s*\)/g, '')
      // 5. Clean up extra punctuation spacing left after timestamp removal
      .replace(/\s+([.,!?;:])/g, '$1')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // Deterministic safe regex-based sanitization that removes fillers, stutters, sound tags and all timestamps
  // while strictly preserving 100% of all substantive sentences, speaker turns, and word length
  function regexSanitize(text: string): string {
    if (!text) return '';
    let sanitized = text;

    // 1. Remove all timestamps (section headers and inline timestamps)
    sanitized = stripAllTimestamps(sanitized);

    // 2. Remove bracketed acoustic sounds, e.g. [cough], (laughter), [applause], [clears throat], etc.
    sanitized = sanitized.replace(/\[\s*(?:cough|laughter|laughing|applause|clears throat|music|silence|sigh|groan|chuckle)\s*\]/gi, '');
    sanitized = sanitized.replace(/\(\s*(?:cough|laughter|laughing|applause|clears throat|music|silence|sigh|groan|chuckle)\s*\)/gi, '');

    // 3. Remove common vocal disfluencies (Uh, Um, Ah, Er)
    sanitized = sanitized.replace(/\b(uh|um|er|ah)\b,?\s*/gi, '');

    // 4. Remove immediate stutters / word duplications like "I I", "the the", "we we"
    sanitized = sanitized.replace(/\b([a-zA-Z]{1,8})\s+\1\b/gi, '$1');
    sanitized = sanitized.replace(/\b([a-zA-Z]{1,8})-\s*\1\b/gi, '$1');

    // 5. Clean up duplicate spaces or dangling commas
    sanitized = sanitized.replace(/[ \t]+,/g, ',');
    sanitized = sanitized.replace(/,,+/g, ',');
    sanitized = sanitized.replace(/[ \t]{2,}/g, ' ');

    // 6. Capitalize first letter after speaker tag or sentence end if filler was removed at the start
    sanitized = sanitized.replace(/(\*\*[^*]+:\*\*\s*)([a-z])/g, (_, p1, p2) => p1 + p2.toUpperCase());
    sanitized = sanitized.replace(/([.!?]\s+)([a-z])/g, (_, p1, p2) => p1 + p2.toUpperCase());

    return formatSpeakerTags(sanitized.trim());
  }

  app.post('/api/transcribe', async (req, res) => {
    const { base64Audio, mimeType, prompt, model, style } = req.body;
    try {
      const isLite = model === 'gemini-3.1-flash-lite';

      // Specialized system instruction for high-fidelity verbatim transcription & acoustic speaker separation
      const systemInstruction = isLite
        ? `You are an elite acoustic voice recognition and verbatim speaker diarization engine.
Your primary objective is to listen closely to different human voices in the audio, accurately distinguish each speaker, and produce a flawless verbatim transcript where speakers are NEVER mixed.

CRITICAL VOICE RECOGNITION & SPEAKER DIARIZATION RULES:
1. ACOUSTIC VOICE SEPARATION:
   - Carefully analyze vocal pitch, resonance, timbre, cadence, and tone to separate distinct individuals.
   - Do NOT assume there are only two speakers unless only two distinct voices speak.
   - If multiple people speak, distinguish each unique voice accurately.

2. ZERO SPEAKER MIXING (STRICT ISOLATION):
   - NEVER combine speech from different speakers into the same sentence or paragraph.
   - The MOMENT a speaker stops and another speaker speaks, IMMEDIATELY break to a new line and label the new speaker.
   - Do NOT attribute Speaker B's reply to Speaker A, and do NOT attribute Speaker A's question to Speaker B. Each speaker must strictly only be credited with what they actually uttered.

3. PRECISE SPEAKER LABELS (BOLD):
   - If speakers introduce themselves or are addressed by name (e.g. Alex, Sarah, Dr. Smith), use their name in bold: **Alex:**, **Sarah:**, **Dr. Smith:**.
   - If specific conversation roles are clearly established, you may use **Moderator:**, **Stakeholder:**, **Interviewer:**, **Interviewee:**, **Host:**, **Guest:**.
   - Otherwise, label distinct voices consistently as **Speaker 1:**, **Speaker 2:**, **Speaker 3:**, etc.
   - Maintain the same speaker ID for the same voice throughout this audio segment. Never flip identities.

4. 100% VERBATIM CONTENT:
   - Capture every single word spoken. Do not summarize, omit, condense, or alter any substantive speech.
   - Accurately punctuate sentences based on natural vocal pauses.

5. CLEAN OUTPUT ONLY:
   - Output ONLY the formatted verbatim transcript. Never include conversational preambles (e.g. "Here is the transcript:"), notes, or sign-offs.`
        : `You are an expert audio transcription specialist. Transcribe all audio accurately, completely, and verbatim with clear speaker attribution and formatting. Output only the transcript without conversational pleasantries.`;

      const response = await ai.models.generateContent({
        model: model,
        contents: {
          parts: [
            { inlineData: { mimeType, data: base64Audio } },
            { text: prompt },
          ],
        },
        config: {
          // Temperature 0.0 for Flash 3.1 Lite to enforce strict verbatim accuracy and zero hallucination
          temperature: isLite ? 0.0 : 0.1,
          maxOutputTokens: 8192,
          systemInstruction: systemInstruction,
        },
      });

      let rawText = response.text || '';
      rawText = cleanTranscriptOutput(rawText);
      rawText = formatSpeakerTags(rawText);

      res.json({ text: rawText });
    } catch (error: any) {
      console.error('Transcription error:', error);
      const errorMessage = error?.message || (typeof error === 'string' ? error : 'Failed to transcribe');
      res.status(500).json({ error: errorMessage });
    }
  });

  async function sanitizeSegment(segmentText: string, model: string, isLite: boolean): Promise<string> {
    const trimmed = segmentText.trim();
    if (!trimmed) return '';

    // Check if the segment starts with a section header: ### [00:00 - 02:00]
    const headerMatch = trimmed.match(/^(###\s*\[\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}\])(?:\n+([\s\S]*))?$/);
    let contentToSanitize = trimmed;

    if (headerMatch) {
      contentToSanitize = (headerMatch[2] || '').trim();
      // If there is no content under this header, return empty so no timestamp is output
      if (!contentToSanitize) {
        return '';
      }
    }

    const originalWordCount = countWords(contentToSanitize);

    try {
      const response = await ai.models.generateContent({
        model: model,
        contents: `You are an expert audio transcript editor performing disfluency cleanup.

ABSOLUTE NON-NEGOTIABLE LAWS:
1. FULL LENGTH PRESERVATION: You MUST preserve 100% of the conversation length, every sentence, every speaker turn, every detail, question, and answer. DO NOT shorten, do not summarize, do not condense, and never stop early.
2. REMOVE ALL TIMESTAMPS: You MUST completely remove all timestamps. Do not output any timestamp headers (e.g., "### [00:00 - 02:00]") or inline timestamps (e.g., "[00:15]"). Output ZERO timestamps in your response.
3. The ONLY other things you may remove:
   - Vocal filler sounds: "um", "uh", "er", "ah", and pure filler "like" or "you know" when used as mindless verbal pauses.
   - Stutters and accidental repetitions: e.g. "I I think" -> "I think", "we- we" -> "we".
   - Acoustic non-speech bracketed tags: "[cough]", "(laughter)", "[clears throat]".
4. PRESERVE ALL SPEAKERS: Keep all bold speaker labels (e.g., **Speaker 1:**, **Speaker 2:**, **Moderator:**, **Stakeholder:**) and keep each speaker turn strictly separate.
5. If in doubt about whether a word or thought is filler or meaningful dialogue, ALWAYS KEEP IT.
6. Output ONLY the cleaned transcript text without any timestamps.

Original Section:
${contentToSanitize}`,
        config: {
          temperature: isLite ? 0.0 : 0.1,
          maxOutputTokens: 8192,
          systemInstruction: 'You are an expert transcript editor. Clean disfluencies and fillers, remove all timestamps completely, and preserve 100% of substantive dialogue verbatim without commentary. Never summarize.',
        },
      });

      let cleaned = response.text || '';
      cleaned = cleanTranscriptOutput(cleaned);
      cleaned = stripAllTimestamps(cleaned);
      cleaned = formatSpeakerTags(cleaned);

      const cleanedWordCount = countWords(cleaned);

      // Truncation safeguard: if word count dropped by more than 30%, the model summarized or truncated!
      // In that case, fall back to regex-based disfluency removal so ZERO dialogue is lost.
      let finalSegmentBody = cleaned;
      if (cleanedWordCount < originalWordCount * 0.70 && originalWordCount > 15) {
        console.warn(`Sanitization length guard triggered! Original words: ${originalWordCount}, AI returned: ${cleanedWordCount}. Falling back to safe regex cleanup.`);
        finalSegmentBody = regexSanitize(contentToSanitize);
      } else if (!cleaned.trim()) {
        finalSegmentBody = regexSanitize(contentToSanitize);
      }

      return stripAllTimestamps(finalSegmentBody);
    } catch (err) {
      console.error('Error during segment sanitization, using safe regex fallback:', err);
      return stripAllTimestamps(regexSanitize(contentToSanitize));
    }
  }

  app.post('/api/sanitize', async (req, res) => {
    const { transcript, model } = req.body;
    if (!transcript) {
      return res.json({ text: '' });
    }

    try {
      const isLite = model === 'gemini-3.1-flash-lite';
      const targetModel = model || 'gemini-3.1-flash-lite';

      // Check if transcript contains section headers (e.g. "### [00:00 - 02:00]")
      const hasSectionHeaders = /###\s*\[\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}\]/.test(transcript);

      let segments: string[] = [];

      if (hasSectionHeaders) {
        // Split by section headers to process in clean logical chunks
        const rawSegments = transcript.split(/(?=###\s*\[\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}\])/);
        segments = rawSegments.map((s: string) => s.trim()).filter(Boolean);
      } else {
        // If no section headers, split into paragraph blocks of ~400-500 words so Gemini never truncates
        const paragraphs = transcript.split(/\n\s*\n/).filter((p: string) => p.trim());
        let currentBlock: string[] = [];
        let currentWordCount = 0;

        for (const p of paragraphs) {
          const pWords = countWords(p);
          if (currentWordCount + pWords > 450 && currentBlock.length > 0) {
            segments.push(currentBlock.join('\n\n'));
            currentBlock = [p];
            currentWordCount = pWords;
          } else {
            currentBlock.push(p);
            currentWordCount += pWords;
          }
        }
        if (currentBlock.length > 0) {
          segments.push(currentBlock.join('\n\n'));
        }
      }

      if (segments.length === 0) {
        segments = [transcript];
      }

      // Sanitize all segments in parallel batches of 3
      const sanitizedSegments: string[] = [];
      const batchSize = 3;
      for (let i = 0; i < segments.length; i += batchSize) {
        const batch = segments.slice(i, i + batchSize);
        const batchResults = await Promise.all(
          batch.map(seg => sanitizeSegment(seg, targetModel, isLite))
        );
        sanitizedSegments.push(...batchResults);
      }

      let finalResult = sanitizedSegments.filter((s: string) => s && s.trim()).join('\n\n');
      finalResult = stripAllTimestamps(finalResult);
      finalResult = cleanTranscriptOutput(finalResult);
      finalResult = formatSpeakerTags(finalResult);

      res.json({ text: finalResult });
    } catch (error) {
      console.error('Sanitization error:', error);
      // Fallback guarantees 100% of the transcript is preserved without timestamps
      const fallback = formatSpeakerTags(stripAllTimestamps(regexSanitize(transcript)));
      res.json({ text: fallback });
    }
  });

  app.post('/api/format', async (req, res) => {
    const { transcript, model } = req.body;
    if (!transcript) return res.json({ text: '' });
    try {
      const targetModel = model || 'gemini-3.1-flash-lite';
      const hasSectionHeaders = /###\s*\[\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}\]/.test(transcript);
      let segments: string[] = [];

      if (hasSectionHeaders) {
        segments = transcript.split(/(?=###\s*\[\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}\])/).map((s: string) => s.trim()).filter(Boolean);
      } else {
        const paragraphs = transcript.split(/\n\s*\n/).filter((p: string) => p.trim());
        let currentBlock: string[] = [];
        let currentWordCount = 0;
        for (const p of paragraphs) {
          const pWords = countWords(p);
          if (currentWordCount + pWords > 450 && currentBlock.length > 0) {
            segments.push(currentBlock.join('\n\n'));
            currentBlock = [p];
            currentWordCount = pWords;
          } else {
            currentBlock.push(p);
            currentWordCount += pWords;
          }
        }
        if (currentBlock.length > 0) segments.push(currentBlock.join('\n\n'));
      }

      if (segments.length === 0) segments = [transcript];

      const formattedSegments = await Promise.all(
        segments.map(async (seg) => {
          const trimmed = seg.trim();
          if (!trimmed) return '';

          const headerMatch = trimmed.match(/^(###\s*\[\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}\])(?:\n+([\s\S]*))?$/);
          let header = '';
          let contentToFormat = trimmed;

          if (headerMatch) {
            header = headerMatch[1].trim();
            contentToFormat = (headerMatch[2] || '').trim();
            if (!contentToFormat) return header;
          }

          const origWords = countWords(contentToFormat);
          try {
            const response = await ai.models.generateContent({
              model: targetModel,
              contents: `Format and organize the speaker turns in this transcript.
RULES:
1. Keep 100% of the words verbatim. Do not change words, summarize, shorten, or omit any text.
2. Put each speaker turn on a new paragraph with bold speaker labels (e.g., **Speaker 1:**, **Speaker 2:**, **Moderator:**, **Stakeholder:**).
3. Ensure clean sentence capitalization and punctuation.
4. Output only the formatted transcript.

Transcript:
${contentToFormat}`,
              config: {
                temperature: 0.0,
                maxOutputTokens: 8192,
                systemInstruction: 'You are a dialogue formatting specialist. Format speaker turns and paragraph flow with 100% verbatim fidelity. Output only the transcript.',
              },
            });

            let formatted = response.text || contentToFormat;
            formatted = cleanTranscriptOutput(formatted);
            formatted = formatSpeakerTags(formatted);

            let finalBody = formatted;
            if (countWords(formatted) < origWords * 0.70 && origWords > 15) {
              finalBody = formatSpeakerTags(contentToFormat);
            }
            return header ? `${header}\n\n${finalBody}` : finalBody;
          } catch {
            const safeBody = formatSpeakerTags(contentToFormat);
            return header ? `${header}\n\n${safeBody}` : safeBody;
          }
        })
      );

      let finalFormatted = formattedSegments.join('\n\n');
      finalFormatted = cleanTranscriptOutput(finalFormatted);
      finalFormatted = formatSpeakerTags(finalFormatted);

      res.json({ text: finalFormatted });
    } catch (error: any) {
      console.error('Formatting error:', error);
      res.json({ text: formatSpeakerTags(transcript) });
    }
  });

  const vite = await createViteServer({
    server: { middlewareMode: true },
  });
  app.use(vite.middlewares);

  app.listen(3000, () => {
    console.log('Server running on port 3000');
  });
}
createServer();
