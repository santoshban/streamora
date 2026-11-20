/**
 * Language lookup normalising to ISO 639-2/B (the form ffprobe/Matroska usually report).
 * Each row: [639-2/B, 639-1, 639-2/T or '', English name, ...aliases]
 */
const LANGUAGES: string[][] = [
  ['eng', 'en', '', 'english'],
  ['fre', 'fr', 'fra', 'french', 'francais', 'français', 'vf', 'vff'],
  ['ger', 'de', 'deu', 'german', 'deutsch'],
  ['spa', 'es', '', 'spanish', 'espanol', 'español', 'castilian', 'latino', 'es-419'],
  ['por', 'pt', '', 'portuguese', 'brazilian', 'pt-br', 'ptbr', 'pob'],
  ['ita', 'it', '', 'italian', 'italiano'],
  ['dut', 'nl', 'nld', 'dutch', 'nederlands', 'flemish'],
  ['swe', 'sv', '', 'swedish', 'svenska'],
  ['nor', 'no', '', 'norwegian', 'norsk', 'nb', 'nob', 'nn', 'nno'],
  ['dan', 'da', '', 'danish', 'dansk'],
  ['fin', 'fi', '', 'finnish', 'suomi'],
  ['ice', 'is', 'isl', 'icelandic'],
  ['pol', 'pl', '', 'polish', 'polski'],
  ['cze', 'cs', 'ces', 'czech'],
  ['slo', 'sk', 'slk', 'slovak'],
  ['hun', 'hu', '', 'hungarian', 'magyar'],
  ['rum', 'ro', 'ron', 'romanian'],
  ['bul', 'bg', '', 'bulgarian'],
  ['hrv', 'hr', '', 'croatian'],
  ['srp', 'sr', '', 'serbian'],
  ['slv', 'sl', '', 'slovenian'],
  ['bos', 'bs', '', 'bosnian'],
  ['mac', 'mk', 'mkd', 'macedonian'],
  ['alb', 'sq', 'sqi', 'albanian'],
  ['gre', 'el', 'ell', 'greek'],
  ['tur', 'tr', '', 'turkish'],
  ['rus', 'ru', '', 'russian'],
  ['ukr', 'uk', '', 'ukrainian'],
  ['est', 'et', '', 'estonian'],
  ['lav', 'lv', '', 'latvian'],
  ['lit', 'lt', '', 'lithuanian'],
  ['ara', 'ar', '', 'arabic'],
  ['heb', 'he', '', 'hebrew', 'iw'],
  ['per', 'fa', 'fas', 'persian', 'farsi'],
  ['hin', 'hi', '', 'hindi'],
  ['ben', 'bn', '', 'bengali'],
  ['tam', 'ta', '', 'tamil'],
  ['tel', 'te', '', 'telugu'],
  ['mal', 'ml', '', 'malayalam'],
  ['urd', 'ur', '', 'urdu'],
  ['tha', 'th', '', 'thai'],
  ['vie', 'vi', '', 'vietnamese'],
  ['ind', 'id', '', 'indonesian'],
  ['may', 'ms', 'msa', 'malay'],
  ['fil', 'tl', 'tgl', 'filipino', 'tagalog'],
  ['chi', 'zh', 'zho', 'chinese', 'mandarin', 'chs', 'cht', 'zh-cn', 'zh-tw', 'zh-hk', 'zh-hans', 'zh-hant', 'cantonese', 'yue'],
  ['jpn', 'ja', '', 'japanese', 'jp'],
  ['kor', 'ko', '', 'korean'],
  ['cat', 'ca', '', 'catalan'],
  ['baq', 'eu', 'eus', 'basque'],
  ['glg', 'gl', '', 'galician'],
  ['wel', 'cy', 'cym', 'welsh'],
  ['gle', 'ga', '', 'irish'],
  ['geo', 'ka', 'kat', 'georgian'],
  ['arm', 'hy', 'hye', 'armenian'],
  ['afr', 'af', '', 'afrikaans'],
  ['swa', 'sw', '', 'swahili'],
];

const LOOKUP = new Map<string, string>();
const NAMES = new Map<string, string>();
for (const [code, ...aliases] of LANGUAGES) {
  NAMES.set(code!, aliases[2]!.replace(/^\w/, (c) => c.toUpperCase()));
  for (const alias of [code!, ...aliases]) if (alias) LOOKUP.set(alias.toLowerCase(), code!);
}

/** `en`, `eng`, `English`, `pt-BR`, `zh_Hans` → ISO 639-2/B, or `undefined`. */
export function normalizeLanguage(input?: string | null): string | undefined {
  if (!input) return undefined;
  const value = input.trim().toLowerCase().replace(/_/g, '-');
  if (!value || value === 'und' || value === 'unknown' || value === 'zxx') return undefined;
  return LOOKUP.get(value) ?? LOOKUP.get(value.split('-')[0]!);
}

export function languageName(code?: string): string | undefined {
  return code ? NAMES.get(code) : undefined;
}
