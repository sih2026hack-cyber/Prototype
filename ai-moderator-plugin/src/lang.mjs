// Cheap script detection, so a suggestion is always in the writer's own script
// (Hindi in, Hindi out). Pure code — no model involved.
const SCRIPTS = [
  ['latin', /[a-zA-ZÀ-ɏ]/g],
  ['cyrillic', /[Ѐ-ӿ]/g],
  ['cjk', /[぀-ヿ㐀-鿿가-힯]/g],
  ['devanagari', /[ऀ-ॿ]/g],
  ['bengali', /[ঀ-৿]/g],
  ['gurmukhi', /[਀-੿]/g],
  ['gujarati', /[઀-૿]/g],
  ['tamil', /[஀-௿]/g],
  ['telugu', /[ఀ-౿]/g],
  ['kannada', /[ಀ-೿]/g],
  ['malayalam', /[ഀ-ൿ]/g],
  ['arabic', /[؀-ۿ]/g],
];

export function dominantScript(text) {
  let best = 'other', bestCount = 0;
  for (const [name, re] of SCRIPTS) {
    const count = (String(text).match(re) || []).length;
    if (count > bestCount) { best = name; bestCount = count; }
  }
  return best;
}

/** True when `output` is in the same script as `input` (or input has no letters). */
export function sameScript(input, output) {
  const script = dominantScript(input);
  return script === 'other' || dominantScript(output) === script;
}
