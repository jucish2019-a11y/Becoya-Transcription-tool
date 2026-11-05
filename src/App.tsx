/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useRef, ChangeEvent, useEffect } from "react";

import { Mic, Square, Loader2, AlertCircle, Upload, Copy, Check, Wand2, FileAudio, AudioLines, Download, Plus, Trash2, Clock, MessageSquare, Search, BookOpen, ChevronDown, ChevronUp, PanelLeft, Tag, Archive, ArchiveRestore, Play, Pause, RotateCcw, AlertTriangle, Sparkles, CheckCircle2 } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import Markdown from "react-markdown";
import { chunkAudioIfNeeded, formatSecondsToTime, AudioChunk } from "./utils/audioChunker";

interface HistoryItem {
  id: string;
  title: string;
  content: string;
  date: string;
  confidenceScore?: number;
  tag?: string;
  isArchived?: boolean;
  model?: string;
  isPartial?: boolean;
  completedParts?: number;
  totalParts?: number;
}

export interface ActiveTranscriptionSession {
  audioBlob: Blob;
  mimeType: string;
  sourceName: string;
  chunks: AudioChunk[];
  chunkTexts: Record<number, string>;
  nextChunkIndex: number;
  totalChunks: number;
  status: 'idle' | 'transcribing' | 'paused' | 'failed' | 'completed';
  error?: string;
  historyId: string;
  modelUsed: string;
}



export interface ModelInfo {
  id: string;
  name: string;
  shortLabel: string;
  badge?: string;
  category: string;
  description: string;
  demandRisk: 'Very Low (Immune to Spikes)' | 'Low' | 'Moderate';
  tokenLimit: string;
  isRecommended?: boolean;
  isBestAudio?: boolean;
}

export const availableModels: ModelInfo[] = [
  {
    id: "gemini-3.8-flash",
    name: "Gemini 3.8 Flash (★ Recommended - 1M Context, No Spikes)",
    shortLabel: "Gemini 3.8 Flash",
    badge: "Recommended",
    category: "⭐ Recommended (High Capacity & Zero Spike Risk)",
    description: "Google's premier multimodal model for audio transcription. Features a massive 1,000,000+ token context window, lowest latency, and huge server throughput that avoids demand spikes.",
    demandRisk: "Very Low (Immune to Spikes)",
    tokenLimit: "1,000,000+ tokens (~11 hrs audio)",
    isRecommended: true,
  },
  {
    id: "gemini-flash-latest",
    name: "Gemini Flash Latest (★ High Availability & Quota)",
    shortLabel: "Gemini Flash Latest",
    badge: "High Availability",
    category: "⭐ Recommended (High Capacity & Zero Spike Risk)",
    description: "Automatically routes to Google's most reliable and high-throughput Flash infrastructure for uninterrupted transcribing even during peak hours.",
    demandRisk: "Very Low (Immune to Spikes)",
    tokenLimit: "1,000,000 tokens",
    isRecommended: true,
  },
  {
    id: "gemini-3.1-flash-lite",
    name: "Gemini 3.1 Flash Lite (★ Ultra-Fast, Zero Spike Risk)",
    shortLabel: "Gemini 3.1 Flash Lite",
    badge: "Ultra Fast & Resilient",
    category: "⭐ Recommended (High Capacity & Zero Spike Risk)",
    description: "Tuned with acoustic voice separation (temp 0.0), isolated speaker turns without mixing, full-length non-truncating sanitization, and Google's highest concurrency quota against demand spikes.",
    demandRisk: "Very Low (Immune to Spikes)",
    tokenLimit: "1,000,000 tokens",
    isRecommended: true,
  },
  {
    id: "gemini-3.7-flash",
    name: "Gemini 3.7 Flash (High Accuracy Multimodal)",
    shortLabel: "Gemini 3.7 Flash",
    badge: "High Precision",
    category: "⭐ Recommended (High Capacity & Zero Spike Risk)",
    description: "Next-generation multimodal reasoning model delivering rapid transcription inference and generous rate limits.",
    demandRisk: "Low",
    tokenLimit: "1,000,000 tokens",
  },
  {
    id: "gemini-3.5-transcribe",
    name: "Gemini 3.5 Transcribe (Google Dedicated Audio Engine)",
    shortLabel: "Gemini 3.5 Transcribe",
    badge: "Specialized",
    category: "🎙️ Specialized Audio Engine",
    description: "Google's purpose-built audio transcription model. Optimized for verbatim accuracy on clear audio (supports up to 98k tokens per segment).",
    demandRisk: "Low",
    tokenLimit: "98,304 tokens (~8 mins/chunk)",
    isBestAudio: true,
  },
  {
    id: "gemini-3.5-flash",
    name: "Gemini 3.5 Flash (Standard Multimodal)",
    shortLabel: "Gemini 3.5 Flash",
    category: "⚡ Stable Multimodal Fallbacks",
    description: "Established previous-generation Flash model with broad compatibility and stable throughput.",
    demandRisk: "Low",
    tokenLimit: "1,000,000 tokens",
  },
  {
    id: "gemini-2.5-flash",
    name: "Gemini 2.5 Flash (Reliable Fallback)",
    shortLabel: "Gemini 2.5 Flash",
    category: "⚡ Stable Multimodal Fallbacks",
    description: "High-stability long-context multimodal model with consistent availability.",
    demandRisk: "Low",
    tokenLimit: "1,000,000 tokens",
  },
];

