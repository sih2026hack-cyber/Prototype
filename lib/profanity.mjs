// Display-time masking for abusive words. Stored evidence keeps the original text;
// the dashboard, PDF and chatbot receive masked copies.
// STEMS also match inflected forms (e.g. "fucking"); EXACT only matches whole words,
// because those roots are ordinary words when extended (e.g. Tamil "kuthikum" = jumping).
const STEMS = [
  // English
  'fuck', 'motherfuck', 'shit', 'bitch', 'bastard', 'asshole', 'cunt', 'whore', 'slut', 'retard',
  // Hindi / Urdu (romanised)
  'madarchod', 'maderchod', 'behenchod', 'bhenchod', 'chutiya', 'chutiye', 'bhosdi', 'bhosad', 'randi',
  // Tamil (romanised)
  'thevdiya', 'thevidiya', 'thevudiya', 'thevadiya', 'ommala', 'oommala', 'pundai', 'punda', 'sunni', 'koodhi', 'koothi',
  // Tamil script
  'தேவடியா', 'தேவிடியா', 'தேவுடியா', 'ஓம்மால', 'ஒம்மால', 'புண்ட', 'சுன்னி', 'கூதி',
];
const EXACT = ['dick', 'dickhead', 'gandu', 'lund', 'kuthi', 'kudhi', 'ஓத்தா'];
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const edge = '(?<![\\p{L}\\p{M}\\p{N}])';
const PATTERN = new RegExp(
  `${edge}(?:(?:${STEMS.map(esc).join('|')})[\\p{L}\\p{M}]*|(?:${EXACT.map(esc).join('|')})(?![\\p{L}\\p{M}\\p{N}]))`, 'giu');
const graphemes = s => typeof Intl.Segmenter === 'function' ? [...new Intl.Segmenter('und', {granularity: 'grapheme'}).segment(s)].map(x => x.segment) : [...s];
const maskWord = word => { const g = graphemes(word); return g[0] + '*'.repeat(Math.max(1, g.length - 1)); };

export function maskProfanity(text) {
  if (typeof text !== 'string' || !text) return {text, masked: 0};
  let masked = 0;
  const out = text.replace(PATTERN, word => { masked++; return maskWord(word); });
  return {text: out, masked};
}
export const maskText = text => maskProfanity(text).text;

// Returns a masked copy of a stored record; `abusive` marks records whose own text was masked.
export function maskRecord(post) {
  const body = maskProfanity(post.text);
  const copy = {...post, text: body.text, abusive: body.masked > 0};
  for (const field of ['topic', 'topic_summary', 'topic_keywords', 'context_title', 'title', 'nlp_text']) if (typeof copy[field] === 'string') copy[field] = maskText(copy[field]);
  if (copy.nuance?.target) copy.nuance = {...copy.nuance, target: maskText(copy.nuance.target)};
  return copy;
}
