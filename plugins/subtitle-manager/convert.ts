/** Pure-TypeScript SRT / ASS / SSA → WebVTT conversion. */

export type TextSubtitleFormat = 'srt' | 'vtt' | 'ass' | 'ssa';

interface Cue {
  start: number;
  end: number;
  text: string;
  settings?: string;
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

export function formatTimestamp(ms: number): string {
  const total = Math.max(0, Math.round(ms));
  const h = Math.floor(total / 3_600_000);
  const m = Math.floor((total % 3_600_000) / 60_000);
  const s = Math.floor((total % 60_000) / 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(total % 1000, 3)}`;
}

function normalizeNewlines(input: string): string {
  return input.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
}

/** Escapes text while keeping `<i>`, `<b>` and `<u>` (normalised to lower case). */
function escapeCueText(text: string): string {
  return text
    .split(/(<\/?[ibu]>)/i)
    .map((part, i) =>
      i % 2 === 1
        ? part.toLowerCase()
        : part
            .replace(/&(?!(?:amp|lt|gt|nbsp|lrm|rlm|#\d+|#x[0-9a-f]+);)/gi, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;'),
    )
    .join('');
}

function cleanLines(text: string): string {
  return text
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .filter((l) => l !== '')
    .join('\n');
}

function renderCues(cues: Cue[]): string {
  const seen = new Set<string>();
  const body = cues
    .filter((c) => c.text !== '' && c.end > c.start)
    .sort((a, b) => a.start - b.start || a.end - b.end)
    .filter((c) => {
      const key = `${c.start}|${c.end}|${c.text}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((c) => `${formatTimestamp(c.start)} --> ${formatTimestamp(c.end)}${c.settings ? ` ${c.settings}` : ''}\n${c.text}`)
    .join('\n\n');
  return `WEBVTT\n\n${body}${body ? '\n' : ''}`;
}

// ── SRT ──────────────────────────────────────────────────────────────────────

const SRT_TIME = '(?:(\\d{1,2}):)?(\\d{1,2}):(\\d{1,2})(?:[,.](\\d{1,3}))?';
const SRT_TIMING = new RegExp(`^\\s*${SRT_TIME}\\s*-->\\s*${SRT_TIME}`);

function srtMs(h?: string, m?: string, s?: string, frac?: string): number {
  const fraction = frac ? Number(frac.padEnd(3, '0')) : 0;
  return Number(h ?? 0) * 3_600_000 + Number(m ?? 0) * 60_000 + Number(s ?? 0) * 1000 + fraction;
}

function convertSrtText(raw: string): { text: string; settings?: string } {
  let settings: string | undefined;
  const alignment = raw.match(/\{\\an([1-9])\}/);
  if (alignment) {
    const n = Number(alignment[1]);
    if (n >= 7) settings = 'line:5%';
    else if (n >= 4) settings = 'line:50%';
  }
  const text = raw
    .replace(/\{\\[^}]*\}/g, '') // ASS-style override tags some SRTs carry
    .replace(/<\/?font[^>]*>/gi, '')
    .replace(/<(?!\/?[ibu]>)[^>]*>/gi, '') // any other tag
    .replace(/-->/g, '→');
  return { text: escapeCueText(cleanLines(text)), settings };
}

export function srtToVtt(input: string): string {
  const lines = normalizeNewlines(input).split('\n');
  const cues: Cue[] = [];
  let current: { start: number; end: number; lines: string[] } | null = null;

  const flush = () => {
    if (current) {
      const { text, settings } = convertSrtText(current.lines.join('\n'));
      cues.push({ start: current.start, end: current.end, text, settings });
    }
    current = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const timing = line.match(SRT_TIMING);
    if (timing) {
      flush();
      current = {
        start: srtMs(timing[1], timing[2], timing[3], timing[4]),
        end: srtMs(timing[5], timing[6], timing[7], timing[8]),
        lines: [],
      };
      continue;
    }
    if (!current) continue;
    if (line.trim() === '') {
      flush();
      continue;
    }
    // Cue numbers without a separating blank line: "12" followed by a timing line.
    if (/^\s*\d+\s*$/.test(line) && SRT_TIMING.test(lines[i + 1] ?? '')) {
      flush();
      continue;
    }
    current.lines.push(line);
  }
  flush();
  return renderCues(cues);
}

// ── ASS / SSA ────────────────────────────────────────────────────────────────

