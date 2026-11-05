import { Download, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { ExportDoc, ExportFormat, exportDoc } from '../utils/export';
import { Popover } from './Popover';

const FORMATS: Array<{ id: ExportFormat; label: string; hint: string }> = [
  { id: 'docx', label: 'Word (.docx)', hint: 'Formatted document, Arabic-aware' },
  { id: 'srt', label: 'Subtitles (.srt)', hint: 'For video editors and players' },
  { id: 'vtt', label: 'Subtitles (.vtt)', hint: 'For web video' },
  { id: 'txt', label: 'Plain text (.txt)', hint: 'Speaker: text' },
  { id: 'md', label: 'Markdown (.md)', hint: 'With heading and bold speakers' },
  { id: 'json', label: 'JSON (.json)', hint: 'Structured data with timestamps' },
];

export function ExportMenu({ doc, approxTimestamps }: { doc: ExportDoc; approxTimestamps?: boolean }) {
  const [timestamps, setTimestamps] = useState(true);
  const [busy, setBusy] = useState<ExportFormat | null>(null);
  const [error, setError] = useState('');

  const run = async (format: ExportFormat, close: () => void) => {
    setBusy(format);
    setError('');
    try {
      await exportDoc(doc, format, { timestamps });
      close();
    } catch (err) {
      console.error('Export failed:', err);
      setError('Export failed. Please try again.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Popover
      ariaLabel="Export transcript"
      title="Export transcript"
      widthClass="w-64"
      label={
        <>
          <Download className="h-3.5 w-3.5" aria-hidden="true" />
          Export
        </>
      }
    >
      {(close) => (
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-xs text-zinc-700 px-1 pb-2 border-b border-zinc-100 cursor-pointer">
            <input
              type="checkbox"
              checked={timestamps}
              onChange={(e) => setTimestamps(e.target.checked)}
              className="rounded border-zinc-300"
            />
            Include timestamps (txt, md, docx)
          </label>
          {approxTimestamps && (
            <p className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-2 py-1.5 leading-snug">
              Timestamps in this transcript are approximate, so subtitle timing will be rough.
            </p>
          )}
          <ul className="space-y-0.5">
            {FORMATS.map((f) => (
              <li key={f.id}>
                <button
                  type="button"
                  onClick={() => run(f.id, close)}
                  disabled={busy !== null}
                  className="w-full text-left px-2 py-1.5 rounded-lg hover:bg-zinc-50 disabled:opacity-60 flex items-center justify-between gap-2"
                >
                  <span>
                    <span className="block text-xs font-medium text-zinc-900">{f.label}</span>
                    <span className="block text-[11px] text-zinc-500">{f.hint}</span>
                  </span>
                  {busy === f.id && <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-500" />}
                </button>
              </li>
            ))}
          </ul>
          {error && <p className="text-[11px] text-red-700 px-1">{error}</p>}
        </div>
      )}
    </Popover>
  );
}