export default function App() {
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [isSanitizing, setIsSanitizing] = useState(false);
  const [transcription, setTranscription] = useState("");
  const [error, setError] = useState("");
  const [lastFailedAudio, setLastFailedAudio] = useState<{ blob: Blob; mimeType: string } | null>(null);
  const [isCopied, setIsCopied] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [progressStatus, setProgressStatus] = useState("");
  const [confidenceScore, setConfidenceScore] = useState<number | null>(null);
  const [isFormatting, setIsFormatting] = useState(false);
  const [transcriptionStyle, setTranscriptionStyle] = useState<'verbatim' | 'clean'>('verbatim');
  const [selectedModel, setSelectedModel] = useState("gemini-3.8-flash");
  const [session, setSession] = useState<ActiveTranscriptionSession | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const isPausedRef = useRef<boolean>(false);
  
  const activeModelInfo = availableModels.find((m) => m.id === selectedModel) || availableModels[0];
  const modelCategories = Array.from(new Set(availableModels.map((m) => m.category)));
  
  // Sidebar State
  const [activeTab, setActiveTab] = useState<'history' | 'vocabulary' | 'archive'>('history');
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  
  // Custom Vocabulary State
  const [vocabulary, setVocabulary] = useState(() => {
    return localStorage.getItem('transcriptionVocabulary') || "";
  });

  // History state
  const [history, setHistory] = useState<HistoryItem[]>(() => {
    const saved = localStorage.getItem('transcriptionHistory');
    return saved ? JSON.parse(saved) : [];
  });
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  const filteredHistory = history.filter(item => 
    !item.isArchived &&
    (item.title.toLowerCase().includes(searchQuery.toLowerCase()) || 
    item.content.toLowerCase().includes(searchQuery.toLowerCase()) ||
    (item.tag && item.tag.toLowerCase().includes(searchQuery.toLowerCase())))
  );

  const archivedHistory = history.filter(item => 
    item.isArchived &&
    (item.title.toLowerCase().includes(searchQuery.toLowerCase()) || 
    item.content.toLowerCase().includes(searchQuery.toLowerCase()) ||
    (item.tag && item.tag.toLowerCase().includes(searchQuery.toLowerCase())))
  );

  // Group history by tag
  const groupedHistory = filteredHistory.reduce((acc, item) => {
    const tag = item.tag || 'Untagged';
    if (!acc[tag]) {
      acc[tag] = [];
    }
    acc[tag].push(item);
    return acc;
  }, {} as Record<string, HistoryItem[]>);

  // Group archived history by tag
  const groupedArchivedHistory = archivedHistory.reduce((acc, item) => {
    const tag = item.tag || 'Untagged';
    if (!acc[tag]) {
      acc[tag] = [];
    }
    acc[tag].push(item);
    return acc;
  }, {} as Record<string, HistoryItem[]>);

  // Sort tags: 'Untagged' last, others alphabetically
  const sortedTags = Object.keys(groupedHistory).sort((a, b) => {
    if (a === 'Untagged') return 1;
    if (b === 'Untagged') return -1;
    return a.localeCompare(b);
  });

  const sortedArchivedTags = Object.keys(groupedArchivedHistory).sort((a, b) => {
    if (a === 'Untagged') return 1;
    if (b === 'Untagged') return -1;
    return a.localeCompare(b);
  });

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Save history to local storage whenever it changes
  useEffect(() => {
    localStorage.setItem('transcriptionHistory', JSON.stringify(history));
  }, [history]);

  // Save vocabulary to local storage whenever it changes
  useEffect(() => {
    localStorage.setItem('transcriptionVocabulary', vocabulary);
  }, [vocabulary]);

  const handleNew = () => {
    if (isTranscribing) {
      pauseTranscription();
    }
    setSession(null);
    setCurrentId(null);
    setTranscription("");
    setConfidenceScore(null);
    setError("");
    setLastFailedAudio(null);
  };

  const loadHistoryItem = (item: HistoryItem) => {
    setCurrentId(item.id);
    setTranscription(item.content);
    setConfidenceScore(item.confidenceScore || null);
    setError("");
    if (session && session.historyId !== item.id && !isTranscribing) {
      setSession(null);
    }
  };

  const deleteHistoryItem = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    setHistory(prev => prev.filter(item => item.id !== id));
    if (currentId === id) {
      setCurrentId(null);
      setTranscription("");
      if (session?.historyId === id) {
        setSession(null);
      }
    }
  };

  const updateHistoryItemTag = (id: string, newTag: string) => {
    setHistory(prev => prev.map(item => 
      item.id === id ? { ...item, tag: newTag } : item
    ));
  };

  const updateHistoryItemTitle = (id: string, newTitle: string) => {
    setHistory(prev => prev.map(item => 
      item.id === id ? { ...item, title: newTitle } : item
    ));
  };

  const toggleArchiveStatus = (id: string) => {
    setHistory(prev => prev.map(item => 
      item.id === id ? { ...item, isArchived: !item.isArchived } : item
    ));
    if (currentId === id) {
      setCurrentId(null);
      setTranscription("");
    }
  };

  const archiveAllByTag = (tag: string) => {
    setHistory(prev => prev.map(item => 
      (item.tag === tag || (tag === 'Untagged' && !item.tag)) && !item.isArchived
        ? { ...item, isArchived: true } 
        : item
    ));
    // If current item is being archived, clear it
    const currentItem = history.find(h => h.id === currentId);
    if (currentItem && (currentItem.tag === tag || (tag === 'Untagged' && !currentItem.tag))) {
      setCurrentId(null);
      setTranscription("");
    }
  };

  const handleCopy = async () => {
    if (!transcription) return;
    try {
      await navigator.clipboard.writeText(transcription);
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy text:", err);
    }
  };

  const handleDownload = () => {
    if (!transcription) return;
    const blob = new Blob([transcription], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "transcript.txt";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const buildTranscriptFromChunks = (chunks: AudioChunk[], chunkTexts: Record<number, string>): string => {
    const parts: string[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const text = chunkTexts[i];
      if (text) {
        if (chunks.length > 1) {
          const sectionHeader = `### [${formatSecondsToTime(chunks[i].startTimeSec)} - ${formatSecondsToTime(chunks[i].endTimeSec)}]`;
          parts.push(`${sectionHeader}\n\n${text.trim()}`);
        } else {
          parts.push(text.trim());
        }
      }
    }
    return parts.join("\n\n");
  };

  const handleFileUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }

    await startTranscription(file, file.type, file.name);
  };

  const sanitizeTranscript = async () => {
    if (!transcription) return;
    
    setIsSanitizing(true);
    setError("");

    try {
      const sanitizeModel = selectedModel === "gemini-3.5-transcribe" ? "gemini-3.8-flash" : selectedModel;
      const response = await fetch('/api/sanitize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript: transcription, model: sanitizeModel })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Sanitization failed');

      const responseText = data.text || transcription;
      setTranscription(responseText);
      
      // Update history with sanitized content
      if (currentId) {
        setHistory(prev => prev.map(item => 
          item.id === currentId ? { ...item, content: responseText } : item
        ));
      }
    } catch (err) {
      console.error("Sanitization error:", err);
      setError("Failed to sanitize transcript. Please try again.");
    } finally {
      setIsSanitizing(false);
    }
  };

  const startRecording = async () => {
    try {
      setError("");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = async () => {
        const audioBlob = new Blob(audioChunksRef.current, {
          type: mediaRecorder.mimeType,
        });
        const now = new Date();
        const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        await startTranscription(audioBlob, mediaRecorder.mimeType, `Recording at ${timeStr}`);
        stream.getTracks().forEach((track) => track.stop());
      };

      mediaRecorder.start();
      setIsRecording(true);
    } catch (err) {
      console.error("Error accessing microphone:", err);
      setError(
        "Could not access microphone. Please ensure permissions are granted.",
      );
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
  };

  const blobToBase64 = (blob: Blob, onProgress?: (progress: number) => void): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      
      if (onProgress) {
        reader.onprogress = (event) => {
          if (event.lengthComputable) {
            onProgress((event.loaded / event.total) * 100);
          }
        };
      }

      reader.onloadend = () => {
        if (typeof reader.result === "string") {
          const base64 = reader.result.split(",")[1];
          resolve(base64);
        } else {
          reject(new Error("Failed to read blob as base64"));
        }
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  };

  const pauseTranscription = () => {
    if (!isTranscribing) return;
    isPausedRef.current = true;
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    setIsTranscribing(false);
    setProgressStatus("Transcription paused.");
    setSession((prev) => (prev ? { ...prev, status: 'paused' } : null));
  };

  const cancelSession = () => {
    if (isTranscribing) {
      pauseTranscription();
    }
    setSession(null);
    setError("");
    setProgressStatus("");
    setUploadProgress(0);
  };

  const smartFormatTranscript = async () => {
    if (!transcription) return;
    setIsFormatting(true);
    setError("");

    try {
      const formatModel = selectedModel === "gemini-3.5-transcribe" ? "gemini-3.1-flash-lite" : selectedModel;
      const response = await fetch('/api/format', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript: transcription, model: formatModel })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Formatting failed');

      const responseText = data.text || transcription;
      setTranscription(responseText);
      
      if (currentId) {
        setHistory(prev => prev.map(item => 
          item.id === currentId ? { ...item, content: responseText } : item
        ));
      }
    } catch (err: any) {
      console.error("Formatting error:", err);
      setError("Failed to format transcript. Please try again.");
    } finally {
      setIsFormatting(false);
    }
  };

  const startTranscription = async (
    audioBlob: Blob,
    mimeType: string,
    sourceName: string,
    modelOverride?: string
  ) => {
    const activeModel = modelOverride || selectedModel;
    setIsTranscribing(true);
    setTranscription("");
    setError("");
    setLastFailedAudio(null);
    setUploadProgress(0);
    setProgressStatus("Preparing audio segments...");
    isPausedRef.current = false;

    try {
      const chunkDuration = activeModel === 'gemini-3.1-flash-lite' ? 120 : 300;
      const chunks = await chunkAudioIfNeeded(audioBlob, mimeType, chunkDuration);
      const newId = Date.now().toString();
      setCurrentId(newId);

      const newSession: ActiveTranscriptionSession = {
        audioBlob,
        mimeType,
        sourceName,
        chunks,
        chunkTexts: {},
        nextChunkIndex: 0,
        totalChunks: chunks.length,
        status: 'transcribing',
        historyId: newId,
        modelUsed: activeModel,
      };

      setSession(newSession);

      // Pre-create item in history so partial text is preserved immediately
      setHistory((prev) => [
        {
          id: newId,
          title: sourceName || "New Transcription",
          content: "",
          date: new Date().toISOString(),
          confidenceScore: undefined,
          model: activeModel,
          isPartial: chunks.length > 1,
          completedParts: 0,
          totalParts: chunks.length,
        },
        ...prev,
      ]);

      await executeTranscriptionChunks(newSession, activeModel);
    } catch (err: unknown) {
      setIsTranscribing(false);
      setUploadProgress(0);
      setProgressStatus("");
      const message = err instanceof Error ? err.message : "Failed to analyze audio.";
      setError(message);
    }
  };

  const resumeTranscription = async (modelOverride?: string) => {
    const modelToUse = modelOverride || selectedModel;
    setSelectedModel(modelToUse);

    if (!session) {
      if (lastFailedAudio) {
        await startTranscription(lastFailedAudio.blob, lastFailedAudio.mimeType, "Recovered Audio", modelToUse);
      }
      return;
    }

    const updatedSession: ActiveTranscriptionSession = {
      ...session,
      status: 'transcribing',
      modelUsed: modelToUse,
      error: undefined,
    };

    setSession(updatedSession);
    await executeTranscriptionChunks(updatedSession, modelToUse);
  };

  const executeTranscriptionChunks = async (
    activeSession: ActiveTranscriptionSession,
    activeModel: string
  ) => {
    setIsTranscribing(true);
    setError("");
    isPausedRef.current = false;

    const { chunks, totalChunks } = activeSession;
    const vocabPrompt = vocabulary.trim()
      ? `\n\nPlease pay special attention to the following company-specific jargon, acronyms, and names to ensure they are spelled correctly:\n${vocabulary}`
      : "";

    let currentCombined = buildTranscriptFromChunks(chunks, activeSession.chunkTexts);
    let hasFailed = false;

    for (let i = activeSession.nextChunkIndex; i < chunks.length; i++) {
      if (isPausedRef.current) {
        setSession((prev) =>
          prev ? { ...prev, status: 'paused', nextChunkIndex: i } : null
        );
        setIsTranscribing(false);
        setProgressStatus(
          `Paused at part ${i + 1} of ${totalChunks} (${formatSecondsToTime(chunks[i].startTimeSec)} - ${formatSecondsToTime(chunks[i].endTimeSec)})`
        );
        return;
      }

      const chunk = chunks[i];
      const progressBase = (i / totalChunks) * 100;
      const progressPerChunk = 100 / totalChunks;

      if (totalChunks > 1) {
        setProgressStatus(
          `Transcribing part ${i + 1} of ${totalChunks} (${formatSecondsToTime(chunk.startTimeSec)} - ${formatSecondsToTime(chunk.endTimeSec)})...`
        );
      } else {
        setProgressStatus("Uploading & transcribing audio...");
      }
      setUploadProgress(Math.round(progressBase + progressPerChunk * 0.15));

      abortControllerRef.current = new AbortController();

      try {
        const base64Audio = await blobToBase64(chunk.blob, (p) => {
          setUploadProgress(Math.round(progressBase + (p / 100) * progressPerChunk * 0.35));
        });

        if (isPausedRef.current) {
          setSession((prev) =>
            prev ? { ...prev, status: 'paused', nextChunkIndex: i } : null
          );
          setIsTranscribing(false);
          setProgressStatus(
            `Paused at part ${i + 1} of ${totalChunks} (${formatSecondsToTime(chunk.startTimeSec)} - ${formatSecondsToTime(chunk.endTimeSec)})`
          );
          return;
        }

        setUploadProgress(Math.round(progressBase + progressPerChunk * 0.5));

        const partInstruction = totalChunks > 1
          ? ` This is part ${i + 1} of ${totalChunks} (time ${formatSecondsToTime(chunk.startTimeSec)} to ${formatSecondsToTime(chunk.endTimeSec)}).`
          : "";

        const styleInstruction = transcriptionStyle === 'clean'
          ? " Listen carefully to acoustic differences between speakers (pitch, cadence, tone). Accurately identify distinct speakers and label them in bold markdown (e.g., **Speaker 1:**, **Speaker 2:**, or names/roles like **Moderator:**, **Stakeholder:**). Never mix or combine different speakers' text into one turn. Start a new paragraph every time a speaker changes. Transcribe clearly, removing stutters and filler sounds while retaining 100% of substantive dialogue verbatim."
          : " Listen carefully to acoustic differences between speakers (pitch, cadence, tone). Accurately distinguish distinct speakers and label them in bold markdown (e.g., **Speaker 1:**, **Speaker 2:**, or names/roles like **Moderator:**, **Stakeholder:**). Never mix or combine different speakers' text into one turn. Start a new paragraph every time a speaker changes. Transcribe 100% of dialogue completely and verbatim.";

        const response = await fetch('/api/transcribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: abortControllerRef.current.signal,
          body: JSON.stringify({
            base64Audio: base64Audio,
            mimeType: chunk.mimeType,
            prompt: `${styleInstruction}${partInstruction}${vocabPrompt}`,
            model: activeModel,
            style: transcriptionStyle,
          }),
        });

        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.error || 'Transcription failed');
        }

        const partText = data.text || "";
        activeSession.chunkTexts[i] = partText;
        activeSession.nextChunkIndex = i + 1;

        currentCombined = buildTranscriptFromChunks(chunks, activeSession.chunkTexts);
        setTranscription(currentCombined);

        // Update history item in real time with partial transcript
        setHistory((prev) =>
          prev.map((item) =>
            item.id === activeSession.historyId
              ? {
                  ...item,
                  content: currentCombined,
                  isPartial: i + 1 < totalChunks,
                  completedParts: i + 1,
                  totalParts: totalChunks,
                  model: activeModel,
                }
              : item
          )
        );

        setSession({
          ...activeSession,
          nextChunkIndex: i + 1,
          status: i + 1 === totalChunks ? 'completed' : 'transcribing',
          chunkTexts: { ...activeSession.chunkTexts },
        });

        setUploadProgress(Math.round(progressBase + progressPerChunk));
      } catch (err: any) {
        if (isPausedRef.current || err?.name === 'AbortError') {
          setSession((prev) =>
            prev ? { ...prev, status: 'paused', nextChunkIndex: i } : null
          );
          setIsTranscribing(false);
          setProgressStatus(
            `Paused at part ${i + 1} of ${totalChunks} (${formatSecondsToTime(chunk.startTimeSec)} - ${formatSecondsToTime(chunk.endTimeSec)})`
          );
          return;
        }

        hasFailed = true;
        console.error(`Transcription error on chunk ${i}:`, err);
        const errorMessage = err instanceof Error ? err.message : String(err) || 'Failed to transcribe audio.';

        const errString = String(err) + " " + JSON.stringify(err) + " " + errorMessage;
        const isTokenLimit =
          errString.includes("maximum number of tokens allowed") ||
          errString.includes("98304") ||
          errString.includes("token limit") ||
          errString.includes("ResourceExhausted") ||
          errString.includes("RESOURCE_EXHAUSTED");

        let formattedError = errorMessage;
        if (isTokenLimit) {
          formattedError = `Part ${i + 1} exceeded model token limits. You can continue remaining parts with Gemini 3.8 Flash.`;
        } else {
          formattedError = `Transcription stopped at part ${i + 1} of ${totalChunks} (${formatSecondsToTime(chunk.startTimeSec)} - ${formatSecondsToTime(chunk.endTimeSec)}): ${errorMessage}`;
        }

        setError(formattedError);
        setLastFailedAudio({ blob: activeSession.audioBlob, mimeType: activeSession.mimeType });

        setSession((prev) =>
          prev
            ? {
                ...prev,
                status: 'failed',
                nextChunkIndex: i,
                error: formattedError,
              }
            : null
        );

        setIsTranscribing(false);
        setProgressStatus(
          `Stopped at part ${i + 1} of ${totalChunks} (${formatSecondsToTime(chunk.startTimeSec)} - ${formatSecondsToTime(chunk.endTimeSec)})`
        );
        return;
      }
    }

    if (!hasFailed && !isPausedRef.current) {
      setIsTranscribing(false);
      setProgressStatus("Complete!");
      setUploadProgress(100);
      setConfidenceScore(95);

      const words = currentCombined.replace(/[*_#\[\]]/g, '').split(/\s+/).filter(Boolean);
      const generatedTitle = words.slice(0, 5).join(' ') + (words.length > 5 ? '...' : '');

      setHistory((prev) =>
        prev.map((item) =>
          item.id === activeSession.historyId
            ? {
                ...item,
                title:
                  !item.title ||
                  item.title === "Voice Recording" ||
                  item.title === "New Transcription" ||
                  item.title.startsWith("Recording")
                    ? generatedTitle || item.title
                    : item.title,
                content: currentCombined,
                confidenceScore: 95,
                isPartial: false,
                completedParts: totalChunks,
                totalParts: totalChunks,
                model: activeModel,
              }
            : item
        )
      );

      setSession((prev) =>
        prev
          ? {
              ...prev,
              status: 'completed',
              nextChunkIndex: totalChunks,
            }
          : null
      );

      setTimeout(() => {
        setUploadProgress(0);
        setProgressStatus("");
      }, 2000);
    }
  };

  return (
    <div className="flex h-screen w-full bg-[#fafafa] overflow-hidden font-sans text-[#0a0a0a]">
      {/* Sidebar */}
      <AnimatePresence initial={false}>
        {isSidebarOpen && (
          <motion.aside 
            initial={{ width: 0 }}
            animate={{ width: 288 }}
            exit={{ width: 0 }}
            transition={{ duration: 0.2, ease: "easeInOut" }}
            className="border-r border-zinc-200 bg-zinc-50 flex-col flex-shrink-0 hidden md:flex overflow-hidden"
          >
            <div className="w-72 h-full flex flex-col">
              <div className="p-4 border-b border-zinc-200 bg-white">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-zinc-800 font-semibold">Library</h2>
                  <button 
                    onClick={handleNew}
                    className="p-1.5 rounded-md hover:bg-zinc-100 text-zinc-600 hover:text-zinc-900 transition-colors focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:outline-none"
                    title="New Transcription"
                    aria-label="Start new transcription"
                  >
                    <Plus className="w-4 h-4" />
                  </button>
                </div>
                
                <div className="flex bg-zinc-100 p-1 rounded-lg" role="tablist" aria-label="Sidebar tabs">
                  <button
                    role="tab"
                    aria-selected={activeTab === 'history'}
                    aria-controls="history-panel"
                    id="history-tab"
                    onClick={() => setActiveTab('history')}
                    className={`flex-1 flex items-center justify-center gap-2 py-1.5 text-xs font-medium rounded-md transition-all focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:outline-none ${
                      activeTab === 'history' 
                        ? 'bg-white text-zinc-900 shadow-sm' 
                        : 'text-zinc-600 hover:text-zinc-800'
                    }`}
                  >
                    <Clock className="w-3.5 h-3.5" />
                    History
                  </button>
                  <button
                    role="tab"
                    aria-selected={activeTab === 'archive'}
                    aria-controls="archive-panel"
                    id="archive-tab"
                    onClick={() => setActiveTab('archive')}
                    className={`flex-1 flex items-center justify-center gap-2 py-1.5 text-xs font-medium rounded-md transition-all focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:outline-none ${
                      activeTab === 'archive' 
                        ? 'bg-white text-zinc-900 shadow-sm' 
                        : 'text-zinc-600 hover:text-zinc-800'
                    }`}
                  >
                    <Archive className="w-3.5 h-3.5" />
                    Archive
                  </button>
                  <button
                    role="tab"
                    aria-selected={activeTab === 'vocabulary'}
                    aria-controls="vocabulary-panel"
                    id="vocabulary-tab"
                    onClick={() => setActiveTab('vocabulary')}
                    className={`flex-1 flex items-center justify-center gap-2 py-1.5 text-xs font-medium rounded-md transition-all focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:outline-none ${
                      activeTab === 'vocabulary' 
                        ? 'bg-white text-zinc-900 shadow-sm' 
                        : 'text-zinc-600 hover:text-zinc-800'
                    }`}
                  >
                    <BookOpen className="w-3.5 h-3.5" />
                    Vocab
                  </button>
                </div>
              </div>

              {activeTab === 'history' ? (
                <div id="history-panel" role="tabpanel" aria-labelledby="history-tab" className="flex-1 flex flex-col overflow-hidden">
                  <div className="p-3 border-b border-zinc-200 bg-zinc-50/50">
                    <div className="relative">
                      <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" aria-hidden="true" />
                      <input
                        type="text"
                        placeholder="Search transcripts..."
                        aria-label="Search transcripts"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="w-full pl-9 pr-3 py-2 bg-white border border-zinc-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all placeholder:text-zinc-500 text-zinc-900"
                      />
                    </div>
                  </div>
                  
                  <div className="flex-1 overflow-y-auto p-3 space-y-4">
                    {history.length === 0 ? (
                      <div className="text-center py-8 px-4 text-zinc-500 text-sm">
                        <MessageSquare className="w-8 h-8 mx-auto mb-3 opacity-30" aria-hidden="true" />
                        <p>No recent transcriptions.</p>
                      </div>
                    ) : filteredHistory.length === 0 ? (
                      <div className="text-center py-8 px-4 text-zinc-500 text-sm">
                        <Search className="w-8 h-8 mx-auto mb-3 opacity-30" aria-hidden="true" />
                        <p>No matches found.</p>
                      </div>
                    ) : (
                      sortedTags.map(tag => (
                        <div key={tag} className="space-y-1">
                          <div className="flex items-center justify-between px-2 py-1 group/tag-header">
                            <div className="flex items-center gap-2">
                              <Tag className="w-3 h-3 text-zinc-400" aria-hidden="true" />
                              <h4 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">{tag}</h4>
                            </div>
                            <button
                              onClick={() => archiveAllByTag(tag)}
                              className="opacity-0 group-hover/tag-header:opacity-100 p-1 rounded hover:bg-zinc-200 text-zinc-500 hover:text-zinc-900 transition-all focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:outline-none"
                              title={`Archive all ${tag}`}
                              aria-label={`Archive all transcriptions tagged ${tag}`}
                            >
                              <Archive className="w-3 h-3" aria-hidden="true" />
                            </button>
                          </div>
                          {groupedHistory[tag].map((item) => (
                            <div 
                              key={item.id}
                              className={`group relative p-3 rounded-xl transition-all border ${
                                currentId === item.id 
                                  ? 'bg-white border-zinc-200 shadow-sm' 
                                  : 'bg-transparent border-transparent hover:bg-zinc-100/80'
                              }`}
                            >
                              <button
                                onClick={() => loadHistoryItem(item)}
                                aria-label={`Load transcription: ${item.title}`}
                                className="w-full text-left pr-12 focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:outline-none rounded-md"
                              >
                                <h3 className="text-sm font-medium text-zinc-900 truncate">
                                  {item.title}
                                </h3>
                                <div className="flex items-center gap-2 mt-1">
                                  <p className="text-xs text-zinc-600">
                                    {new Date(item.date).toLocaleDateString(undefined, { 
                                      month: 'short', 
                                      day: 'numeric',
                                      hour: '2-digit',
                                      minute: '2-digit'
                                    })}
                                  </p>
                                  {item.isPartial && (
                                    <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-sm bg-amber-100 text-amber-800 flex items-center gap-1">
                                      <Pause className="w-2.5 h-2.5 fill-current" />
                                      Partial ({item.completedParts || 0}/{item.totalParts || 1})
                                    </span>
                                  )}
                                  {item.confidenceScore && !item.isPartial && (
                                    <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-sm ${
                                      item.confidenceScore >= 90 ? 'bg-emerald-100 text-emerald-800' :
                                      item.confidenceScore >= 70 ? 'bg-amber-100 text-amber-800' :
                                      'bg-red-100 text-red-800'
                                    }`}>
                                      {item.confidenceScore}%
                                    </span>
                                  )}
                                  {item.model && (
                                    <span className="text-[10px] text-zinc-500 bg-zinc-100 px-1.5 py-0.5 rounded-sm truncate max-w-[110px]" title={item.model}>
                                      {availableModels.find(m => m.id === item.model)?.shortLabel || availableModels.find(m => m.id === item.model)?.name || item.model}
                                    </span>
                                  )}
                                </div>
                              </button>
                              <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                                <button
                                  onClick={(e) => { e.stopPropagation(); toggleArchiveStatus(item.id); }}
                                  className="p-1.5 rounded-md text-zinc-500 hover:text-zinc-900 hover:bg-zinc-200 transition-colors focus-visible:ring-2 focus-visible:ring-zinc-500 focus-visible:outline-none"
                                  title="Archive"
                                  aria-label={`Archive transcription: ${item.title}`}
                                >
                                  <Archive className="w-3.5 h-3.5" aria-hidden="true" />
                                </button>
                                <button
                                  onClick={(e) => deleteHistoryItem(e, item.id)}
                                  className="p-1.5 rounded-md text-zinc-500 hover:text-red-600 hover:bg-red-50 transition-colors focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:outline-none"
                                  title="Delete"
                                  aria-label={`Delete transcription: ${item.title}`}
                                >
                                  <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      ))
                    )}
                  </div>
                </div>
              ) : activeTab === 'archive' ? (
                <div id="archive-panel" role="tabpanel" aria-labelledby="archive-tab" className="flex-1 flex flex-col overflow-hidden">
                  <div className="p-3 border-b border-zinc-200 bg-zinc-50/50">
                    <div className="relative">
                      <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" aria-hidden="true" />
                      <input
                        type="text"
                        placeholder="Search archives..."
                        aria-label="Search archives"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="w-full pl-9 pr-3 py-2 bg-white border border-zinc-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all placeholder:text-zinc-500 text-zinc-900"
                      />
                    </div>
                  </div>
                  
                  <div className="flex-1 overflow-y-auto p-3 space-y-4">
                    {archivedHistory.length === 0 ? (
                      <div className="text-center py-8 px-4 text-zinc-500 text-sm">
                        <Archive className="w-8 h-8 mx-auto mb-3 opacity-30" aria-hidden="true" />
                        <p>No archived transcriptions.</p>
                      </div>
                    ) : (
                      sortedArchivedTags.map(tag => (
                        <div key={tag} className="space-y-1">
                          <div className="flex items-center gap-2 px-2 py-1">
                            <Tag className="w-3 h-3 text-zinc-400" aria-hidden="true" />
                            <h4 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">{tag}</h4>
                          </div>
                          {groupedArchivedHistory[tag].map((item) => (
                            <div 
                              key={item.id}
                              className={`group relative p-3 rounded-xl transition-all border ${
                                currentId === item.id 
                                  ? 'bg-white border-zinc-200 shadow-sm' 
                                  : 'bg-transparent border-transparent hover:bg-zinc-100/80'
                              }`}
                            >
                              <button
                                onClick={() => loadHistoryItem(item)}
                                aria-label={`Load transcription: ${item.title}`}
                                className="w-full text-left pr-12 focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:outline-none rounded-md"
                              >
                                <h3 className="text-sm font-medium text-zinc-900 truncate opacity-70">
                                  {item.title}
                                </h3>
                                <div className="flex items-center gap-2 mt-1 opacity-70">
                                  <p className="text-xs text-zinc-600">
                                    {new Date(item.date).toLocaleDateString(undefined, { 
                                      month: 'short', 
                                      day: 'numeric',
                                      hour: '2-digit',
                                      minute: '2-digit'
                                    })}
                                  </p>
                                  {item.isPartial && (
                                    <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-sm bg-amber-100 text-amber-800 flex items-center gap-1">
                                      <Pause className="w-2.5 h-2.5 fill-current" />
                                      Partial ({item.completedParts || 0}/{item.totalParts || 1})
                                    </span>
                                  )}
                                  {item.model && (
                                    <span className="text-[10px] text-zinc-500 bg-zinc-100 px-1.5 py-0.5 rounded-sm truncate max-w-[110px]" title={item.model}>
                                      {availableModels.find(m => m.id === item.model)?.shortLabel || availableModels.find(m => m.id === item.model)?.name || item.model}
                                    </span>
                                  )}
                                </div>
                              </button>
                              <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                                <button
                                  onClick={(e) => { e.stopPropagation(); toggleArchiveStatus(item.id); }}
                                  className="p-1.5 rounded-md text-zinc-500 hover:text-zinc-900 hover:bg-zinc-200 transition-colors focus-visible:ring-2 focus-visible:ring-zinc-500 focus-visible:outline-none"
                                  title="Restore from Archive"
                                  aria-label={`Restore transcription: ${item.title}`}
                                >
                                  <ArchiveRestore className="w-3.5 h-3.5" aria-hidden="true" />
                                </button>
                                <button
                                  onClick={(e) => deleteHistoryItem(e, item.id)}
                                  className="p-1.5 rounded-md text-zinc-500 hover:text-red-600 hover:bg-red-50 transition-colors focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:outline-none"
                                  title="Delete permanently"
                                  aria-label={`Delete transcription permanently: ${item.title}`}
                                >
                                  <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      ))
                    )}
                  </div>
                </div>
              ) : (
                <div id="vocabulary-panel" role="tabpanel" aria-labelledby="vocabulary-tab" className="flex-1 overflow-y-auto p-4 flex flex-col">
                  <div className="mb-4">
                    <h3 className="text-sm font-medium text-zinc-900 mb-1">Custom Vocabulary</h3>
                    <p className="text-xs text-zinc-600 leading-relaxed">
                      Add company-specific terms, acronyms, or names separated by commas. The AI will use this list to improve spelling accuracy during transcription.
                    </p>
                  </div>
                  <textarea
                    value={vocabulary}
                    onChange={(e) => setVocabulary(e.target.value)}
                    placeholder="e.g., AI Studio, Gemini, React, Tailwind CSS"
                    aria-label="Custom vocabulary terms"
                    className="flex-1 w-full p-3 text-sm bg-white border border-zinc-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all resize-none placeholder:text-zinc-500 text-zinc-900"
                  />
                </div>
              )}
            </div>
          </motion.aside>
        )}
      </AnimatePresence>

      {/* Main App */}
      <main className="flex-1 flex flex-col lg:flex-row overflow-y-auto lg:overflow-hidden">
        {/* Left Column: Controls */}
        <div className="w-full lg:w-5/12 p-8 lg:p-12 flex flex-col justify-between border-r border-black/5 bg-white relative overflow-y-auto">
        {/* Decorative background element */}
        <div className="absolute top-0 left-0 w-full h-full overflow-hidden pointer-events-none">
          <div className="absolute -top-[20%] -left-[10%] w-[70%] h-[50%] rounded-full bg-gradient-to-br from-indigo-50 to-transparent blur-3xl opacity-50" />
        </div>

        <div className="relative z-10 space-y-12">
          <div>
            <div className="flex items-center gap-3 mb-6">
              <button
                onClick={() => setIsSidebarOpen(!isSidebarOpen)}
                className="p-1.5 rounded-lg hover:bg-zinc-100 text-zinc-500 hover:text-zinc-900 transition-colors focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:outline-none hidden md:block"
                aria-label={isSidebarOpen ? "Hide sidebar" : "Show sidebar"}
              >
                <PanelLeft className="w-5 h-5" aria-hidden="true" />
              </button>
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-zinc-100 border border-zinc-200 text-xs font-medium text-zinc-600">
                <AudioLines className="w-3.5 h-3.5" />
                <span>Powered by Gemini AI</span>
              </div>
            </div>
            <h1 className="text-4xl lg:text-5xl font-semibold tracking-tight text-zinc-900 leading-[1.1]">
              Audio <br className="hidden lg:block" />
              Transcriber
            </h1>
            <p className="mt-4 text-zinc-600 text-sm leading-relaxed max-w-sm">
              Record your voice or upload an audio file to get an instant verbatim transcription. Professional, fast, and accurate.
            </p>
          </div>

          <div className="space-y-8">
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <label htmlFor="model-select" className="text-sm font-semibold text-zinc-800 flex items-center gap-2">
                  <span>AI Model</span>
                  <span className="text-[11px] font-medium text-emerald-800 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-200">
                    High Capacity & Stable
                  </span>
                </label>
              </div>
              <div className="relative">
                <select
                  id="model-select"
                  value={selectedModel}
                  onChange={(e) => setSelectedModel(e.target.value)}
                  className="w-full appearance-none bg-white border border-zinc-300 text-zinc-900 text-sm font-medium rounded-xl focus:ring-indigo-500 focus:border-indigo-500 block p-3 pr-8 transition-colors cursor-pointer shadow-xs"
                >
                  {modelCategories.map((cat) => (
                    <optgroup key={cat} label={cat}>
                      {availableModels
                        .filter((m) => m.category === cat)
                        .map((model) => (
                          <option key={model.id} value={model.id}>
                            {model.name}
                          </option>
                        ))}
                    </optgroup>
                  ))}
                </select>
                <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-3 text-zinc-500">
                  <ChevronDown className="h-4 w-4" />
                </div>
              </div>

              {/* Informative Model Card showing capability, tokens, and zero spike risk */}
              {activeModelInfo && (
                <div className="p-3 rounded-xl bg-zinc-50/90 border border-zinc-200 text-xs space-y-2 mt-1">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {activeModelInfo.isRecommended && (
                        <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-800 bg-emerald-100 px-2 py-0.5 rounded-full border border-emerald-200 shadow-2xs">
                          ★ Recommended for Transcription
                        </span>
                      )}
                      {activeModelInfo.isBestAudio && (
                        <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-indigo-800 bg-indigo-100 px-2 py-0.5 rounded-full border border-indigo-200 shadow-2xs">
                          🎙️ Dedicated Audio Engine
                        </span>
                      )}
                    </div>
                    <span className="text-[11px] font-mono text-zinc-700 bg-white px-2 py-0.5 rounded border border-zinc-200 font-medium">
                      {activeModelInfo.tokenLimit}
                    </span>
                  </div>
                  <p className="text-zinc-600 leading-relaxed text-[12px]">
                    {activeModelInfo.description}
                  </p>
                  <div className="pt-1.5 flex items-center justify-between text-[11px] border-t border-zinc-200/70">
                    <div className="flex items-center gap-1.5">
                      <span className="text-zinc-500 font-medium">Demand Spike Risk:</span>
                      <span className={`font-semibold ${
                        activeModelInfo.demandRisk.includes('Very Low') ? 'text-emerald-700' : 'text-blue-700'
                      }`}>
                        ● {activeModelInfo.demandRisk}
                      </span>
                    </div>
                    {activeModelInfo.isRecommended && (
                      <span className="text-zinc-500 font-medium">High Concurrency Quota</span>
                    )}
                  </div>
                </div>
              )}

              {/* Flash 3.1 Lite Tuning & Mode Options */}
              {selectedModel === 'gemini-3.1-flash-lite' && (
                <div className="p-3.5 bg-gradient-to-br from-indigo-50/80 to-purple-50/50 border border-indigo-200/80 rounded-xl space-y-2.5">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-indigo-950">
                      <Sparkles className="w-4 h-4 text-indigo-600" />
                      <span>Flash 3.1 Lite Precision Engine</span>
                    </div>
                    <span className="text-[10px] font-mono font-medium px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-800 border border-indigo-200">
                      Acoustic Diarization • Temp 0.0
                    </span>
                  </div>
                  <p className="text-[11px] text-zinc-600 leading-normal">
                    Optimized with acoustic voice separation, isolated speaker turns without mixing, full-length non-truncating sanitization, and 120s chunking.
                  </p>
                  <div>
                    <label className="text-[11px] font-medium text-zinc-700 block mb-1.5">
                      Transcription Mode:
                    </label>
                    <div className="grid grid-cols-2 gap-1.5">
                      <button
                        type="button"
                        onClick={() => setTranscriptionStyle('verbatim')}
                        className={`px-2.5 py-1.5 text-xs rounded-lg font-medium transition-all text-left flex flex-col ${
                          transcriptionStyle === 'verbatim'
                            ? 'bg-indigo-600 text-white shadow-sm ring-2 ring-indigo-600/20'
                            : 'bg-white text-zinc-700 border border-zinc-200 hover:bg-zinc-50'
                        }`}
                      >
                        <span className="font-semibold">Strict Verbatim</span>
                        <span className={`text-[10px] ${transcriptionStyle === 'verbatim' ? 'text-indigo-100' : 'text-zinc-500'}`}>
                          Every utterance & word
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setTranscriptionStyle('clean')}
                        className={`px-2.5 py-1.5 text-xs rounded-lg font-medium transition-all text-left flex flex-col ${
                          transcriptionStyle === 'clean'
                            ? 'bg-indigo-600 text-white shadow-sm ring-2 ring-indigo-600/20'
                            : 'bg-white text-zinc-700 border border-zinc-200 hover:bg-zinc-50'
                        }`}
                      >
                        <span className="font-semibold">Clean Dialogue</span>
                        <span className={`text-[10px] ${transcriptionStyle === 'clean' ? 'text-indigo-100' : 'text-zinc-500'}`}>
                          Omit stutters & fillers
                        </span>
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Action Buttons */}
            <div className="flex flex-col sm:flex-row gap-4">
              {!isRecording ? (
                <button
                  onClick={startRecording}
                  disabled={isTranscribing}
                  aria-label="Start Recording"
                  className="flex-1 group relative flex items-center justify-center gap-3 h-14 rounded-xl bg-zinc-900 text-white hover:bg-zinc-800 transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-zinc-900 focus-visible:outline-none"
                >
                  <Mic className="h-5 w-5" aria-hidden="true" />
                  <span className="font-medium">Start Recording</span>
                </button>
              ) : (
                <button
                  onClick={stopRecording}
                  aria-label="Stop Recording"
                  className="flex-1 group relative flex items-center justify-center gap-3 h-14 rounded-xl bg-red-600 text-white hover:bg-red-700 transition-all shadow-sm overflow-hidden focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-red-600 focus-visible:outline-none"
                >
                  <motion.div
                    animate={{ opacity: [0.5, 1, 0.5] }}
                    transition={{ repeat: Infinity, duration: 1.5 }}
                    className="absolute inset-0 bg-red-500/20"
                  />
                  <Square className="h-5 w-5 fill-current" aria-hidden="true" />
                  <span className="font-medium relative z-10">Stop Recording</span>
                </button>
              )}

              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={isTranscribing || isRecording}
                aria-label="Upload Audio File"
                className="flex-1 group relative flex items-center justify-center gap-3 h-14 rounded-xl bg-white border border-zinc-300 text-zinc-800 hover:bg-zinc-50 transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-zinc-900 focus-visible:outline-none"
              >
                <Upload className="h-5 w-5 text-zinc-500 group-hover:text-zinc-700 transition-colors" aria-hidden="true" />
                <span className="font-medium">Upload File</span>
              </button>
              <input
                type="file"
                ref={fileInputRef}
                onChange={handleFileUpload}
                accept="audio/*"
                className="hidden"
                aria-hidden="true"
                tabIndex={-1}
              />
            </div>

            {/* Status Indicators */}
            <div className="min-h-[64px] flex flex-col justify-center w-full">
              <AnimatePresence mode="wait">
                {isRecording && (
                  <motion.div
                    key="recording"
                    initial={{ opacity: 0, y: 5 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -5 }}
                    className="flex items-center justify-center gap-2 text-sm font-medium text-red-500"
                  >
                    <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                    Recording in progress...
                  </motion.div>
                )}
                {isTranscribing && (
                  <motion.div
                    key="transcribing"
                    initial={{ opacity: 0, y: 5 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -5 }}
                    className="flex flex-col items-center w-full gap-2.5"
                  >
                    <div className="flex items-center justify-between w-full max-w-xs">
                      <div className="flex items-center gap-2 text-xs font-medium text-zinc-700 truncate pr-2">
                        <Loader2 className="h-3.5 w-3.5 animate-spin text-indigo-600 shrink-0" />
                        <span className="truncate">{progressStatus}</span>
                      </div>
                      <button
                        type="button"
                        onClick={pauseTranscription}
                        className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold text-zinc-700 bg-white hover:bg-zinc-100 border border-zinc-200 rounded-md transition-colors shadow-2xs shrink-0 cursor-pointer"
                        title="Pause transcription"
                        aria-label="Pause transcription"
                      >
                        <Pause className="w-3 h-3 fill-current text-zinc-600" />
                        Pause
                      </button>
                    </div>
                    <div className="w-full max-w-xs bg-zinc-100 rounded-full h-2 overflow-hidden">
                      <motion.div 
                        className="bg-zinc-900 h-full rounded-full"
                        initial={{ width: 0 }}
                        animate={{ width: `${uploadProgress}%` }}
                        transition={{ ease: "linear", duration: 0.5 }}
                      />
                    </div>
                  </motion.div>
                )}
                {isSanitizing && (
                  <motion.div
                    key="sanitizing"
                    initial={{ opacity: 0, y: 5 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -5 }}
                    className="flex items-center justify-center gap-2 text-sm font-medium text-zinc-600"
                  >
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Sanitizing transcript...
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* Resumption Card: Continue from where it stopped */}
            <AnimatePresence>
              {session && (session.status === 'paused' || session.status === 'failed') && session.nextChunkIndex < session.totalChunks && (
                <motion.div
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  className={`rounded-2xl border p-5 space-y-4 shadow-sm ${
                    session.status === 'paused'
                      ? 'bg-amber-50/70 border-amber-200/90'
                      : 'bg-red-50/70 border-red-200/90'
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-start gap-3">
                      {session.status === 'paused' ? (
                        <div className="w-8 h-8 rounded-lg bg-amber-100 text-amber-800 flex items-center justify-center shrink-0 mt-0.5 shadow-2xs">
                          <Pause className="w-4 h-4 fill-current" />
                        </div>
                      ) : (
                        <div className="w-8 h-8 rounded-lg bg-red-100 text-red-800 flex items-center justify-center shrink-0 mt-0.5 shadow-2xs">
                          <AlertTriangle className="w-4 h-4" />
                        </div>
                      )}
                      <div>
                        <h3 className="text-sm font-semibold text-zinc-900">
                          {session.status === 'paused' ? 'Transcription Paused' : 'Transcription Stopped'}
                        </h3>
                        <p className="text-xs text-zinc-600 mt-0.5">
                          {session.nextChunkIndex > 0
                            ? `${session.nextChunkIndex} of ${session.totalChunks} part(s) transcribed (${Math.round((session.nextChunkIndex / session.totalChunks) * 100)}%).`
                            : `Stopped before first segment completed.`}
                        </p>
                      </div>
                    </div>
                    <button
                      onClick={cancelSession}
                      className="text-xs font-medium text-zinc-500 hover:text-zinc-900 transition-colors cursor-pointer"
                      title="Discard session and start fresh"
                    >
                      Dismiss
                    </button>
                  </div>

                  {session.error && (
                    <div className="p-3 rounded-xl bg-white/90 border border-red-200 text-xs text-red-900 leading-relaxed font-medium">
                      {session.error}
                    </div>
                  )}

                  <div className="bg-white/80 rounded-xl p-3 border border-black/5 text-xs text-zinc-700 flex items-center justify-between">
                    <span>
                      Ready to resume: <strong>Part {session.nextChunkIndex + 1} of {session.totalChunks}</strong>
                    </span>
                    {session.chunks[session.nextChunkIndex] && (
                      <span className="font-mono text-[11px] bg-zinc-100 px-2 py-0.5 rounded text-zinc-800 font-medium">
                        {formatSecondsToTime(session.chunks[session.nextChunkIndex].startTimeSec)} - {formatSecondsToTime(session.chunks[session.nextChunkIndex].endTimeSec)}
                      </span>
                    )}
                  </div>

                  {/* Primary Continue Button */}
                  <div className="flex flex-col gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => resumeTranscription()}
                      disabled={isTranscribing}
                      className="w-full flex items-center justify-center gap-2.5 h-12 rounded-xl bg-zinc-900 hover:bg-zinc-800 text-white font-medium text-xs sm:text-sm transition-all shadow-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-zinc-900 focus-visible:outline-none cursor-pointer"
                    >
                      <Play className="w-3.5 h-3.5 fill-current" />
                      <span>
                        Continue from Part {session.nextChunkIndex + 1} ({formatSecondsToTime(session.chunks[session.nextChunkIndex]?.startTimeSec || 0)})
                      </span>
                    </button>

                    {/* Quick switch to Gemini 3.8 Flash if using another model */}
                    {selectedModel !== "gemini-3.8-flash" && (
                      <button
                        type="button"
                        onClick={() => resumeTranscription("gemini-3.8-flash")}
                        disabled={isTranscribing}
                        className="w-full flex items-center justify-center gap-2 h-9 rounded-lg bg-white border border-zinc-200 hover:bg-zinc-50 text-zinc-700 text-xs font-medium transition-all shadow-2xs cursor-pointer"
                      >
                        <Sparkles className="w-3.5 h-3.5 text-indigo-600" />
                        <span>Continue with Gemini 3.8 Flash (High Token Limit)</span>
                      </button>
                    )}
                  </div>
                </motion.div>
              )}

              {/* General Error Display when no resumable session active */}
              {error && (!session || session.status === 'completed' || session.nextChunkIndex >= session.totalChunks) && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  className="overflow-hidden"
                >
                  <div className="rounded-xl bg-red-50 border border-red-200 p-4 mt-4" role="alert">
                    <div className="flex items-start gap-3">
                      <AlertCircle className="h-5 w-5 text-red-700 shrink-0 mt-0.5" aria-hidden="true" />
                      <div className="flex-1">
                        <p className="text-sm text-red-900 leading-relaxed font-medium">{error}</p>
                        {lastFailedAudio && (
                          <div className="mt-3 flex items-center gap-2">
                            <button
                              onClick={() => resumeTranscription("gemini-3.8-flash")}
                              className="px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-700 text-white text-xs font-medium transition-colors shadow-sm focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:outline-none cursor-pointer"
                            >
                              Retry with Gemini 3.8 Flash (1M+ token limit)
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>

      {/* Right Column: Output */}
      <div className="flex-1 p-4 lg:p-8 xl:p-12 flex flex-col h-[60vh] lg:h-screen">
        <div className="flex-1 flex flex-col bg-white rounded-2xl border border-zinc-200 shadow-sm overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-100 bg-zinc-50/50">
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <FileAudio className="w-4 h-4 text-zinc-500 shrink-0" aria-hidden="true" />
                {currentId ? (
                  <input
                    type="text"
                    value={history.find(h => h.id === currentId)?.title || ''}
                    onChange={(e) => updateHistoryItemTitle(currentId, e.target.value)}
                    className="text-sm font-medium text-zinc-900 bg-transparent border border-transparent hover:border-zinc-200 focus:bg-white focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 rounded px-2 py-0.5 w-48 sm:w-64 transition-all"
                    placeholder="Transcription Title"
                    aria-label="Transcription Title"
                  />
                ) : (
                  <h2 className="text-sm font-medium text-zinc-800 px-2 py-0.5">Transcription Result</h2>
                )}
              </div>
              {confidenceScore !== null && (
                <div 
                  className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium ${
                    confidenceScore >= 90 ? 'bg-emerald-100 text-emerald-800' :
                    confidenceScore >= 70 ? 'bg-amber-100 text-amber-800' :
                    'bg-red-100 text-red-800'
                  }`}
                  aria-label={`Confidence score: ${confidenceScore}%`}
                >
                  Confidence: {confidenceScore}%
                </div>
              )}
              {currentId && history.find(h => h.id === currentId)?.isPartial && (
                <div 
                  className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-semibold bg-amber-100 text-amber-900 border border-amber-200"
                  title="Transcription is incomplete / paused"
                >
                  <Pause className="w-3 h-3 fill-current text-amber-700" />
                  <span>Partial ({history.find(h => h.id === currentId)?.completedParts || 0}/{history.find(h => h.id === currentId)?.totalParts || 1})</span>
                </div>
              )}
              {currentId && history.find(h => h.id === currentId)?.model && (
                <div 
                  className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium bg-zinc-100 text-zinc-700 border border-zinc-200"
                  title="Model used for this transcription"
                >
                  <span className="text-zinc-500">Model:</span>
                  <span className="font-medium text-zinc-800">
                    {availableModels.find(m => m.id === history.find(h => h.id === currentId)?.model)?.shortLabel || availableModels.find(m => m.id === history.find(h => h.id === currentId)?.model)?.name || history.find(h => h.id === currentId)?.model}
                  </span>
                </div>
              )}
              {currentId && (
                <div className="relative group/tag">
                  <div className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium bg-zinc-100 text-zinc-700 border border-zinc-200 cursor-pointer hover:bg-zinc-200 transition-colors">
                    <Tag className="w-3 h-3" aria-hidden="true" />
                    {history.find(h => h.id === currentId)?.tag || 'Add Tag'}
                  </div>
                  <div className="absolute top-full left-0 mt-1 w-48 bg-white border border-zinc-200 rounded-lg shadow-lg opacity-0 invisible group-hover/tag:opacity-100 group-hover/tag:visible transition-all z-50 p-2">
                    <input 
                      type="text" 
                      placeholder="e.g. Legal Dept, Project X"
                      className="w-full text-xs p-1.5 border border-zinc-200 rounded focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      value={history.find(h => h.id === currentId)?.tag || ''}
                      onChange={(e) => updateHistoryItemTag(currentId, e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                    />
                  </div>
                </div>
              )}
            </div>
            
            {transcription && (
              <div className="flex items-center gap-2">
                <button
                  onClick={smartFormatTranscript}
                  disabled={isFormatting || isTranscribing}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-indigo-700 bg-indigo-50/70 hover:bg-indigo-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed border border-indigo-200/60 focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:outline-none"
                  title="Auto-format speaker turns and paragraphs without changing words"
                  aria-label="Smart format transcript"
                >
                  {isFormatting ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-indigo-600" aria-hidden="true" />
                  ) : (
                    <Sparkles className="h-3.5 w-3.5 text-indigo-600" aria-hidden="true" />
                  )}
                  {isFormatting ? "Formatting..." : "Smart Format"}
                </button>
                <div className="w-px h-4 bg-zinc-300 mx-0.5" aria-hidden="true" />
                <button
                  onClick={sanitizeTranscript}
                  disabled={isSanitizing || isTranscribing}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-zinc-700 hover:bg-zinc-100 hover:text-zinc-900 transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:outline-none"
                  title="Remove filler words, disfluencies, and all timestamps while strictly preserving 100% of conversation length"
                  aria-label="Sanitize transcript and remove timestamps"
                >
                  {isSanitizing ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-600" aria-hidden="true" />
                  ) : (
                    <Wand2 className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                  {isSanitizing ? "Sanitizing..." : "Sanitize"}
                </button>
                <div className="w-px h-4 bg-zinc-300 mx-1" aria-hidden="true" />
                <button
                  onClick={handleCopy}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-zinc-700 hover:bg-zinc-100 hover:text-zinc-900 transition-colors focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:outline-none"
                  aria-label={isCopied ? "Copied to clipboard" : "Copy to clipboard"}
                >
                  {isCopied ? <Check className="h-3.5 w-3.5 text-emerald-600" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
                  {isCopied ? "Copied" : "Copy"}
                </button>
                <div className="w-px h-4 bg-zinc-300 mx-1" aria-hidden="true" />
                <button
                  onClick={handleDownload}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-zinc-700 hover:bg-zinc-100 hover:text-zinc-900 transition-colors focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:outline-none"
                  title="Download as .txt"
                  aria-label="Export as text file"
                >
                  <Download className="h-3.5 w-3.5" aria-hidden="true" />
                  Export
                </button>
              </div>
            )}
          </div>

          {/* Continuation banner when paused or stopped with remaining parts */}
          {session && (session.status === 'paused' || session.status === 'failed') && session.nextChunkIndex < session.totalChunks && (
            <div className="bg-amber-50/90 border-b border-amber-200/90 px-6 py-2.5 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2.5 text-xs text-amber-900">
                <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
                <div>
                  <span className="font-semibold">
                    {session.status === 'paused' ? 'Transcription paused' : 'Transcription stopped'}:
                  </span>{' '}
                  Showing parts 1 to {session.nextChunkIndex} of {session.totalChunks}.
                  {session.chunks[session.nextChunkIndex] && (
                    <span className="text-amber-800 ml-1">
                      Part {session.nextChunkIndex + 1} ({formatSecondsToTime(session.chunks[session.nextChunkIndex].startTimeSec)} - {formatSecondsToTime(session.chunks[session.nextChunkIndex].endTimeSec)}) is ready to continue.
                    </span>
                  )}
                </div>
              </div>
              <button
                onClick={() => resumeTranscription()}
                disabled={isTranscribing}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-zinc-900 hover:bg-zinc-800 text-white rounded-lg text-xs font-medium shadow-xs transition-colors shrink-0 cursor-pointer"
              >
                <Play className="w-3 h-3 fill-current" />
                Continue from where it stopped
              </button>
            </div>
          )}

          {/* Content Area */}
          <div className="flex-1 p-6 overflow-y-auto relative" tabIndex={0} aria-label="Transcription text">
            {transcription ? (
              <div className="prose prose-zinc max-w-none">
                <div className="text-zinc-900 leading-relaxed whitespace-pre-wrap font-sans text-[15px] markdown-body">
                  <Markdown>{transcription}</Markdown>
                </div>
              </div>
            ) : (
              <div className="absolute inset-0 flex flex-col items-center justify-center text-zinc-500 p-6 text-center">
                <div className="w-16 h-16 mb-4 rounded-full bg-zinc-100 flex items-center justify-center border border-zinc-200">
                  <AudioLines className="w-6 h-6 text-zinc-400" aria-hidden="true" />
                </div>
                <p className="text-sm font-medium text-zinc-700">No transcription yet</p>
                <p className="text-xs mt-1 max-w-[250px] text-zinc-600">
                  Record audio or upload a file to see the transcription appear here.
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </main>
  </div>
);
}
