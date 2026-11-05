// Argus Lens: is this image or video AI-generated, and is it harmful to post? With the evidence.
//
//   file metadata ──► provenance()  (code: certain when a label is present)
//   image ─────────► Muse Spark    (model: careful assessment + where the signs are)
//   each sign ─────► SAM 3.1       (model: the exact outline of that area)
//   video ─────────► Muse Spark    (AI signs with times, harm, which objects to hide)
//   each object ───► SAM 3.1       (tracked through every frame, so playback can blur it)
//   code combines them: a label in the file beats a guess; a weak guess becomes "can't tell";
//   if the model fails, Lens says it couldn't check — it never defaults to "authentic".
import { buildObjectPrompt, decodeMaskToSVGPath, frameIndexOf, parseImageStream, parseVideoStream, recordsOfKind } from '@meta-sam/parser';
import { MODELS, parseJson, respond, respondEvents } from './meta.mjs';
import { provenance } from './provenance.mjs';
import { mp4Info } from './mp4.mjs';
import { ASSESS_PROMPT, SECOND_LOOK_PROMPT, VIDEO_PROMPT } from './prompts.mjs';

// The model can only say it found AI signs, found none, or can't tell. Looking at a picture
// can never show it's real, so there is no "authentic" verdict.
const VERDICTS = ['likely_ai', 'no_ai_signs', 'cant_tell'];
const EDIT_TYPES = ['color_filter', 'beauty_filter', 'ar_lens', 'ai_lens', 'stickers_or_text'];
// Filters, lenses and app edits: reported to the viewer, and not AI generation (except an AI lens).
const cleanEdits = list => (Array.isArray(list) ? list : []).slice(0, 4).flatMap(e => {
  const type = EDIT_TYPES.includes(e?.type) ? e.type : null, what = typeof e?.what === 'string' ? e.what.trim().slice(0, 60) : '';
  return type && what ? [{ type, what }] : [];
});
const HARM = ['none', 'violence', 'sexual', 'hate', 'threat', 'doxxing', 'self_harm', 'deceptive_fake'];

// Plain words for each verdict, shown to the viewer.
export const LABELS = {
  labelled_ai: 'Labelled as AI-made',
  likely_ai: 'Likely AI-generated',
  no_ai_signs: 'No signs of AI found',
  cant_tell: "Can't tell",
  unavailable: "Couldn't check",
};

