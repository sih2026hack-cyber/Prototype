// What the image file itself says about where it came from. Pure code, no model:
// when a file carries an AI label, that is a fact, not a guess.
//
// Reads only the file's metadata (JPEG segments before the image data, PNG chunks other
// than IDAT, WebP chunks other than the bitstream), so pixel bytes can never be mistaken
// for a label. Signatures on Content Credentials are NOT verified here: a label we report
// was found in the file, and the result says so.

const AI_SOURCE_TYPES = [
  // IPTC Digital Source Type terms, used in XMP and in C2PA assertions.
  'trainedAlgorithmicMedia',
  'compositeWithTrainedAlgorithmicMedia',
  'algorithmicMedia',
];

// Tools that write their name into the files they generate.
const GENERATORS = [
  'Midjourney', 'DALL-E', 'DALL·E', 'Stable Diffusion', 'Adobe Firefly', 'Imagen', 'Muse Image',
  'NovelAI', 'Leonardo.Ai', 'ComfyUI', 'Flux', 'Ideogram', 'Meta AI',
];

// PNG text keys that only image generators write.
const GENERATOR_PNG_KEYS = ['parameters', 'prompt', 'workflow', 'invokeai_metadata', 'sd-metadata'];

/** Image type, size and the metadata blocks of a JPEG, PNG or WebP file. */
export function readImage(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b[0] === 0xff && b[1] === 0xd8) return readJpeg(b);
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return readPng(b);
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return readWebp(b);
  if (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a') return readGif(b);
  return { type: 'unknown', width: null, height: null, blocks: [] };
}

// GIF metadata lives in application extensions; XMP is the one AI labels use ("XMP DataXMP").
function readGif(b) {
  const width = b[6] | (b[7] << 8), height = b[8] | (b[9] << 8), blocks = [];
  const at = Buffer.from(b.buffer, b.byteOffset, b.byteLength).indexOf('XMP DataXMP', 0, 'latin1');
  if (at >= 0) blocks.push({ kind: 'xmp', body: b.subarray(at, Math.min(b.length, at + 65536)) });
  return { type: 'gif', width, height, blocks };
}

function ascii(b, at, n) {
  let s = '';
  for (let i = at; i < at + n && i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
}
const u16 = (b, i) => (b[i] << 8) | b[i + 1];
const u32 = (b, i) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
const le32 = (b, i) => b[i] + (b[i + 1] << 8) + (b[i + 2] << 16) + ((b[i + 3] << 24) >>> 0);

function readJpeg(b) {
  const blocks = []; let width = null, height = null, i = 2;
  while (i + 4 <= b.length && b[i] === 0xff) {
    const marker = b[i + 1];
    if (marker === 0xd9 || marker === 0xda) break; // end of image / start of scan: pixel data follows
    if (marker >= 0xd0 && marker <= 0xd7) { i += 2; continue; }
    const len = u16(b, i + 2);
    const body = b.subarray(i + 4, i + 2 + len);
    // SOF0..SOF15 (not DHT/JPG/DAC) carry the size.
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) { height = u16(body, 1); width = u16(body, 3); }
    if (marker >= 0xe0 && marker <= 0xef) blocks.push({ kind: marker === 0xeb ? 'app11' : `app${marker - 0xe0}`, body });
    if (marker === 0xfe) blocks.push({ kind: 'comment', body });
    i += 2 + len;
  }
  return { type: 'jpeg', width, height, blocks };
}

function readPng(b) {
  const blocks = []; let width = null, height = null, i = 8;
  while (i + 8 <= b.length) {
    const len = u32(b, i), type = ascii(b, i + 4, 4), body = b.subarray(i + 8, i + 8 + len);
    if (type === 'IHDR') { width = u32(body, 0); height = u32(body, 4); }
    else if (type === 'IEND') break;
    else if (type !== 'IDAT') blocks.push({ kind: type, body });
    i += 12 + len;
  }
  return { type: 'png', width, height, blocks };
}

function readWebp(b) {
  const blocks = []; let width = null, height = null, i = 12;
  while (i + 8 <= b.length) {
    const type = ascii(b, i, 4), len = le32(b, i + 4), body = b.subarray(i + 8, i + 8 + len);
    if (type === 'VP8X') { width = 1 + (body[4] | (body[5] << 8) | (body[6] << 16)); height = 1 + (body[7] | (body[8] << 8) | (body[9] << 16)); }
    else if (type === 'VP8 ' && width === null) { width = (body[6] | (body[7] << 8)) & 0x3fff; height = (body[8] | (body[9] << 8)) & 0x3fff; }
    else if (type === 'VP8L' && width === null) { const v = le32(body, 1); width = (v & 0x3fff) + 1; height = ((v >> 14) & 0x3fff) + 1; }
    if (!['VP8 ', 'VP8L', 'ANMF', 'ALPH'].includes(type)) blocks.push({ kind: type, body });
    i += 8 + len + (len % 2);
  }
  return { type: 'webp', width, height, blocks };
}

// Metadata is text-ish (XMP, EXIF strings, JSON); decode as latin1 so every byte survives.
const text = body => Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString('latin1');

/**
 * What the file's own metadata says.
 * → { aiLabel: boolean, contentCredentials: boolean, signals: [{ kind, detail }] }
 * aiLabel = the file states it was made or edited with AI. contentCredentials = it carries
 * a C2PA manifest (signature not verified).
 */
export function provenance(bytes) {
  const img = readImage(bytes);
  const signals = [];
  let contentCredentials = false;
  for (const { kind, body } of img.blocks) {
    const t = text(body);
    const isC2pa = (kind === 'app11' && /jumb|c2pa/.test(t)) || kind === 'caBX' || kind === 'C2PA';
    if (isC2pa && !contentCredentials) { contentCredentials = true; signals.push({ kind: 'content-credentials', detail: 'The file carries Content Credentials (C2PA).' }); }
    for (const term of AI_SOURCE_TYPES) {
      if (t.includes(term)) {
        signals.push({ kind: 'ai-source-type', detail: term === 'compositeWithTrainedAlgorithmicMedia' ? 'The file says it was edited or combined with AI.' : 'The file says it was generated by AI.' });
        break;
      }
    }
    for (const name of GENERATORS) {
      if (t.includes(name)) { signals.push({ kind: 'generator', detail: `The file names an AI image tool: ${name}.` }); break; }
    }
    if (['tEXt', 'iTXt', 'zTXt'].includes(kind)) {
      const key = t.slice(0, t.indexOf('\0'));
      if (GENERATOR_PNG_KEYS.includes(key)) signals.push({ kind: 'generator-settings', detail: `The file holds image-generator settings ("${key}").` });
    }
  }
  const unique = signals.filter((s, i) => signals.findIndex(o => o.kind === s.kind && o.detail === s.detail) === i);
  return {
    type: img.type, width: img.width, height: img.height,
    aiLabel: unique.some(s => s.kind !== 'content-credentials'),
    contentCredentials,
    signals: unique,
  };
}
