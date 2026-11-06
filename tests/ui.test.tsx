// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';
import { TranscriptPanel } from '../src/components/TranscriptPanel';
import { HistoryItem } from '../src/hooks/useHistory';
import { Segment } from '../src/shared/transcript';

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

const seg = (id: string, speaker: string, start: number, text: string): Segment => ({ id, speaker, start, text });

const baseItem = (): HistoryItem => ({
  id: 'x1',
  title: 'Interview',
  date: '2026-11-05T10:00:00Z',
  content: '',
  segments: [
    seg('a', 'Speaker 1', 0, 'Welcome to the Beacoya session.'),
    seg('b', 'Speaker 2', 12, 'Thank you for having me.'),
    seg('c', 'Speaker 1', 20, 'Um, I I think we should begin.'),
  ],
  speakerNames: {},
  flags: [],
  model: 'gemini-3.7-flash',
});

function Harness({ initial, onRetry = () => {} }: { initial: HistoryItem; onRetry?: (i: number) => void }) {
  const [item, setItem] = useState(initial);
  return (
    <TranscriptPanel
      item={item}
      session={
        item.flags.length
          ? ({ historyId: item.id, status: 'completed', chunks: [{}, {}], nextChunkIndex: 2 } as any)
          : null
      }
      isTranscribing={false}
      audioUrl={null}
      onTitle={(title) => setItem((i) => ({ ...i, title }))}
      onTag={(tag) => setItem((i) => ({ ...i, tag }))}
      onSegments={(fn) => setItem((i) => ({ ...i, segments: fn(i.segments) }))}
      onSpeakerNames={(fn) => setItem((i) => ({ ...i, speakerNames: fn(i.speakerNames) }))}
      onResume={() => {}}
      onRetryChunk={onRetry}
    />
  );
}