const mimeOf = type => ({ jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' })[type] || 'application/octet-stream';
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// A box on the 0–1000 grid, clamped; null when missing or inside out.
function cleanBox(box) {
  const b = Array.isArray(box) && box.length === 4 && box.every(Number.isFinite) ? box.map(v => clamp(Math.round(v), 0, 1000)) : null;
  return b && b[2] > b[0] && b[3] > b[1] ? b : null;
}

// Muse Spark's answer, checked: unknown values become safe ones, boxes are clamped to the grid.
function cleanAssessment(raw) {
  const signs = (Array.isArray(raw.signs) ? raw.signs : []).slice(0, 4).flatMap(s => {
    if (typeof s?.why !== 'string' || !s.why.trim()) return [];
    return [{ what: String(s.what || '').trim().slice(0, 60), why: s.why.trim(), box: cleanBox(s.box) }];
  });
  const harm = raw.harm && typeof raw.harm === 'object' ? raw.harm : {};
  const category = HARM.includes(harm.category) ? harm.category : 'none';
  const harmful = harm.harmful === true && category !== 'none';
  // The parts to hide so the rest could be posted; only boxed ones are usable.
  const regions = harmful && Array.isArray(harm.regions)
    ? harm.regions.slice(0, 6).flatMap(r => { const box = cleanBox(r?.box); return box ? [{ what: String(r.what || '').trim().slice(0, 60) || 'Private detail', box }] : []; })
    : [];
  // Privacy details (number plates, house numbers…) in a fine image: blurred, never "harmful".
  const privacy = (Array.isArray(raw.privacy) ? raw.privacy : []).slice(0, 4).flatMap(r => {
    const box = cleanBox(r?.box); return box ? [{ what: String(r.what || '').trim().slice(0, 60) || 'Private detail', box, privacy: true }] : [];
  });
  // An older or off-script "authentic" answer is read as "no signs found", never as proof.
  const verdict = raw.verdict === 'likely_authentic' ? 'no_ai_signs' : VERDICTS.includes(raw.verdict) ? raw.verdict : 'cant_tell';
  const edits = cleanEdits(raw.edits);
  return {
    verdict,
    edits,
    confidence: Number.isFinite(raw.confidence) ? clamp(raw.confidence, 0, 1) : 0,
    kind: typeof raw.kind === 'string' ? raw.kind : 'other',
    summary: typeof raw.summary === 'string' ? raw.summary.trim() : '',
    signs,
    // regions = everything to blur: the harmful parts, then the privacy details (marked privacy: true).
    harm: { harmful, category, reason: typeof harm.reason === 'string' ? harm.reason.trim() : '', regions: [...regions, ...privacy] },
  };
}

/**
 * options.ask(dataUrl) → Muse Spark's raw text answer (default: the Meta Model API).
 * options.segment({ dataUrl, width, height, items: [{ id, box }] }) → [{ id, box, path }] (default: SAM 3.1).
 * options.lookAgain(dataUrl) → the raw answer to SECOND_LOOK_PROMPT, asked only when the first
 *   answer found no AI signs (default: Muse Wonder when `ask` is the default, else skipped).
 * options.minConfidence: a "likely AI" answer below this becomes "can't tell" (default 0.6).
 */
export function createLens({ ask, lookAgain, segment, minConfidence = 0.6, reasoning = 'medium', model: judge = process.env.LENS_MODEL || MODELS.wonder } = {}) {
  // The second look: on the 4 label-stripped AI images the first answer missed, it caught 3 (an arm
  // attached to nobody in a selfie, a parcel label with counting-digit numbers, ripples round a
  // moored boat), with no false alarms on 9 real photos, each run twice.
  if (!ask) lookAgain ??= dataUrl => respond({
    model: judge,
    content: [{ type: 'input_text', text: SECOND_LOOK_PROMPT }, { type: 'input_image', image_url: dataUrl }],
    extra: { reasoning: { effort: reasoning } },
    timeoutMs: 90000,
  });
  // The image judge is Muse Wonder: on 11 AI images with their labels stripped it caught 7 in both
  // runs (Muse Spark: 2, plus 2 only sometimes), with no false alarms on 9 real photos for either.
  ask ??= dataUrl => respond({
    model: judge,
    content: [{ type: 'input_text', text: ASSESS_PROMPT }, { type: 'input_image', image_url: dataUrl }],
    extra: { reasoning: { effort: reasoning } },
    timeoutMs: 90000,
  });
  segment ??= samOutlines;

  async function assess(bytes) {
    const prov = provenance(bytes);
    if (prov.type === 'unknown') return { verdict: 'unavailable', label: LABELS.unavailable, summary: 'This file is not a JPEG, PNG, WebP or GIF image.', signs: [], harm: null, provenance: prov };
    const dataUrl = `data:${mimeOf(prov.type)};base64,${Buffer.from(bytes).toString('base64')}`;

    // The second look starts at the same time as the first, so a check takes about as long as one
    // look (one after the other took up to a minute, past the hosting limit). It is only used when
    // the first look found nothing; a failed second look is ignored.
    const second = lookAgain && !prov.aiLabel ? lookAgain(dataUrl).then(parseJson).then(cleanAssessment).catch(() => null) : null;

    let model = null, modelError = null;
    try { model = cleanAssessment(parseJson(await ask(dataUrl))); }
    catch (err) { modelError = err?.message || 'The model could not be reached.'; }

    // Nothing found: use the second, forensic look. Only a confident answer with evidence changes
    // the verdict; otherwise the first answer stands.
    if (model && model.verdict === 'no_ai_signs' && second) {
      const again = await second;
      if (again) {
        if (again.verdict === 'likely_ai' && again.confidence >= minConfidence && again.signs.length) {
          // The first summary may say nothing was found, so the second look's summary replaces it.
          model = { ...model, verdict: 'likely_ai', confidence: again.confidence, signs: again.signs, summary: again.summary || 'A closer look found signs of AI generation.', secondLook: true };
        }
      }
    }

    // The verdict. A label in the file is a fact; otherwise the model's careful opinion.
    let verdict, certain = false, summary;
    if (prov.aiLabel) {
      verdict = 'labelled_ai'; certain = true;
      summary = prov.signals.find(s => s.kind !== 'content-credentials').detail;
    } else if (!model) {
      verdict = 'unavailable';
      summary = "We couldn't check this image right now. That doesn't mean it's real or fake.";
    } else {
      verdict = model.verdict === 'likely_ai' && model.confidence < minConfidence ? 'cant_tell' : model.verdict;
      summary = model.summary || (verdict === 'cant_tell' ? "There aren't enough clear signs either way." : '');
      if (verdict === 'no_ai_signs') summary = `${summary ? summary.replace(/\.?$/, '. ') : ''}That doesn't prove it's real: AI images can look flawless.`;
    }

    // Evidence = AI mistakes only: a list of reasons an image "looks real" would read as proof.
    let signs = model && model.verdict === 'likely_ai' ? model.signs : [];
    let harm = model ? model.harm : null;
    // Each harmful part is hidden by its hide box: Muse Spark's box, grown a little, so a
    // detail it boxed loosely is still fully covered.
    if (harm) harm = { ...harm, regions: harm.regions.map(r => ({ ...r, hideBox: growText(r.box) })) };

    // Exact outlines from SAM 3.1, for the AI signs (ids 1…) and the harmful parts (ids 101…),
    // in one request. Best effort: if it fails, Muse Spark's boxes stay.
    const items = [
      ...signs.flatMap((s, i) => s.box ? [{ id: i + 1, box: s.box }] : []),
      ...(harm ? harm.regions.map((r, i) => ({ id: 101 + i, box: r.box })) : []),
    ];
    if (items.length && prov.width && prov.height) {
      try {
        const outlines = await segment({ dataUrl, width: prov.width, height: prov.height, items });
        const outline = id => { const o = outlines.find(x => x.id === id); return o ? { box: o.box, ...(o.path ? { path: o.path } : {}) } : {}; };
        signs = signs.map((s, i) => ({ ...s, ...outline(i + 1) }));
        // The hide box covers both SAM's object and Muse Spark's box: hiding a little too much is fine,
        // leaving part of a phone number visible is not.
        if (harm) harm = { ...harm, regions: harm.regions.map((r, i) => { const o = outline(101 + i); return o.box ? { ...r, ...o, hideBox: union(r.hideBox, growText(o.box)) } : r; }) };
      } catch { /* keep Muse Spark's boxes */ }
    }

    return {
      verdict, label: LABELS[verdict], certain, summary,
      confidence: model ? model.confidence : null,
      kind: model ? model.kind : null,
      edits: model ? model.edits : [],
      signs, harm,
      provenance: prov,
      width: prov.width, height: prov.height,
      ...(modelError ? { error: modelError } : {}),
    };
  }

  /**
   * A short MP4 clip: Muse Spark watches it (AI signs with times, harm, what to hide), then
   * SAM 3.1 tracks each object to hide through every frame.
   * → { kind:'video', verdict, label, summary, confidence, signs:[{at, what, why}],
   *     harm:{ harmful, category, reason, tracks:[{ what, boxes: { [frame]: [x1,y1,x2,y2] } }] },
   *     width, height, duration, frameTimes }
   */
  async function assessVideo(bytes) {
    const info = mp4Info(bytes);
    if (!info) return { kind: 'video', verdict: 'unavailable', label: LABELS.unavailable, summary: 'This file is not an MP4 video.', signs: [], harm: null };
    if (info.duration > MAX_VIDEO_S) return { kind: 'video', verdict: 'unavailable', label: LABELS.unavailable, summary: `Videos up to ${MAX_VIDEO_S} seconds for now.`, signs: [], harm: null, ...info };
    const videoUrl = `data:video/mp4;base64,${Buffer.from(bytes).toString('base64')}`;

    let raw;
    try { raw = parseJson(await askVideo(videoUrl)); }
    catch (err) {
      return { kind: 'video', verdict: 'unavailable', label: LABELS.unavailable, summary: "We couldn't check this video right now. That doesn't mean it's real or fake.", signs: [], harm: null, error: err?.message, ...info };
    }
    const confidence = Number.isFinite(raw.confidence) ? clamp(raw.confidence, 0, 1) : 0;
    let verdict = raw.verdict === 'likely_authentic' ? 'no_ai_signs' : VERDICTS.includes(raw.verdict) ? raw.verdict : 'cant_tell';
    if (verdict === 'likely_ai' && confidence < minConfidence) verdict = 'cant_tell';
    let summary = typeof raw.summary === 'string' ? raw.summary.trim() : '';
    if (verdict === 'no_ai_signs') summary = `${summary ? summary.replace(/\.?$/, '. ') : ''}That doesn't prove it's real: AI video can look flawless.`;
    const signs = verdict === 'likely_ai' && Array.isArray(raw.signs)
      ? raw.signs.slice(0, 4).flatMap(s => typeof s?.why === 'string' && s.why.trim() ? [{ at: Number.isFinite(s.at) ? clamp(s.at, 0, info.duration) : null, what: String(s.what || '').trim().slice(0, 60), why: s.why.trim() }] : [])
      : [];

    const h = raw.harm && typeof raw.harm === 'object' ? raw.harm : {};
    const category = HARM.includes(h.category) ? h.category : 'none';
    const harmful = h.harmful === true && category !== 'none';
    const hide = harmful && Array.isArray(h.hide) ? [...new Set(h.hide.map(x => String(x).trim().toLowerCase()).filter(Boolean))].slice(0, 3) : [];
    // Track each object to hide through the clip. Best effort: a failed track is just missing.
    // SAM is literal: "shipping label" can match nothing where "label" tracks every frame, so a
    // phrase that finds nothing is retried as its last word.
    const track = async what => {
      for (const prompt of [...new Set([what, what.split(/\s+/).at(-1)])]) {
        const boxes = await trackVideo({ videoUrl, what: prompt, width: info.width, height: info.height }).catch(() => ({}));
        if (Object.keys(boxes).length) return { what, prompt, boxes };
      }
      return null;
    };
    // Privacy details (number plates, house numbers) are tracked and blurred too, but never make it harmful.
    const privacy = Array.isArray(raw.privacy) ? [...new Set(raw.privacy.map(x => String(x).trim().toLowerCase()).filter(x => x && !hide.includes(x)))].slice(0, 3) : [];
    const tracks = (await Promise.all([
      ...hide.map(track),
      ...privacy.map(what => track(what).then(t => t && { ...t, privacy: true })),
    ])).filter(Boolean);

    return {
      kind: 'video', verdict, label: LABELS[verdict], certain: false, summary, confidence,
      edits: cleanEdits(raw.edits),
      signs,
      harm: { harmful, category, reason: typeof h.reason === 'string' ? h.reason.trim() : '', hide, privacy, tracks },
      ...info,
    };
  }

  return { assess, assessVideo };
}

const MAX_VIDEO_S = 60;

const askVideoDefault = videoUrl => respond({
  // Muse Wonder: on test clips it caught a Snapchat AI clip (no watermark) 2/2 where Muse Spark
  // missed it 2/2, flagged no real clip, and answered in about half the time.
  model: process.env.LENS_VIDEO_MODEL || MODELS.wonder,
  content: [{ type: 'input_text', text: VIDEO_PROMPT }, { type: 'input_video', video_url: videoUrl }],
  extra: { reasoning: { effort: 'medium' } },
  timeoutMs: 150000, // with SAM tracking (90 s), a check fits the 5-minute hosting limit
});
let askVideo = askVideoDefault, trackVideo = samTrack;
/** For tests: replace the video model calls. */
export function setVideoModels({ ask, track } = {}) { askVideo = ask || askVideoDefault; trackVideo = track || samTrack; }

/**
 * SAM 3.1 on a video, with a concept prompt: every object matching `what`, tracked through every
 * frame. → { [frameIndex]: [x1, y1, x2, y2] on the 0–1000 grid } (the union when several match).
 */
export async function samTrack({ videoUrl, what, width, height }) {
  const events = respondEvents({ model: MODELS.sam, content: [{ type: 'input_text', text: what }, { type: 'input_video', video_url: videoUrl }], timeoutMs: 90000 });
  const result = await parseVideoStream(events).finalResult;
  const grid = (v, size) => clamp(Math.round(v * 1000 / size), 0, 1000);
  const frames = {};
  for (const b of recordsOfKind(result.records, 'box')) {
    const f = frameIndexOf(b);
    if (f === undefined) continue;
    const box = [grid(b.left, width), grid(b.top, height), grid(b.right, width), grid(b.bottom, height)];
    frames[f] = frames[f] ? union(frames[f], box) : box;
  }
  return frames;
}

const grow = (b, by) => [clamp(b[0] - by, 0, 1000), clamp(b[1] - by, 0, 1000), clamp(b[2] + by, 0, 1000), clamp(b[3] + by, 0, 1000)];
// A hide box: private details are mostly lines of text, and the ends of lines (postcodes,
// house numbers) are what boxes cut off, so it grows more sideways than up and down:
// 25% of the box's width each side (at least 20 on the 0–1000 grid), 15% of its height.
const growText = b => {
  const w = b[2] - b[0], h = b[3] - b[1], dx = Math.max(20, Math.round(w * 0.25)), dy = Math.max(15, Math.round(h * 0.15));
  return [clamp(b[0] - dx, 0, 1000), clamp(b[1] - dy, 0, 1000), clamp(b[2] + dx, 0, 1000), clamp(b[3] + dy, 0, 1000)];
};
const union = (a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];

/**
 * SAM 3.1 outlines for boxes on the 0–1000 grid: one box prompt per item, all in one request.
 * → [{ id, box: [x1,y1,x2,y2] on the 0–1000 grid, path: { d, x, y, w, h, rasterW, rasterH } }]
 * `path.d` is an SVG path in the mask's own raster (rasterW × rasterH); draw it scaled into
 * the pixel rectangle (x, y, w, h) of the image.
 */
export async function samOutlines({ dataUrl, width, height, items }) {
  const px = (v, size) => Math.round(v * size / 1000);
  const text = buildObjectPrompt({
    size: { width, height },
    objects: items.map(({ id, box }) => ({ id, prompts: [{ box: { left: px(box[0], width), top: px(box[1], height), right: Math.max(px(box[2], width), px(box[0], width) + 1), bottom: Math.max(px(box[3], height), px(box[1], height) + 1) } }] })),
  });
  const events = respondEvents({ model: MODELS.sam, content: [{ type: 'input_text', text }, { type: 'input_image', image_url: dataUrl }] });
  const result = await parseImageStream(events).finalResult;
  const boxes = recordsOfKind(result.records, 'box'), masks = recordsOfKind(result.records, 'mask');
  const grid = (v, size) => Math.round(v * 1000 / size);
  return boxes.map(b => {
    const m = masks.find(x => x.objectId === b.objectId);
    return {
      id: Number(b.objectId),
      box: [grid(b.left, width), grid(b.top, height), grid(b.right, width), grid(b.bottom, height)],
      ...(m ? { path: { d: decodeMaskToSVGPath(m.mask), x: m.bounds.left, y: m.bounds.top, w: m.bounds.right - m.bounds.left, h: m.bounds.bottom - m.bounds.top, rasterW: m.mask.width, rasterH: m.mask.height } } : {}),
    };
  });
}
