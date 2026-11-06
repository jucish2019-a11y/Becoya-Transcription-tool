import { memo, useEffect, useRef, useState } from 'react';
import { ArrowLeftRight } from 'lucide-react';
import { Segment, formatTimestamp } from '../shared/transcript';
import { SpeakerNames, speakerLabel } from '../utils/transcript';

export const SPEAKER_STYLES = [
  'bg-indigo-50 text-indigo-800 border-indigo-200',
  'bg-emerald-50 text-emerald-800 border-emerald-200',
  'bg-amber-50 text-amber-900 border-amber-200',
  'bg-rose-50 text-rose-800 border-rose-200',
  'bg-sky-50 text-sky-800 border-sky-200',
  'bg-violet-50 text-violet-800 border-violet-200',
  'bg-teal-50 text-teal-800 border-teal-200',
  'bg-orange-50 text-orange-900 border-orange-200',
];

const NEW_SPEAKER = '__new__';

/** Next unused "Speaker N" id. */
export function nextSpeakerId(speakers: string[]): string {
  let max = 0;
  for (const s of speakers) {
    const m = s.match(/^Speaker (\d+)$/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `Speaker ${max + 1}`;
}

interface Props {
  seg: Segment;
  speakers: string[];
  names: SpeakerNames;
  colorIndex: number;
  isActive: boolean;
  canSeek: boolean;
  approxTime: boolean;
  onSeek: (time: number) => void;
  onEditText: (id: string, text: string) => void;
  onSetSpeaker: (id: string, speaker: string) => void;
}

export const SegmentRow = memo(function SegmentRow({
  seg,
  speakers,
  names,
  colorIndex,
  isActive,
  canSeek,
  approxTime,
  onSeek,
  onEditText,
  onSetSpeaker,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(seg.text);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!editing) setDraft(seg.text);
  }, [seg.text, editing]);

  useEffect(() => {
    const el = areaRef.current;
    if (editing && el) {
      el.style.height = 'auto';
      el.style.height = `${el.scrollHeight}px`;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }, [editing, draft]);

  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (next && next !== seg.text) onEditText(seg.id, next);
    else setDraft(seg.text);
  };

  const time = (approxTime ? '~' : '') + formatTimestamp(seg.start);

  return (
    <div
      className={`group flex gap-3 rounded-xl px-3 py-2.5 transition-colors ${
        isActive ? 'bg-indigo-50/60 ring-1 ring-indigo-200' : 'hover:bg-zinc-50'
      }`}
    >
      <div className="w-32 shrink-0 flex flex-col items-start gap-1">
        <div className="flex items-center gap-1 w-full">
          <select
            value={seg.speaker}
            onChange={(e) =>
              onSetSpeaker(seg.id, e.target.value === NEW_SPEAKER ? nextSpeakerId(speakers) : e.target.value)
            }
            aria-label={`Speaker for turn at ${time}`}
            className={`flex-1 min-w-0 text-xs font-semibold rounded-md border px-1.5 py-0.5 cursor-pointer truncate ${
              SPEAKER_STYLES[colorIndex % SPEAKER_STYLES.length]
            }`}
          >
            {speakers.map((sp) => (
              <option key={sp} value={sp}>
                {speakerLabel(sp, names)}
              </option>
            ))}
            <option value={NEW_SPEAKER}>+ New speaker</option>
          </select>
          {speakers.length === 2 && (
            <button
              type="button"
              onClick={() => onSetSpeaker(seg.id, speakers[0] === seg.speaker ? speakers[1] : speakers[0])}
              title={`Switch turn to ${speakerLabel(speakers[0] === seg.speaker ? speakers[1] : speakers[0], names)}`}
              className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-zinc-400 hover:text-indigo-600 hover:bg-indigo-50 transition-all shrink-0"
            >
              <ArrowLeftRight className="w-3 h-3" />
            </button>
          )}
        </div>
        {canSeek ? (
          <button
            type="button"
            onClick={() => onSeek(seg.start)}
            className="text-[11px] font-mono text-zinc-500 hover:text-indigo-700 hover:underline"
            title="Play from here"
          >
            {time}
          </button>
        ) : (
          <span className="text-[11px] font-mono text-zinc-500">{time}</span>
        )}
      </div>

      <div className="flex-1 min-w-0">
        {editing ? (
          <textarea
            ref={areaRef}
            dir="auto"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setDraft(seg.text);
                setEditing(false);
              } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                commit();
              }
            }}
            aria-label="Edit transcript text"
            className="w-full resize-none text-[15px] leading-relaxed text-zinc-900 bg-white border border-indigo-300 rounded-lg px-2 py-1 focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
          />
        ) : (
          <div
            dir="auto"
            role="button"
            tabIndex={0}
            onClick={() => setEditing(true)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') setEditing(true);
            }}
            title="Click to edit"
            className="text-[15px] leading-relaxed text-zinc-900 cursor-text rounded-lg px-2 py-1 -mx-2 -my-1 focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:outline-none"
          >
            {seg.text}
          </div>
        )}
      </div>
    </div>
  );
});
