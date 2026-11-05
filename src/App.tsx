/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { ChangeEvent, MouseEvent as ReactMouseEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  Mic,
  Square,
  Loader2,
  AlertCircle,
  Upload,
  AudioLines,
  Plus,
  Trash2,
  Clock,
  Search,
  BookOpen,
  MessageSquare,
  ChevronDown,
  PanelLeft,
  Tag,
  Archive,
  ArchiveRestore,
  Play,
  Pause,
  AlertTriangle,
  Sparkles,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { TranscriptPanel } from './components/TranscriptPanel';
import { HistoryItem, useHistory } from './hooks/useHistory';
import { useRecorder } from './hooks/useRecorder';
import { useTranscriber } from './hooks/useTranscriber';
import { MODELS, ModelInfo, modelLabel } from './shared/models';
import { LANGUAGE_LABELS, LanguageHint, TranscriptionStyle } from './shared/transcript';
import { formatSecondsToTime } from './utils/audioChunker';

const PREFS_KEY = 'transcriberPrefs';

interface Prefs {
  model?: string;
  style?: TranscriptionStyle;
  language?: LanguageHint;
  expectedSpeakers?: string;
}

function loadPrefs(): Prefs {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') as Prefs;
  } catch {
    return {};
  }
}

export default function App() {
  const { history, setHistory, addItem, updateItem, removeItem, storageError } = useHistory();
  const [currentId, setCurrentId] = useState<string | null>(null);

  // Settings (remembered between visits)
  const prefs = useMemo(loadPrefs, []);
  const [models, setModels] = useState<ModelInfo[]>(MODELS);
  const [selectedModel, setSelectedModel] = useState(prefs.model || MODELS[0].id);
  const [transcriptionStyle, setTranscriptionStyle] = useState<TranscriptionStyle>(prefs.style || 'verbatim');
  const [language, setLanguage] = useState<LanguageHint>(prefs.language || 'auto');
  const [expectedSpeakers, setExpectedSpeakers] = useState(prefs.expectedSpeakers || '');
  const [vocabulary, setVocabulary] = useState(() => localStorage.getItem('transcriptionVocabulary') || '');

  // Sidebar state
  const [activeTab, setActiveTab] = useState<'history' | 'vocabulary' | 'archive'>('history');
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');

  const fileInputRef = useRef<HTMLInputElement>(null);

  const transcriber = useTranscriber({ addItem, updateItem, onStarted: setCurrentId });
  const { session, isTranscribing } = transcriber;

  const startWith = useCallback(
    (blob: Blob, mimeType: string, name: string) => {
      const n = parseInt(expectedSpeakers, 10);
      return transcriber.start(blob, mimeType, name, {
        model: selectedModel,
        style: transcriptionStyle,
        language,
        expectedSpeakers: Number.isInteger(n) && n >= 1 && n <= 12 ? n : undefined,
        vocabulary,
      });
    },
    [transcriber.start, selectedModel, transcriptionStyle, language, expectedSpeakers, vocabulary]
  );

  const recorder = useRecorder((blob, mime, name) => {
    void startWith(blob, mime, name);
  });
  const { isRecording } = recorder;

  // Only offer models this API key can actually use.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/models')
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { models?: ModelInfo[] } | null) => {
        if (cancelled || !data?.models?.length) return;
        setModels(data.models);
        setSelectedModel((cur) => (data.models!.some((m) => m.id === cur) ? cur : data.models![0].id));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    localStorage.setItem('transcriptionVocabulary', vocabulary);
  }, [vocabulary]);

  useEffect(() => {
    localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({ model: selectedModel, style: transcriptionStyle, language, expectedSpeakers } satisfies Prefs)
    );
  }, [selectedModel, transcriptionStyle, language, expectedSpeakers]);

  const activeModelInfo = models.find((m) => m.id === selectedModel) ?? models[0];
  const currentItem = history.find((h) => h.id === currentId) ?? null;

  // Audio player source (only available for the transcription made in this visit).
  const audioBlob = session && session.historyId === currentId ? session.audioBlob : null;
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!audioBlob) {
      setAudioUrl(null);
      return;
    }
    const url = URL.createObjectURL(audioBlob);
    setAudioUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [audioBlob]);

  // Sidebar lists
  const matches = (item: HistoryItem) => {
    const q = searchQuery.toLowerCase();
    return (
      item.title.toLowerCase().includes(q) ||
      item.content.toLowerCase().includes(q) ||
      (!!item.tag && item.tag.toLowerCase().includes(q))
    );
  };
  const filteredHistory = history.filter((item) => !item.isArchived && matches(item));
  const archivedHistory = history.filter((item) => item.isArchived && matches(item));

  const groupByTag = (items: HistoryItem[]) =>
    items.reduce((acc, item) => {
      const tag = item.tag || 'Untagged';
      (acc[tag] ||= []).push(item);
      return acc;
    }, {} as Record<string, HistoryItem[]>);
  const sortTags = (tags: string[]) =>
    tags.sort((a, b) => (a === 'Untagged' ? 1 : b === 'Untagged' ? -1 : a.localeCompare(b)));

  const groupedHistory = groupByTag(filteredHistory);
  const groupedArchivedHistory = groupByTag(archivedHistory);
  const sortedTags = sortTags(Object.keys(groupedHistory));
  const sortedArchivedTags = sortTags(Object.keys(groupedArchivedHistory));

  // Sidebar actions
  const handleNew = () => {
    transcriber.cancel();
    setCurrentId(null);
  };

  const loadHistoryItem = (item: HistoryItem) => {
    setCurrentId(item.id);
    transcriber.clearError();
    if (session && session.historyId !== item.id && !isTranscribing) transcriber.cancel();
  };

  const deleteHistoryItem = (e: ReactMouseEvent, id: string) => {
    e.stopPropagation();
    removeItem(id);
    if (currentId === id) setCurrentId(null);
    if (session?.historyId === id) transcriber.cancel();
  };

  const toggleArchiveStatus = (id: string) => {
    updateItem(id, (item) => ({ ...item, isArchived: !item.isArchived }));
    if (currentId === id) setCurrentId(null);
  };

  const archiveAllByTag = (tag: string) => {
    const inTag = (item: HistoryItem) => item.tag === tag || (tag === 'Untagged' && !item.tag);
    setHistory((prev) => prev.map((item) => (inTag(item) && !item.isArchived ? { ...item, isArchived: true } : item)));
    const current = history.find((h) => h.id === currentId);
    if (current && inTag(current)) setCurrentId(null);
  };

  const handleFileUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (!file) return;
    await startWith(file, file.type, file.name);
  };

  const error = transcriber.error || recorder.error;
  const fallbackModel = session
    ? models.find((m) => m.id !== session.options.model && m.recommended) ?? models.find((m) => m.id !== session.options.model)
    : undefined;
  const resumable =
    !!session &&
    (session.status === 'paused' || session.status === 'failed') &&
    session.nextChunkIndex < session.chunks.length;

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
                                  {item.model && (
                                    <span className="text-[10px] text-zinc-500 bg-zinc-100 px-1.5 py-0.5 rounded-sm truncate max-w-[110px]" title={item.model}>
                                      {modelLabel(item.model)}
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
                                      {modelLabel(item.model)}
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
                  aria-label={isSidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
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
                Record your voice or upload an audio file to get a speaker-labelled transcription you can edit, rename
                and export.
              </p>
            </div>

            <div className="space-y-8">
              {/* Model */}
              <div className="flex flex-col gap-2">
                <label htmlFor="model-select" className="text-sm font-semibold text-zinc-800">
                  AI Model
                </label>
                <div className="relative">
                  <select
                    id="model-select"
                    value={selectedModel}
                    onChange={(e) => setSelectedModel(e.target.value)}
                    disabled={isTranscribing}
                    className="w-full appearance-none bg-white border border-zinc-300 text-zinc-900 text-sm font-medium rounded-xl focus:ring-indigo-500 focus:border-indigo-500 block p-3 pr-8 transition-colors cursor-pointer shadow-xs disabled:opacity-60"
                  >
                    {models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                        {m.recommended ? ' (recommended)' : ''}
                      </option>
                    ))}
                  </select>
                  <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-3 text-zinc-500">
                    <ChevronDown className="h-4 w-4" />
                  </div>
                </div>
                {activeModelInfo && (
                  <p className="text-xs text-zinc-600 leading-relaxed px-1">{activeModelInfo.description}</p>
                )}
              </div>

              {/* Transcription options */}
              <div className="p-3.5 bg-zinc-50/80 border border-zinc-200 rounded-xl space-y-3">
                <div>
                  <span className="text-[11px] font-medium text-zinc-700 block mb-1.5">Transcription mode</span>
                  <div className="grid grid-cols-2 gap-1.5">
                    {(
                      [
                        ['verbatim', 'Strict Verbatim', 'Every utterance & word'],
                        ['clean', 'Clean Dialogue', 'Omit stutters & fillers'],
                      ] as const
                    ).map(([id, label, hint]) => (
                      <button
                        key={id}
                        type="button"
                        onClick={() => setTranscriptionStyle(id)}
                        disabled={isTranscribing}
                        aria-pressed={transcriptionStyle === id}
                        className={`px-2.5 py-1.5 text-xs rounded-lg font-medium transition-all text-left flex flex-col disabled:opacity-60 ${
                          transcriptionStyle === id
                            ? 'bg-indigo-600 text-white shadow-sm ring-2 ring-indigo-600/20'
                            : 'bg-white text-zinc-700 border border-zinc-200 hover:bg-zinc-50'
                        }`}
                      >
                        <span className="font-semibold">{label}</span>
                        <span className={`text-[10px] ${transcriptionStyle === id ? 'text-indigo-100' : 'text-zinc-500'}`}>
                          {hint}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label htmlFor="language-select" className="text-[11px] font-medium text-zinc-700 block mb-1.5">
                      Language
                    </label>
                    <select
                      id="language-select"
                      value={language}
                      onChange={(e) => setLanguage(e.target.value as LanguageHint)}
                      disabled={isTranscribing}
                      className="w-full bg-white border border-zinc-300 text-zinc-900 text-xs font-medium rounded-lg p-2 cursor-pointer disabled:opacity-60"
                    >
                      {(Object.keys(LANGUAGE_LABELS) as LanguageHint[]).map((l) => (
                        <option key={l} value={l}>
                          {LANGUAGE_LABELS[l]}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label htmlFor="speakers-input" className="text-[11px] font-medium text-zinc-700 block mb-1.5">
                      Number of speakers
                    </label>
                    <input
                      id="speakers-input"
                      type="number"
                      min={1}
                      max={12}
                      inputMode="numeric"
                      value={expectedSpeakers}
                      onChange={(e) => setExpectedSpeakers(e.target.value)}
                      disabled={isTranscribing}
                      placeholder="Auto"
                      className="w-full bg-white border border-zinc-300 text-zinc-900 text-xs font-medium rounded-lg p-2 disabled:opacity-60"
                    />
                  </div>
                </div>
                <p className="text-[11px] text-zinc-500 leading-snug">
                  Setting the language and speaker count, if you know them, improves accuracy and speaker separation.
                </p>
              </div>

              {/* Action Buttons */}
              <div className="flex flex-col sm:flex-row gap-4">
                {!isRecording ? (
                  <button
                    onClick={recorder.start}
                    disabled={isTranscribing}
                    aria-label="Start Recording"
                    className="flex-1 group relative flex items-center justify-center gap-3 h-14 rounded-xl bg-zinc-900 text-white hover:bg-zinc-800 transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-zinc-900 focus-visible:outline-none"
                  >
                    <Mic className="h-5 w-5" aria-hidden="true" />
                    <span className="font-medium">Start Recording</span>
                  </button>
                ) : (
                  <button
                    onClick={recorder.stop}
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
                  accept="audio/*,video/mp4,video/webm"
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
                          <span className="truncate">{transcriber.statusText}</span>
                        </div>
                        <button
                          type="button"
                          onClick={transcriber.pause}
                          className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold text-zinc-700 bg-white hover:bg-zinc-100 border border-zinc-200 rounded-md transition-colors shadow-2xs shrink-0 cursor-pointer"
                          title="Pause transcription"
                          aria-label="Pause transcription"
                        >
                          <Pause className="w-3 h-3 fill-current text-zinc-600" />
                          Pause
                        </button>
                      </div>
                      <div
                        className="w-full max-w-xs bg-zinc-100 rounded-full h-2 overflow-hidden"
                        role="progressbar"
                        aria-valuenow={transcriber.progress}
                        aria-valuemin={0}
                        aria-valuemax={100}
                      >
                        <motion.div
                          className="bg-zinc-900 h-full rounded-full"
                          initial={{ width: 0 }}
                          animate={{ width: `${transcriber.progress}%` }}
                          transition={{ ease: 'linear', duration: 0.5 }}
                        />
                      </div>
                    </motion.div>
                  )}
                  {!isTranscribing && !isRecording && transcriber.statusText === 'Complete!' && (
                    <motion.div
                      key="complete"
                      initial={{ opacity: 0, y: 5 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0 }}
                      className="flex items-center justify-center gap-2 text-sm font-medium text-emerald-700"
                    >
                      <Sparkles className="h-4 w-4" />
                      Complete!
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              {/* Resume card: continue from where it stopped */}
              <AnimatePresence>
                {resumable && session && (
                  <motion.div
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -6 }}
                    className={`rounded-2xl border p-5 space-y-4 shadow-sm ${
                      session.status === 'paused' ? 'bg-amber-50/70 border-amber-200/90' : 'bg-red-50/70 border-red-200/90'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-start gap-3">
                        <div
                          className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 mt-0.5 ${
                            session.status === 'paused' ? 'bg-amber-100 text-amber-800' : 'bg-red-100 text-red-800'
                          }`}
                        >
                          {session.status === 'paused' ? (
                            <Pause className="w-4 h-4 fill-current" />
                          ) : (
                            <AlertTriangle className="w-4 h-4" />
                          )}
                        </div>
                        <div>
                          <h3 className="text-sm font-semibold text-zinc-900">
                            {session.status === 'paused' ? 'Transcription Paused' : 'Transcription Stopped'}
                          </h3>
                          <p className="text-xs text-zinc-600 mt-0.5">
                            {session.nextChunkIndex > 0
                              ? `${session.nextChunkIndex} of ${session.chunks.length} part(s) transcribed (${Math.round((session.nextChunkIndex / session.chunks.length) * 100)}%).`
                              : 'Stopped before the first part completed.'}
                          </p>
                        </div>
                      </div>
                      <button
                        onClick={transcriber.cancel}
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
                        Ready to resume:{' '}
                        <strong>
                          Part {session.nextChunkIndex + 1} of {session.chunks.length}
                        </strong>
                      </span>
                      <span className="font-mono text-[11px] bg-zinc-100 px-2 py-0.5 rounded text-zinc-800 font-medium">
                        {formatSecondsToTime(session.chunks[session.nextChunkIndex].startTimeSec)} -{' '}
                        {formatSecondsToTime(session.chunks[session.nextChunkIndex].endTimeSec)}
                      </span>
                    </div>

                    <div className="flex flex-col gap-2 pt-1">
                      <button
                        type="button"
                        onClick={() => transcriber.resume()}
                        disabled={isTranscribing}
                        className="w-full flex items-center justify-center gap-2.5 h-12 rounded-xl bg-zinc-900 hover:bg-zinc-800 text-white font-medium text-xs sm:text-sm transition-all shadow-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-zinc-900 focus-visible:outline-none cursor-pointer"
                      >
                        <Play className="w-3.5 h-3.5 fill-current" />
                        <span>Continue from Part {session.nextChunkIndex + 1}</span>
                      </button>
                      {fallbackModel && (
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedModel(fallbackModel.id);
                            void transcriber.resume(fallbackModel.id);
                          }}
                          disabled={isTranscribing}
                          className="w-full flex items-center justify-center gap-2 h-9 rounded-lg bg-white border border-zinc-200 hover:bg-zinc-50 text-zinc-700 text-xs font-medium transition-all shadow-2xs cursor-pointer"
                        >
                          <Sparkles className="w-3.5 h-3.5 text-indigo-600" />
                          <span>Continue with {fallbackModel.name} instead</span>
                        </button>
                      )}
                    </div>
                  </motion.div>
                )}

                {/* General errors when there is no resumable session */}
                {error && !resumable && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    className="overflow-hidden"
                  >
                    <div className="rounded-xl bg-red-50 border border-red-200 p-4 mt-4" role="alert">
                      <div className="flex items-start gap-3">
                        <AlertCircle className="h-5 w-5 text-red-700 shrink-0 mt-0.5" aria-hidden="true" />
                        <p className="text-sm text-red-900 leading-relaxed font-medium">{error}</p>
                      </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {storageError && (
                <div className="rounded-xl bg-amber-50 border border-amber-200 p-3 text-xs text-amber-900" role="alert">
                  {storageError}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Right Column: Output */}
        <div className="flex-1 p-4 lg:p-8 xl:p-12 flex flex-col h-[60vh] lg:h-screen">
          <div className="flex-1 flex flex-col bg-white rounded-2xl border border-zinc-200 shadow-sm overflow-hidden relative">
            <TranscriptPanel
              item={currentItem}
              session={session}
              isTranscribing={isTranscribing}
              audioUrl={audioUrl}
              onTitle={(title) => currentId && updateItem(currentId, (i) => ({ ...i, title }))}
              onTag={(tag) => currentId && updateItem(currentId, (i) => ({ ...i, tag }))}
              onSegments={(fn) => currentId && updateItem(currentId, (i) => ({ ...i, segments: fn(i.segments) }))}
              onSpeakerNames={(fn) => currentId && updateItem(currentId, (i) => ({ ...i, speakerNames: fn(i.speakerNames) }))}
              onResume={() => void transcriber.resume()}
              onRetryChunk={(index) => void transcriber.retryChunk(index)}
            />
          </div>
        </div>
      </main>
    </div>
  );
}