describe('TranscriptPanel', () => {
  it('renders turns and lets the user edit text', async () => {
    const user = userEvent.setup();
    render(<Harness initial={baseItem()} />);

    expect(screen.getByText('Welcome to the Beacoya session.')).toBeTruthy();
    await user.click(screen.getByText('Welcome to the Beacoya session.'));
    const box = screen.getByLabelText('Edit transcript text');
    await user.clear(box);
    await user.type(box, 'Welcome to the Becoya session.');
    await user.tab(); // blur commits

    expect(screen.getByText('Welcome to the Becoya session.')).toBeTruthy();
  });

  it('renames a speaker everywhere', async () => {
    const user = userEvent.setup();
    render(<Harness initial={baseItem()} />);

    await user.click(screen.getByRole('button', { name: 'Rename speakers' }));
    const input = screen.getByLabelText('Name for Speaker 1');
    await user.type(input, 'Moderator');
    await user.tab();

    // Both Speaker 1 turns now show the new name in their selects.
    const selects = screen.getAllByRole('combobox');
    const labels = selects.map((s) => (s as HTMLSelectElement).selectedOptions[0].textContent);
    expect(labels).toEqual(['Moderator', 'Speaker 2', 'Moderator']);
  });

  it('swaps two speakers across all turns in one click', async () => {
    const user = userEvent.setup();
    render(<Harness initial={baseItem()} />);

    const selectsBefore = screen.getAllByRole('combobox') as HTMLSelectElement[];
    expect(selectsBefore.map((s) => s.value)).toEqual(['Speaker 1', 'Speaker 2', 'Speaker 1']);

    await user.click(screen.getByRole('button', { name: 'Rename speakers' }));
    await user.click(screen.getByRole('button', { name: /swap speaker 1 ⇄ speaker 2/i }));

    const selectsAfter = screen.getAllByRole('combobox') as HTMLSelectElement[];
    expect(selectsAfter.map((s) => s.value)).toEqual(['Speaker 2', 'Speaker 1', 'Speaker 2']);
  });

  it('reassigns a single turn to another speaker', async () => {
    const user = userEvent.setup();
    render(<Harness initial={baseItem()} />);
    const selects = screen.getAllByRole('combobox') as HTMLSelectElement[];
    await user.selectOptions(selects[1], 'Speaker 1');
    expect((screen.getAllByRole('combobox') as HTMLSelectElement[])[1].value).toBe('Speaker 1');
  });

  it('replaces text across turns and can undo', async () => {
    const user = userEvent.setup();
    render(<Harness initial={baseItem()} />);

    await user.click(screen.getByRole('button', { name: 'Find and replace' }));
    await user.type(screen.getByLabelText('Find'), 'beacoya');
    await user.type(screen.getByLabelText('Replace with'), 'Becoya');
    await user.click(screen.getByRole('button', { name: 'Replace all' }));

    expect(screen.getByText('Welcome to the Becoya session.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /undo/i }));
    expect(screen.getByText('Welcome to the Beacoya session.')).toBeTruthy();
  });

  it('cleans fillers and can undo', async () => {
    const user = userEvent.setup();
    render(<Harness initial={baseItem()} />);
    await user.click(screen.getByRole('button', { name: /clean up/i }));
    expect(screen.getByText('I think we should begin.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /undo/i }));
    expect(screen.getByText('Um, I I think we should begin.')).toBeTruthy();
  });

  it('offers every export format', async () => {
    const user = userEvent.setup();
    render(<Harness initial={baseItem()} />);
    await user.click(screen.getByRole('button', { name: 'Export transcript' }));
    for (const label of ['Word (.docx)', 'Subtitles (.srt)', 'Subtitles (.vtt)', 'Plain text (.txt)', 'Markdown (.md)', 'JSON (.json)']) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });

  it('shows quality flags with a retry button instead of a fake confidence score', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    const item = {
      ...baseItem(),
      flags: [{ chunk: 1, startSec: 300, endSec: 600, code: 'low_coverage' as const, message: 'Only ~10 words/min were transcribed.' }],
    };
    render(<Harness initial={item} onRetry={onRetry} />);

    expect(screen.queryByText(/confidence/i)).toBeNull();
    await user.click(screen.getByText(/flagged 1 part/i));
    await user.click(screen.getByRole('button', { name: /retry part/i }));
    expect(onRetry).toHaveBeenCalledWith(1);
  });

  describe('suggest speaker fixes', () => {
    const answer = (body: any, ok = true, status = 200) =>
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok, status, json: async () => body })));

    const selectedLabels = () =>
      (screen.getAllByRole('combobox') as HTMLSelectElement[]).map((s) => s.selectedOptions[0].textContent);

    it('applies only valid suggestions, reports the true count, and can undo', async () => {
      const user = userEvent.setup();
      answer({
        corrections: [
          { id: 'a', speaker: 'Speaker 2' }, // a real change
          { id: 'b', speaker: 'Speaker 9' }, // unknown label: must be ignored
          { id: 'c', speaker: 'Speaker 1' }, // already that speaker: not a change
          { id: 'zzz', speaker: 'Speaker 1' }, // no such turn
        ],
      });
      render(<Harness initial={baseItem()} />);
      expect(selectedLabels()).toEqual(['Speaker 1', 'Speaker 2', 'Speaker 1']);

      await user.click(screen.getByRole('button', { name: 'Suggest speaker fixes' }));
      expect(await screen.findByText(/Changed the speaker on 1 turn\./)).toBeTruthy();
      expect(selectedLabels()).toEqual(['Speaker 2', 'Speaker 2', 'Speaker 1']);

      const [url, init] = (fetch as any).mock.calls[0];
      expect(url).toBe('/api/fix-speakers');
      const sent = JSON.parse(init.body);
      expect(sent.model).toBe('gemini-3.7-flash'); // the item's model is passed along
      expect(sent.segments[0]).toEqual({ id: 'a', speaker: 'Speaker 1', text: 'Welcome to the Beacoya session.' });

      await user.click(screen.getByRole('button', { name: /undo/i }));
      expect(selectedLabels()).toEqual(['Speaker 1', 'Speaker 2', 'Speaker 1']);
    });

    it('says so when there is nothing to change', async () => {
      const user = userEvent.setup();
      answer({ corrections: [{ id: 'a', speaker: 'Speaker 9' }] });
      render(<Harness initial={baseItem()} />);
      await user.click(screen.getByRole('button', { name: 'Suggest speaker fixes' }));
      expect(await screen.findByText(/No clear speaker mix-ups/)).toBeTruthy();
      expect(selectedLabels()).toEqual(['Speaker 1', 'Speaker 2', 'Speaker 1']);
    });

    it('shows the server error instead of failing silently', async () => {
      const user = userEvent.setup();
      answer({ error: 'The speaker check took too long. Please try again.' }, false, 500);
      render(<Harness initial={baseItem()} />);
      await user.click(screen.getByRole('button', { name: 'Suggest speaker fixes' }));
      expect(await screen.findByText(/took too long/)).toBeTruthy();
    });

    it('copes with a proxy HTML error page', async () => {
      const user = userEvent.setup();
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 504, json: async () => { throw new SyntaxError('<'); } })));
      render(<Harness initial={baseItem()} />);
      await user.click(screen.getByRole('button', { name: 'Suggest speaker fixes' }));
      expect(await screen.findByText(/HTTP 504/)).toBeTruthy();
    });
  });

  it('shows the empty state without an item', () => {
    render(<TranscriptPanel item={null} session={null} isTranscribing={false} audioUrl={null} onTitle={() => {}} onTag={() => {}} onSegments={() => {}} onSpeakerNames={() => {}} onResume={() => {}} onRetryChunk={() => {}} />);
    expect(screen.getByText('No transcription yet')).toBeTruthy();
  });
});

