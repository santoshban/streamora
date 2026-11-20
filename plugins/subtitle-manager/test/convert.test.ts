import { describe, expect, it } from 'vitest';
import { assToVtt, formatTimestamp, normalizeVtt, srtToVtt } from '../convert.js';
import { normalizeLanguage } from '../languages.js';
import { parseSidecarName } from '../sidecar.js';

describe('srtToVtt', () => {
  it('converts timings, tags and escaping', () => {
    const srt =
      '﻿1\r\n00:00:01,000 --> 00:00:04,500\r\n<i>Hello</i> <font color="#ffff00">world</font> & friends\r\n\r\n' +
      '2\r\n00:00:05,1 --> 00:00:06,250 X1:100 X2:200\r\n{\\an8}Top line <3\r\nSecond line\r\n\r\n' +
      // no blank line before the next cue number
      '3\n00:01:02,000 --> 00:01:03,000\nThird\n4\n1:02:03,004 --> 1:02:04,000\n<B>Bold</B>\n';
    expect(srtToVtt(srt)).toBe(
      'WEBVTT\n\n' +
        '00:00:01.000 --> 00:00:04.500\n<i>Hello</i> world &amp; friends\n\n' +
        '00:00:05.100 --> 00:00:06.250 line:5%\nTop line &lt;3\nSecond line\n\n' +
        '00:01:02.000 --> 00:01:03.000\nThird\n\n' +
        '01:02:03.004 --> 01:02:04.000\n<b>Bold</b>\n',
    );
  });

  it('drops empty and inverted cues', () => {
    const srt = '1\n00:00:02,000 --> 00:00:01,000\nBackwards\n\n2\n00:00:03,000 --> 00:00:04,000\n<font></font>\n\n';
    expect(srtToVtt(srt)).toBe('WEBVTT\n\n');
  });
});

describe('assToVtt', () => {
  const ass = `[Script Info]
ScriptType: v4.00+

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline
Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0
Style: Thoughts,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,-1,0

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:05.00,0:00:07.50,Default,,0,0,0,,Second, with a comma\\Nand a new line
Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\an8}{\\i1}Hello{\\i0} there & <you>
Comment: 0,0:00:02.00,0:00:03.00,Default,,0,0,0,,This is a comment
Dialogue: 0,0:00:03.00,0:00:04.00,Default,,0,0,0,,{\\p1}m 0 0 l 100 0 100 100{\\p0}
Dialogue: 0,0:00:08.00,0:00:09.00,Thoughts,,0,0,0,,I wonder...
Dialogue: 0,0:00:10.00,0:00:11.00,Default,,0,0,0,,{\\b1}Loud{\\b0} quiet\\hspace
`;

  it('converts dialogue, styling and positioning; skips comments and drawings', () => {
    expect(assToVtt(ass)).toBe(
      'WEBVTT\n\n' +
        '00:00:01.000 --> 00:00:03.000 line:5%\n<i>Hello</i> there &amp; &lt;you&gt;\n\n' +
        '00:00:05.000 --> 00:00:07.500\nSecond, with a comma\nand a new line\n\n' +
        '00:00:08.000 --> 00:00:09.000\n<i>I wonder...</i>\n\n' +
        '00:00:10.000 --> 00:00:11.000\n<b>Loud</b> quiet space\n',
    );
  });
});

describe('helpers', () => {
  it('formats timestamps and normalises VTT', () => {
    expect(formatTimestamp(3_723_004)).toBe('01:02:03.004');
    expect(normalizeVtt('﻿00:00:01.000 --> 00:00:02.000\r\nHi')).toBe('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi\n');
    expect(normalizeVtt('WEBVTT\n\nx')).toBe('WEBVTT\n\nx\n');
  });

  it('normalises language codes to ISO 639-2/B', () => {
    expect(normalizeLanguage('en')).toBe('eng');
    expect(normalizeLanguage('English')).toBe('eng');
    expect(normalizeLanguage('fra')).toBe('fre');
    expect(normalizeLanguage('pt-BR')).toBe('por');
    expect(normalizeLanguage('zh_Hant')).toBe('chi');
    expect(normalizeLanguage('und')).toBeUndefined();
    expect(normalizeLanguage('klingon')).toBeUndefined();
  });

  it.each([
    ['Movie.en.srt', 'Movie', { language: 'eng', label: 'English', forced: false, hearingImpaired: false }],
    ['Movie.eng.forced.srt', 'Movie', { language: 'eng', forced: true, label: 'English (Forced)' }],
    ['Movie.English.SDH.srt', 'Movie', { language: 'eng', hearingImpaired: true, label: 'English (SDH)' }],
    ['Movie.en.hi.srt', 'Movie', { language: 'eng', hearingImpaired: true }],
    ['Movie.hi.srt', 'Movie', { language: 'hin', hearingImpaired: false }],
    ['Movie.pt-BR.srt', 'Movie', { language: 'por', label: 'Portuguese pt-BR' }],
    ['2_English.srt', null, { language: 'eng', label: 'English' }],
    ['Movie.en.Commentary.srt', 'Movie', { language: 'eng', label: 'English Commentary' }],
  ])('parses %s', (name, stem, expected) => {
    expect(parseSidecarName(name, stem)).toMatchObject(expected);
  });
});
