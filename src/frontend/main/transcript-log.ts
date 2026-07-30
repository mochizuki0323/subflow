/**
 * The one record of what has been transcribed.
 *
 * The control panel's history tab and the floating history window each kept their
 * own copy, built from the same broadcast but with different caps and different
 * partial handling — so the two "histories" showed different text, different
 * lengths, and clearing one did nothing to the other. Neither could be exported,
 * because neither owned anything. This does.
 */
export interface TranscriptEntry {
  text: string;
  translated?: string;
  speaker?: number;
  partial: boolean;
  /** Backend media time in ms; both ends are real for local and remote Parakeet. */
  t0: number;
  t1: number;
  /** Wall-clock arrival, for display. */
  at: number;
}

const MAX_ENTRIES = 2000;

export class TranscriptLog {
  private entries: TranscriptEntry[] = [];

  /** A partial replaces the partial before it; a final one closes the line. */
  push(segment: {
    text?: string;
    translated_text?: string;
    speaker?: number;
    partial?: boolean;
    t0?: number;
    t1?: number;
  }): void {
    const text = (segment.text || '').trim();
    if (!text) return;
    const entry: TranscriptEntry = {
      text,
      translated: segment.translated_text?.trim() || undefined,
      speaker: segment.speaker,
      partial: !!segment.partial,
      t0: segment.t0 ?? 0,
      t1: segment.t1 ?? 0,
      at: Date.now(),
    };
    const last = this.entries[this.entries.length - 1];
    if (last?.partial) this.entries[this.entries.length - 1] = entry;
    else this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
  }

  all(): TranscriptEntry[] {
    return this.entries;
  }

  /** Only settled lines are worth keeping in a file. */
  finals(): TranscriptEntry[] {
    return this.entries.filter((e) => !e.partial);
  }

  clear(): void {
    this.entries = [];
  }
}

function srtTime(ms: number): string {
  const clamped = Math.max(0, Math.round(ms));
  const h = String(Math.floor(clamped / 3600000)).padStart(2, '0');
  const m = String(Math.floor(clamped / 60000) % 60).padStart(2, '0');
  const s = String(Math.floor(clamped / 1000) % 60).padStart(2, '0');
  return `${h}:${m}:${s},${String(clamped % 1000).padStart(3, '0')}`;
}

export function toSrt(entries: TranscriptEntry[]): string {
  return entries
    .map((e, i) => {
      // A zero-length cue is not renderable, so give it a readable minimum.
      const start = e.t0;
      const end = e.t1 > e.t0 ? e.t1 : e.t0 + 1500;
      const body = e.translated ? `${e.text}\n${e.translated}` : e.text;
      return `${i + 1}\n${srtTime(start)} --> ${srtTime(end)}\n${body}\n`;
    })
    .join('\n');
}

export function toText(entries: TranscriptEntry[]): string {
  return entries
    .map((e) => {
      const stamp = new Date(e.at).toTimeString().slice(0, 8);
      const speaker = e.speaker !== undefined && e.speaker >= 0 ? ` S${e.speaker + 1}` : '';
      const body = e.translated ? `${e.text}\n${' '.repeat(11)}${e.translated}` : e.text;
      return `[${stamp}]${speaker} ${body}`;
    })
    .join('\n');
}