describe('App with a transcript saved by the old version', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ models: [{ id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash', shortLabel: '3.7 Flash', description: 'd', chunkSec: 300, recommended: true }] }) }));
    localStorage.setItem(
      'transcriptionHistory',
      JSON.stringify([
        {
          id: 'old1',
          title: 'Old interview',
          content: '### [0:00 - 5:00]\n\n**Speaker 1:** Hello there.\n\n**Speaker 2:** Hi, how are you?\n\n### [5:00 - 10:00]\n\n**Speaker 1:** Second part.',
          date: '2026-10-01T09:00:00Z',
          confidenceScore: 95,
          model: 'gemini-3.8-flash',
        },
      ])
    );
  });

  it('migrates it, hides the fake score, and allows renaming', async () => {
    const user = userEvent.setup();
    render(<App />);

    const sidebarItem = await screen.findByRole('button', { name: /load transcription: old interview/i });
    expect(within(sidebarItem).queryByText('95%')).toBeNull();
    // Known models show a short label; a retired id would fall back to showing the raw id.
    expect(within(sidebarItem).getByText('3.8 Flash')).toBeTruthy();

    await user.click(sidebarItem);
    expect(screen.getByText('Hello there.')).toBeTruthy();
    expect(screen.getByText('Second part.')).toBeTruthy();
    expect(screen.getByText(/saved by an earlier version/i)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Rename speakers' }));
    await user.type(screen.getByLabelText('Name for Speaker 2'), 'Dr. Ali');
    await user.tab();
    expect(screen.getAllByRole('combobox').some((s) => (s as HTMLSelectElement).selectedOptions[0]?.textContent === 'Dr. Ali')).toBe(true);
  });

  it('shows only models the server reports as usable', async () => {
    render(<App />);
    const select = (await screen.findByLabelText('AI Model')) as HTMLSelectElement;
    await vi.waitFor(() => expect(select.options.length).toBe(1));
    expect(select.options[0].textContent).toContain('Gemini 3.7 Flash');
  });
});