function assMs(time: string): number | undefined {
  const m = time.trim().match(/^(\d+):(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/);
  if (!m) return undefined;
  const frac = m[4] ? Number(m[4].padEnd(3, '0').slice(0, 3)) : 0;
  return Number(m[1]) * 3_600_000 + Number(m[2]) * 60_000 + Number(m[3]) * 1000 + frac;
}

function convertAssText(raw: string, styleItalic: boolean): { text: string; settings?: string } | null {
  // Vector drawings (\p1...) are typesetting, not dialogue.
  if (/\{[^}]*\\p[1-9][^}]*\}/.test(raw)) return null;

  let settings: string | undefined;
  let italic = false;
  let bold = false;
  let out = '';

  const parts = raw.split(/(\{[^}]*\})/);
  for (const part of parts) {
    if (part.startsWith('{') && part.endsWith('}')) {
      for (const tag of part.slice(1, -1).split('\\').slice(1)) {
        const t = tag.trim();
        const an = t.match(/^an([1-9])$/);
        if (an) {
          const n = Number(an[1]);
          settings = n >= 7 ? 'line:5%' : n >= 4 ? 'line:50%' : undefined;
        } else if (/^i1$/.test(t) && !italic) {
          out += '<i>';
          italic = true;
        } else if (/^i0?$/.test(t) && italic) {
          out += '</i>';
          italic = false;
        } else if (/^b([1-9]\d*)$/.test(t) && t !== 'b0' && !bold) {
          out += '<b>';
          bold = true;
        } else if (/^b0?$/.test(t) && bold) {
          out += '</b>';
          bold = false;
        } else if (t === 'r') {
          if (bold) out += '</b>';
          if (italic) out += '</i>';
          bold = italic = false;
        }
      }
      continue;
    }
    out += part
      .replace(/\\[Nn]/g, '\n')
      .replace(/\\h/g, ' ')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
  if (bold) out += '</b>';
  if (italic) out += '</i>';

  let text = cleanLines(out.replace(/-->/g, '→'))
    .replace(/<(i|b)>\s*<\/\1>/g, '')
    .trim();
  if (!text.replace(/<\/?[ib]>/g, '').trim()) return null;
  if (styleItalic && !text.startsWith('<i>')) text = `<i>${text}</i>`;
  return { text, settings };
}

export function assToVtt(input: string): string {
  const lines = normalizeNewlines(input).split('\n');
  const cues: Cue[] = [];
  const italicStyles = new Set<string>();
  let section = '';
  let styleFormat: string[] = [];
  let eventFormat: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const header = line.match(/^\[(.+)\]$/);
    if (header) {
      section = header[1]!.toLowerCase();
      continue;
    }
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (section.includes('styles')) {
      if (key === 'format') styleFormat = value.split(',').map((s) => s.trim().toLowerCase());
      else if (key === 'style' && styleFormat.length) {
        const fields = value.split(',');
        const name = fields[styleFormat.indexOf('name')]?.trim();
        const italic = fields[styleFormat.indexOf('italic')]?.trim();
        if (name && (italic === '-1' || italic === '1')) italicStyles.add(name.toLowerCase());
      }
    } else if (section === 'events') {
      if (key === 'format') {
        eventFormat = value.split(',').map((s) => s.trim().toLowerCase());
      } else if (key === 'dialogue') {
        const format = eventFormat.length
          ? eventFormat
          : ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];
        const textIndex = format.indexOf('text');
        const fields = value.split(',');
        // The Text field is last and may itself contain commas.
        const head = fields.slice(0, textIndex);
        const text = fields.slice(textIndex).join(',');
        const start = assMs(head[format.indexOf('start')] ?? '');
        const end = assMs(head[format.indexOf('end')] ?? '');
        if (start === undefined || end === undefined) continue;
        const style = (head[format.indexOf('style')] ?? '').trim().toLowerCase().replace(/^\*/, '');
        const converted = convertAssText(text, italicStyles.has(style));
        if (converted) cues.push({ start, end, ...converted });
      }
    }
  }
  return renderCues(cues);
}

// ── WebVTT ───────────────────────────────────────────────────────────────────

export function normalizeVtt(input: string): string {
  const text = normalizeNewlines(input).trimStart();
  return text.startsWith('WEBVTT') ? `${text.trimEnd()}\n` : `WEBVTT\n\n${text.trimEnd()}\n`;
}

export function toWebVtt(content: string, format: TextSubtitleFormat): string {
  switch (format) {
    case 'srt':
      return srtToVtt(content);
    case 'ass':
    case 'ssa':
      return assToVtt(content);
    case 'vtt':
      return normalizeVtt(content);
  }
}
