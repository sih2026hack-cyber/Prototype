// Argus Lens on the page: an eye button on images you hover, the verdict on the image, the
// evidence outlined on it, and private details blurred on screen.
(() => {
  if (window.__argusLens) return;
  window.__argusLens = true;

  const MIN = 160; // images smaller than this on screen aren't worth checking (icons, avatars)
  const LABEL_STYLE = {
    labelled_ai: ['#6d28d9', '#f3efff'], likely_ai: ['#6d28d9', '#f3efff'],
    no_ai_signs: ['#334155', '#f1f5f9'], cant_tell: ['#334155', '#f1f5f9'], unavailable: ['#92400e', '#fffbeb'],
  };
  const HARM = { violence: 'Graphic violence', sexual: 'Sexual content', hate: 'Hate', threat: 'Threat', doxxing: 'Private information', self_harm: 'Self-harm', deceptive_fake: 'Deceptive fake' };
  // On other people's posts the viewer isn't posting anything, so the warning says what the image
  // contains, not "don't share".
  const HARM_SEEN = {
    violence: 'Contains graphic violence', sexual: 'Contains sexual content', hate: 'Contains hate',
    threat: 'Contains a threat', doxxing: "Shows someone's private information", self_harm: 'Encourages self-harm',
    deceptive_fake: 'May be a deceptive fake',
  };
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  // Everything Lens draws lives in one shadow root, so the page's CSS can't touch it.
  const host = document.createElement('div');
  host.id = 'argus-lens-host';
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483646';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>
    *{box-sizing:border-box;font-family:Inter,'Segoe UI',system-ui,sans-serif}
    .eye{position:fixed;pointer-events:auto;display:none;align-items:center;gap:6px;border:0;border-radius:999px;padding:6px 11px 6px 8px;
      background:rgba(13,15,26,.86);color:#fff;font:600 13px/1 inherit;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.3)}
    .eye svg{width:18px;height:18px}
    .eye:hover{background:#6d28d9}
    .layer{position:fixed;overflow:hidden;pointer-events:none;border-radius:4px}
    .layer svg{position:absolute}
    .blur{position:absolute;backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);background:rgba(255,255,255,.08);border-radius:6px}
    .chip{position:fixed;pointer-events:auto;cursor:pointer;border:0;border-radius:999px;padding:5px 10px;font:700 12px/1.2 inherit;box-shadow:0 3px 10px rgba(0,0,0,.25)}
    .card{position:fixed;pointer-events:auto;width:340px;max-width:calc(100vw - 24px);max-height:70vh;overflow:auto;background:#fff;color:#14161c;border-radius:14px;
      padding:14px 16px;box-shadow:0 16px 40px rgba(0,0,0,.35);font-size:14px;line-height:1.5}
    .card .brand{display:flex;align-items:center;gap:6px;font-size:12px;color:#5d6272;font-weight:600}
    .card .brand svg{width:14px;height:14px}
    .card .x{position:absolute;top:8px;right:10px;border:0;background:none;font-size:20px;color:#5d6272;cursor:pointer}
    .verdict{display:inline-block;margin-top:8px;font-weight:700;font-size:15px;padding:5px 11px;border-radius:999px}
    .sub{font-size:12px;color:#5d6272;margin-left:6px}
    p{margin:8px 0}
    h4{margin:12px 0 6px;font-size:11px;letter-spacing:.5px;text-transform:uppercase;color:#5d6272}
    ol{list-style:none;margin:0;padding:0;display:grid;gap:6px}
    li{display:flex;gap:8px}
    .n{flex:none;width:20px;height:20px;border-radius:50%;color:#fff;font-size:11px;font-weight:700;display:grid;place-items:center}
    .harm{margin-top:10px;padding:10px 12px;border-radius:10px;background:#fef2f2;color:#991b1b}
    .edits{margin:8px 0;padding:8px 10px;border-radius:10px;background:#f1f5f9;font-size:13px}
    .row{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}
    .row button{font:600 12.5px inherit;border-radius:8px;padding:6px 10px;border:1px solid #e3e6ee;background:#fff;color:#14161c;cursor:pointer}
    .spin{display:inline-block;width:14px;height:14px;border:2px solid #c4b5fd;border-top-color:#6d28d9;border-radius:50%;animation:s 0.8s linear infinite;vertical-align:-2px;margin-right:6px}
    @keyframes s{to{transform:rotate(360deg)}}
  </style>
  <button class="eye" type="button" aria-label="Check this image with Argus Lens">
    <svg viewBox="0 0 64 64" fill="none"><path d="M4 32C12 18 22 12 32 12s20 6 28 20c-8 14-18 20-28 20S12 46 4 32Z" stroke="currentColor" stroke-width="5"/><circle cx="32" cy="32" r="10" fill="currentColor"/></svg>Check</button>`;
  document.documentElement.appendChild(host);
  const eye = root.querySelector('.eye');
  const EYE_ICON = '<svg viewBox="0 0 64 64" fill="none"><path d="M4 32C12 18 22 12 32 12s20 6 28 20c-8 14-18 20-28 20S12 46 4 32Z" stroke="currentColor" stroke-width="5"/><circle cx="32" cy="32" r="10" fill="currentColor"/></svg>';

  // Checked images: img → { result | pending | error, chip, layer, card, showMarks, blurOn }
  const checked = new Map();
  let hovered = null;

  const bigEnough = el => el.getBoundingClientRect().width >= MIN && el.getBoundingClientRect().height >= MIN;
  const big = el => el?.tagName === 'IMG' && el.naturalWidth >= 200 && bigEnough(el);
  const bigVideo = el => el?.tagName === 'VIDEO' && el.videoWidth >= 200 && bigEnough(el);
  const fmt = t => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
  // Instagram and Reddit put transparent layers over their images, so find the image under the
  // pointer rather than trusting the event target.
  const imageAt = (x, y) => document.elementsFromPoint(x, y).find(el => big(el) || bigVideo(el));

  let raf = 0;
  document.addEventListener('mousemove', e => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (e.composedPath().includes(host)) return;
      const img = imageAt(e.clientX, e.clientY);
      hovered = img || null;
      placeEye();
    });
  }, { passive: true });

  function placeEye() {
    if (!hovered || checked.get(hovered)?.pending) { eye.style.display = 'none'; return; }
    const r = hovered.getBoundingClientRect();
    eye.style.display = 'inline-flex';
    eye.lastChild.textContent = hovered.tagName === 'VIDEO' ? 'Check frame' : 'Check';
    eye.style.left = `${Math.max(4, r.right - (hovered.tagName === 'VIDEO' ? 130 : 92))}px`;
    eye.style.top = `${Math.max(4, r.top + 10)}px`;
  }
  eye.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); if (hovered) open(hovered); });

  // The user asked about an image: show what's known (with the outlines), or check it now.
  function open(img, url) {
    if (img.tagName === 'VIDEO') return checkFrame(img);
    const s = checked.get(img);
    if (s?.result) { s.showMarks = true; draw(img); openCard(img, cardHtml(s)); return; }
    if (s?.pending) return;
    if (s) { s.chip?.remove(); s.layer?.remove(); checked.delete(img); } // an earlier failed check
    check(img, url ? { url } : {});
  }

  // Where the picture's pixels actually are on screen: object-fit cover/contain crop or pad it.
  // A video frame was captured as exactly the element's box, so it maps onto that box.
  function contentBox(img) {
    const r = img.getBoundingClientRect();
    if (img.tagName === 'VIDEO') return { x: r.left, y: r.top, w: r.width, h: r.height, clip: r };
    const fit = getComputedStyle(img).objectFit;
    const nw = img.naturalWidth, nh = img.naturalHeight;
    if (fit !== 'cover' && fit !== 'contain') return { x: r.left, y: r.top, w: r.width, h: r.height, clip: r };
    const s = fit === 'cover' ? Math.max(r.width / nw, r.height / nh) : Math.min(r.width / nw, r.height / nh);
    const w = nw * s, h = nh * s;
    return { x: r.left + (r.width - w) / 2, y: r.top + (r.height - h) / 2, w, h, clip: r };
  }

  // A check the user clicked for opens the card. An automatic one only puts the verdict chip on
  // the image (and blurs private details); the chip opens the card.
  async function check(img, { url = img.currentSrc || img.src, auto = false } = {}) {
    const state = { pending: true, auto, showMarks: !auto, blurOn: true };
    checked.set(img, state);
    placeEye();
    if (auto) setChip(img, state, 'Checking…', LABEL_STYLE.cant_tell);
    else openCard(img, `<p><span class="spin"></span>Checking this image…</p><p class="sub" style="margin:0">Muse Spark looks for AI signs and private details; SAM 3.1 outlines the evidence.</p>`);
    let reply;
    try { reply = await chrome.runtime.sendMessage({ type: 'assess', url, auto }); }
    catch { reply = { error: 'Argus Lens was updated or reloaded. Reload this page to use it.' }; }
    state.pending = false;
    if (reply?.deferred) { // over the per-minute limit: try again later, if it's still on screen
      state.chip?.remove(); checked.delete(img);
      setTimeout(() => { if (onScreen(img)) enqueue(img); }, reply.retryInMs + 500);
      return 'deferred';
    }
    if (reply?.error || !reply?.result) {
      state.error = reply?.error || 'Argus Lens could not check this image.';
      if (auto) setChip(img, state, "Couldn't check", LABEL_STYLE.unavailable);
      else openCard(img, `<p>${esc(state.error)}</p>`);
      return 'error';
    }
    state.result = reply.result;
    draw(img);
    if (!auto) openCard(img, cardHtml(state));
    return 'done';
  }

  // --- Video: check the frame on screen. Pause, hide Lens's own buttons, screenshot the video's
  // box (the background script crops the visible tab), then check it like an image. ---
  const nextFrame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  async function checkFrame(video) {
    const old = checked.get(video);
    if (old?.pending) return;
    if (old) { old.chip?.remove(); old.layer?.remove(); }
    video.pause();
    const state = { pending: true, frame: true, at: video.currentTime, showMarks: true, blurOn: true };
    checked.set(video, state);
    // Lens's own button and cards must not end up in the screenshot.
    host.style.visibility = 'hidden';
    await nextFrame();
    const r = video.getBoundingClientRect();
    let shot;
    try { shot = await chrome.runtime.sendMessage({ type: 'captureFrame', rect: { x: r.left, y: r.top, width: r.width, height: r.height }, dpr: devicePixelRatio || 1 }); }
    catch { shot = { error: 'Argus Lens was updated or reloaded. Reload this page to use it.' }; }
    host.style.visibility = '';
    if (shot?.error) { state.pending = false; state.error = shot.error; openCard(video, `<p>${esc(shot.error)}</p>`); return; }
    openCard(video, `<p><span class="spin"></span>Checking the frame at ${fmt(state.at)}…</p><p class="sub" style="margin:0">Muse Spark looks for AI signs and private details; SAM 3.1 outlines the evidence.</p>`);
    let reply;
    try { reply = await chrome.runtime.sendMessage({ type: 'assessFrame' }); }
    catch { reply = { error: 'Argus Lens was updated or reloaded. Reload this page to use it.' }; }
    state.pending = false;
    if (reply?.error || !reply?.result) { state.error = reply?.error || 'Argus Lens could not check this frame.'; openCard(video, `<p>${esc(state.error)}</p>`); return; }
    state.result = reply.result;
    draw(video);
    openCard(video, cardHtml(state));
    // Once the video plays on, the outlines and blur no longer match what's on screen.
    video.addEventListener('play', () => { if (checked.get(video) === state) { state.showMarks = false; state.blurOn = false; draw(video); } }, { once: true });
  }

  // The verdict chip on an image: click it to open the card.
  function setChip(img, state, text, [fg, bg]) {
    if (!state.chip) {
      state.chip = document.createElement('button'); state.chip.className = 'chip'; root.appendChild(state.chip);
      state.chip.addEventListener('click', () => {
        const s = checked.get(img);
        if (s?.result) openCard(img, cardHtml(s));
        else if (s?.error) openCard(img, `<p>${esc(s.error)}</p>`);
      });
    }
    state.chip.style.color = fg; state.chip.style.background = bg;
    state.chip.textContent = text;
    position();
  }

  // --- Automatic checks: each image that comes on screen, once, within the per-minute limit ---
  let autoOn = false;
  const onScreen = img => { if (!img.isConnected) return false; const r = img.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight && r.width >= MIN; };
  const queue = [];
  let active = 0;
  function enqueue(img) {
    if (!autoOn || checked.has(img) || queue.includes(img)) return;
    queue.push(img); pump();
  }
  async function pump() {
    while (active < 2 && queue.length) {
      const img = queue.shift();
      if (checked.has(img) || !big(img) || !onScreen(img)) continue; // scrolled past: picked up again if it comes back
      active++;
      check(img, { auto: true }).finally(() => { active--; pump(); });
    }
  }
  const seen = new IntersectionObserver(entries => {
    for (const e of entries) if (e.isIntersecting) enqueue(e.target);
  }, { threshold: 0.6 });
  const watched = new WeakSet();
  function scan() {
    if (!autoOn) return;
    for (const img of document.images) {
      if (watched.has(img) || img.naturalWidth < 200) continue; // icons, avatars, emoji
      watched.add(img); seen.observe(img);
    }
  }
  setInterval(scan, 1000);
  function setAuto(on) {
    autoOn = on === true;
    if (autoOn) { scan(); for (const img of document.images) if (big(img) && onScreen(img)) enqueue(img); }
    else queue.length = 0;
  }
  if (chrome.storage?.sync) {
    chrome.storage.sync.get('auto').then(({ auto }) => setAuto(auto));
    chrome.storage.onChanged.addListener(changes => { if (changes.auto) setAuto(changes.auto.newValue); });
  } else setAuto(window.__argusLensAuto); // the test feed

  // Filters and app edits, kept apart from the AI verdict: a filter isn't AI; an AI lens is.
  function editsLine(edits) {
    if (!edits?.length) return '';
    const plain = edits.filter(e => e.type !== 'ai_lens'), ai = edits.filter(e => e.type === 'ai_lens');
    return `<p class="edits">${plain.length ? `<b>Filter:</b> ${plain.map(e => esc(e.what)).join(', ')}.${ai.length ? '' : ' A filter alone doesn\'t make a photo AI-made.'}` : ''}${ai.length ? ` <b>AI lens:</b> ${ai.map(e => esc(e.what)).join(', ')}, which redraws the picture.` : ''}</p>`;
  }

  function cardHtml(state) {
    const r = state.result;
    const [fg, bg] = LABEL_STYLE[r.verdict] || LABEL_STYLE.cant_tell;
    const sub = r.certain ? 'from the file itself' : r.verdict === 'likely_ai' && r.confidence != null ? `${Math.round(r.confidence * 100)}% confident` : '';
    const regions = (r.harm?.regions || []).filter(g => g.privacy || r.harm.harmful);
    const priv = regions.filter(g => g.privacy).map(g => g.what);
    return `<span class="verdict" style="color:${fg};background:${bg}">${esc(r.label)}</span>${sub ? `<span class="sub">${sub}</span>` : ''}
      <p>${esc(r.summary)}</p>
      ${editsLine(r.edits)}
      ${priv.length ? `<p class="edits"><b>Blurred for privacy:</b> ${[...new Set(priv)].map(esc).join(', ')}.</p>` : ''}
      ${state.frame ? `<p class="sub" style="margin:0 0 8px">This is the frame at ${fmt(state.at)}. Press play and the outlines clear; check another frame any time.</p>` : ''}
      ${r.harm?.harmful ? `<div class="harm"><b>${esc(HARM_SEEN[r.harm.category] || 'May be harmful')}.</b> ${esc(r.harm.reason)}${regions.length ? ' Blurred on your screen.' : ''}</div>` : ''}
      ${r.signs?.length ? `<h4>Evidence</h4><ol>${r.signs.map((s, i) => `<li><span class="n" style="background:#7c3aed">${i + 1}</span><span><b>${esc(s.what || 'Area')}</b>: ${esc(s.why)}</span></li>`).join('')}</ol>` : ''}
      ${(r.signs?.some(s => s.box) || regions.length) ? `<div class="row">
        ${r.signs?.some(s => s.box) || regions.length ? `<button data-act="marks">${state.showMarks ? 'Hide outlines' : 'Show outlines'}</button>` : ''}
        ${regions.length ? `<button data-act="blur">${state.blurOn ? 'Unblur' : 'Blur again'}</button>` : ''}</div>` : ''}`;
  }

  // The card sits next to the image, inside the viewport.
  let cardFor = null;
  function openCard(img, html) {
    let card = root.querySelector('.card');
    if (!card) {
      card = document.createElement('div'); card.className = 'card'; root.appendChild(card);
      card.addEventListener('click', e => {
        const act = e.target.closest('[data-act]')?.dataset.act, state = checked.get(cardFor);
        if (e.target.closest('.x')) { card.remove(); cardFor = null; return; }
        if (!act || !state) return;
        if (act === 'marks') state.showMarks = !state.showMarks;
        if (act === 'blur') state.blurOn = !state.blurOn;
        draw(cardFor); card.querySelector('.body').innerHTML = cardHtml(state);
      });
    }
    cardFor = img;
    card.innerHTML = `<button class="x" aria-label="Close">×</button><div class="brand">${EYE_ICON}Argus Lens</div><div class="body">${html}</div>`;
    position();
  }

  // Outlines, numbers and blur boxes, drawn in a layer exactly over the image.
  function draw(img) {
    const state = checked.get(img), r = state?.result;
    if (!r) return;
    if (!state.layer) { state.layer = document.createElement('div'); state.layer.className = 'layer'; root.appendChild(state.layer); }
    const W = r.width || 1000, H = r.height || 1000, px = (v, s) => v * s / 1000;
    const regions = (r.harm?.regions || []).filter(g => g.privacy || r.harm.harmful);
    const n = (x, y, i, color) => `<circle cx="${x}" cy="${y}" r="${W / 34}" fill="${color}"/><text x="${x}" y="${y}" fill="#fff" font-size="${W / 26}" font-weight="700" text-anchor="middle" dominant-baseline="central">${i + 1}</text>`;
    const outline = (s, color, dashed) => s.path
      ? `<g transform="translate(${s.path.x} ${s.path.y}) scale(${s.path.w / s.path.rasterW} ${s.path.h / s.path.rasterH})"><path d="${esc(s.path.d)}" fill="${dashed ? 'none' : 'rgba(124,58,237,.25)'}" stroke="${color}" stroke-width="2.5" vector-effect="non-scaling-stroke"/></g>`
      : `<rect x="${px(s.box[0], W)}" y="${px(s.box[1], H)}" width="${px(s.box[2] - s.box[0], W)}" height="${px(s.box[3] - s.box[1], H)}" fill="none" stroke="${color}" stroke-width="2.5" vector-effect="non-scaling-stroke" stroke-dasharray="8 4"/>`;
    const marks = state.showMarks ? [
      ...(r.signs || []).map((s, i) => s.box ? outline(s, '#7c3aed', false) + n(px(s.box[0], W), px(s.box[1], H), i, '#7c3aed') : ''),
      ...regions.map((g, i) => outline({ ...g, box: g.hideBox }, '#dc2626', true) + n(px(g.hideBox[0], W), px(g.hideBox[1], H), i, '#dc2626')),
    ].join('') : '';
    const blurs = state.blurOn ? regions.map(g => `<div class="blur" data-box="${g.hideBox.join(',')}"></div>`).join('') : '';
    state.layer.innerHTML = `${blurs}<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${marks}</svg>`;
    // The chip: the verdict, kept on the image; click it to reopen the card.
    const harmWord = r.harm?.harmful ? (r.harm.category === 'doxxing' ? 'private info' : (HARM[r.harm.category] || 'harmful').toLowerCase()) : '';
    const text = harmWord ? `⚠ ${r.label} · ${harmWord}` : r.label;
    setChip(img, state, state.frame ? `${fmt(state.at)} frame · ${text}` : text, LABEL_STYLE[r.verdict] || LABEL_STYLE.cant_tell);
  }

  // Keep every layer, chip and the card on its image while the page scrolls or the feed moves.
  function position() {
    for (const [img, state] of checked) {
      if (!img.isConnected) { state.layer?.remove(); state.chip?.remove(); checked.delete(img); continue; }
      const box = contentBox(img), c = box.clip;
      const visible = c.bottom > 0 && c.top < innerHeight && c.width > 0;
      if (state.chip) Object.assign(state.chip.style, { display: visible ? 'block' : 'none', left: `${c.left + 10}px`, top: `${Math.min(Math.max(c.top, 0) + 10, c.bottom - 40)}px` }); // stays on the visible part
      if (!state.layer) continue;
      Object.assign(state.layer.style, { display: visible ? 'block' : 'none', left: `${c.left}px`, top: `${c.top}px`, width: `${c.width}px`, height: `${c.height}px` });
      const svg = state.layer.querySelector('svg');
      if (svg) Object.assign(svg.style, { left: `${box.x - c.left}px`, top: `${box.y - c.top}px`, width: `${box.w}px`, height: `${box.h}px` });
      for (const b of state.layer.querySelectorAll('.blur')) {
        const [x1, y1, x2, y2] = b.dataset.box.split(',').map(Number);
        Object.assign(b.style, { left: `${box.x - c.left + x1 * box.w / 1000}px`, top: `${box.y - c.top + y1 * box.h / 1000}px`, width: `${(x2 - x1) * box.w / 1000}px`, height: `${(y2 - y1) * box.h / 1000}px` });
      }
    }
    const card = root.querySelector('.card');
    if (card && cardFor) {
      if (!cardFor.isConnected) { card.remove(); cardFor = null; return; }
      const r = cardFor.getBoundingClientRect(), w = card.offsetWidth, h = card.offsetHeight;
      const right = r.right + 12 + w <= innerWidth;
      card.style.left = `${right ? r.right + 12 : Math.max(12, Math.min(r.left, innerWidth - w - 12))}px`;
      card.style.top = `${right ? Math.min(Math.max(12, r.top), innerHeight - h - 12) : Math.min(r.bottom + 12, innerHeight - h - 12)}px`;
    }
  }
  let ticking = false;
  const schedule = () => { if (!ticking) { ticking = true; requestAnimationFrame(() => { ticking = false; position(); placeEye(); }); } };
  addEventListener('scroll', schedule, { passive: true, capture: true });
  addEventListener('resize', schedule, { passive: true });
  setInterval(schedule, 500); // feeds move images without scrolling (carousels, lazy loading)

  // Right-click → "Check with Argus Lens" (from the background script).
  chrome.runtime.onMessage.addListener(msg => {
    if (msg?.type !== 'check') return;
    const img = [...document.images].find(i => i.currentSrc === msg.url || i.src === msg.url);
    if (img) open(img, msg.url);
  });
})();
