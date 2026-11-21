// Writing systems for map labels: which Natural Earth name field (or curated table) holds a language,
// the script family shown to players, and a strict character check so a label that claims to be
// "Thai" really is Thai (no Latin leaks, no wrong-script fallbacks). Reusable for any map game.

const R = {
  cyrillic: '\u0400-\u052F\u1C80-\u1C8F',
  greek: '\u0370-\u03FF\u1F00-\u1FFF',
  hebrew: '\u0590-\u05FF\uFB1D-\uFB4F',
  arabic: '\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF',
  devanagari: '\u0900-\u097F\uA8E0-\uA8FF',
  bengali: '\u0980-\u09FF',
  gurmukhi: '\u0A00-\u0A7F',
  gujarati: '\u0A80-\u0AFF',
  tamil: '\u0B80-\u0BFF',
  telugu: '\u0C00-\u0C7F',
  kannada: '\u0C80-\u0CFF',
  malayalam: '\u0D00-\u0D7F',
  sinhala: '\u0D80-\u0DFF',
  thai: '\u0E00-\u0E7F',
  lao: '\u0E80-\u0EFF',
  tibetan: '\u0F00-\u0FFF',
  myanmar: '\u1000-\u109F\uAA60-\uAA7F',
  georgian: '\u10A0-\u10FF\u1C90-\u1CBF',
  ethiopic: '\u1200-\u139F\u2D80-\u2DDF',
  khmer: '\u1780-\u17FF\u19E0-\u19FF',
  armenian: '\u0530-\u058F',
  thaana: '\u0780-\u07BF',
  hangul: '\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F',
  kana: '\u3040-\u30FF\u31F0-\u31FF',
  han: '\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF\u3005\u3006',
};
// Allowed in any label: spaces, hyphens/dashes, apostrophes, middle dots, digits, ZWJ/ZWNJ.
const COMMON = ' \\-\u2010-\u2015\'\u2019\u00B7\u30FB\u200C\u200D0-9';

/**
 * lang -> { family: what the UI says, ne: Natural Earth field suffix (null = curated table only), chars }
 * `family` deliberately names only the SCRIPT, never the language/country (Persian and Urdu both say
 * "Arabic", Serbian and Kazakh both say "Cyrillic") so the tag itself doesn't give the answer away.
 */
export const LANGS = {
  ru: { family: 'Cyrillic', ne: 'ru', chars: R.cyrillic },
  uk: { family: 'Cyrillic', ne: 'uk', chars: R.cyrillic },
  sr: { family: 'Cyrillic', ne: null, chars: R.cyrillic },
  bg: { family: 'Cyrillic', ne: null, chars: R.cyrillic },
  mk: { family: 'Cyrillic', ne: null, chars: R.cyrillic },
  mn: { family: 'Cyrillic', ne: null, chars: R.cyrillic },
  kk: { family: 'Cyrillic', ne: null, chars: R.cyrillic },
  el: { family: 'Greek', ne: 'el', chars: R.greek },
  he: { family: 'Hebrew', ne: 'he', chars: R.hebrew },
  ar: { family: 'Arabic', ne: 'ar', chars: R.arabic },
  fa: { family: 'Arabic', ne: 'fa', chars: R.arabic },
  ur: { family: 'Arabic', ne: 'ur', chars: R.arabic },
  hi: { family: 'Devanagari', ne: 'hi', chars: R.devanagari },
  mr: { family: 'Devanagari', ne: null, chars: R.devanagari },
  ne: { family: 'Devanagari', ne: null, chars: R.devanagari },
  bn: { family: 'Bengali', ne: 'bn', chars: R.bengali },
  pa: { family: 'Gurmukhi', ne: null, chars: R.gurmukhi },
  gu: { family: 'Gujarati', ne: null, chars: R.gujarati },
  ta: { family: 'Tamil', ne: null, chars: R.tamil },
  te: { family: 'Telugu', ne: null, chars: R.telugu },
  kn: { family: 'Kannada', ne: null, chars: R.kannada },
  ml: { family: 'Malayalam', ne: null, chars: R.malayalam },
  si: { family: 'Sinhala', ne: null, chars: R.sinhala },
  th: { family: 'Thai', ne: null, chars: R.thai },
  lo: { family: 'Lao', ne: null, chars: R.lao },
  km: { family: 'Khmer', ne: null, chars: R.khmer },
  my: { family: 'Burmese', ne: null, chars: R.myanmar },
  bo: { family: 'Tibetan', ne: null, chars: R.tibetan },
  ka: { family: 'Georgian', ne: null, chars: R.georgian },
  hy: { family: 'Armenian', ne: null, chars: R.armenian },
  am: { family: 'Ethiopic', ne: null, chars: R.ethiopic },
  ti: { family: 'Ethiopic', ne: null, chars: R.ethiopic },
  dv: { family: 'Thaana', ne: null, chars: R.thaana },
  zh: { family: 'Chinese', ne: 'zh', chars: R.han },
  zht: { family: 'Chinese', ne: 'zht', chars: R.han },
  ja: { family: 'Japanese', ne: 'ja', chars: R.han + R.kana },
  ko: { family: 'Hangul', ne: 'ko', chars: R.hangul },
};

const reCache = new Map();
/** True when every character of `text` belongs to the language's script (plus neutral punctuation). */
export function inScript(text, lang) {
  const L = LANGS[lang];
  if (!L || !text) return false;
  let re = reCache.get(lang);
  if (!re) { re = new RegExp(`^[${L.chars}${COMMON}]+$`, 'u'); reCache.set(lang, re); }
  // must also contain at least one real script character (not just digits/punctuation)
  return re.test(text) && new RegExp(`[${L.chars}]`, 'u').test(text);
}

/** Visual width estimate in em units (wide CJK/Hangul = 1, combining marks = 0, others ~0.6). */
export function textEm(text) {
  let w = 0;
  for (const ch of text) {
    if (/\p{M}/u.test(ch) || ch === '\u200C' || ch === '\u200D') continue;
    if (/[\u1100-\u11FF\u2E80-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\u3040-\u30FF]/.test(ch)) w += 1.0;
    else if (/[\u0E00-\u0EFF\u1000-\u109F\u1780-\u17FF\u0F00-\u0FFF\u1200-\u139F\u0D80-\u0DFF\u0B80-\u0D7F]/.test(ch)) w += 0.68;
    else w += 0.6;
  }
  return w;
}
