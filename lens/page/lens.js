// Argus Lens page (served by ARGUS at /lens). Moved out of index.html so the page runs under a strict CSP.
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const HARM = { violence: 'Graphic violence', sexual: 'Sexual content', hate: 'Hate', threat: 'Threat', doxxing: 'Private information', self_harm: 'Self-harm', deceptive_fake: 'Deceptive fake' };
  // What a viewer is told about someone else's harmful post (they aren't posting anything).
  const HARM_SEEN = { violence: 'Contains graphic violence', sexual: 'Contains sexual content', hate: 'Contains hate', threat: 'Contains a threat', doxxing: "Shows someone's private information", self_harm: 'Encourages self-harm', deceptive_fake: 'May be a deceptive fake' };

  // Two sections, one check: "Is this real?" leads with the AI verdict and its evidence;
  // "Check before posting" leads with harm and privacy and the safe copy. The section is kept in
  // the address (#real / #post) and switching re-shows the last result without checking again.
  const MODES = {
    real: { tag: 'Is this photo or video real? Argus Lens shows the evidence, not just a guess.', empty: 'The result appears here: whether it\'s likely AI-generated, and the evidence, outlined on the picture.' },
    post: { tag: "About to post a photo or video? Argus Lens checks it's safe to share, and blurs private details for you.", empty: 'The result appears here: whether it\'s safe to post, what to hide, and a safe copy to download.' },
  };
  let mode = location.hash === '#post' ? 'post' : 'real', last = null; // last = { kind: 'image' | 'video', r }
  function setMode(m) {
    mode = m; history.replaceState(null, '', '#' + m);
    for (const b of document.querySelectorAll('.modes button')) b.setAttribute('aria-selected', String(b.dataset.mode === m));
    $('tag').textContent = MODES[m].tag;
    if (!last) { if ($('result').querySelector('.empty')) $('result').innerHTML = `<p class="empty">${MODES[m].empty}</p>`; return; }
    last.kind === 'video' ? showVideo(last.r) : show(last.r);
  }

  function steps(done) {
    const names = ['Reading labels in the file', 'Muse Wonder is analysing the image', 'SAM 3.1 is outlining the evidence'];
    $('result').innerHTML = '<p><b>Checking…</b></p><ul class="steps">' + names.map((n, i) => `<li class="${i < done ? 'done' : ''}">${n}</li>`).join('') + '</ul>';
  }

  // The hosted demo (Vercel) takes uploads up to 4 MB; running locally takes 10 MB photos and 20 MB videos.
  // A dropped connection shows as "Failed to fetch": say what it means instead.
  const failText = e => /failed to fetch|networkerror|load failed/i.test(e.message) ? "We couldn't finish checking this: the connection dropped or the check took too long. That doesn't mean it's real or fake. Please try again." : e.message;
  const HOSTED = false; // the 4 MB cap was Vercel's; the ARGUS server takes images up to 10 MB and videos up to 20 MB
  if (HOSTED) document.querySelector('#drop .meta').textContent = 'Photos: JPEG, PNG, WebP or GIF · Videos: MP4, MOV, WebM and more, up to 60 seconds · Files up to 4 MB here';
  function tooBig(file) {
    if (!HOSTED || file.size <= 4 * 1024 * 1024) return false;
    $('result').innerHTML = `<p>This file is ${(file.size / 1048576).toFixed(1)} MB. The hosted demo takes files up to 4 MB: try a smaller one, or run Argus Lens locally (see the README) for bigger files.</p>`;
    return true;
  }

  async function check(file) {
    if (file && (file.type.startsWith('video/') || /\.(mov|mp4|m4v|webm|mkv)$/i.test(file.name))) return checkVideo(file);
    $('vstage').style.display = 'none'; stopVideoBlur(); video = null; $('vid').pause();
    $('toggle').textContent = 'Show original'; $('download').textContent = 'Download blurred image';
    if (file && /\.(heic|heif)$/i.test(file.name)) { $('result').innerHTML = '<p>iPhone HEIC photos can\'t be opened in the browser. Share or export the photo as JPEG and try again.</p>'; return; }
    if (!file || !/^image\/(jpeg|png|webp|gif)$/.test(file.type)) { $('result').innerHTML = '<p>Please choose a photo (JPEG, PNG, WebP or GIF) or a video.</p>'; return; }
    if (tooBig(file)) return;
    const url = URL.createObjectURL(file);
    $('img').src = url; $('drop').style.display = 'none'; $('stage').style.display = 'block'; $('again').style.display = 'inline-block';
    $('overlay').innerHTML = ''; setSafe(false); $('tools').style.display = 'none';
    let s = 1; steps(s); const timer = setInterval(() => steps(Math.min(++s, 2)), 2500);
    try {
      const res = await fetch('/api/lens/assess', { method: 'POST', body: file });
      const r = await res.json();
      if (!res.ok) throw new Error(r.error || 'Lens could not check this image.');
      show(r);
    } catch (e) { $('result').innerHTML = `<p>${esc(failText(e))}</p>`; }
    finally { clearInterval(timer); }
  }

  // Filters and app edits: told to the viewer, kept apart from the AI verdict.
  function editsHtml(edits) {
    if (!edits || !edits.length) return '';
    const plain = edits.filter(e => e.type !== 'ai_lens'), ai = edits.filter(e => e.type === 'ai_lens');
    return `<div class="edits">
      ${plain.length ? `<p><b>Edited with ${plain.length === 1 ? 'a filter' : 'filters'}:</b> ${plain.map(e => esc(e.what)).join(', ')}. ${ai.length ? '' : 'A filter changes how a photo looks; on its own it doesn\'t mean the photo is AI-made.'}</p>` : ''}
      ${ai.length ? `<p><b>AI lens:</b> ${ai.map(e => esc(e.what)).join(', ')}. An AI lens redraws the picture, so it counts as AI-made.</p>` : ''}</div>`;
  }

  // Privacy details blurred as a courtesy: a neutral note, not a warning.
  const privacyHtml = names => names.length ? `<div class="edits"><p><b>Blurred for privacy:</b> ${[...new Set(names)].map(esc).join(', ')}. This doesn't make it unsafe to post; it just keeps details like these private.</p></div>` : '';

  // The AI verdict with its confidence note, as a pill.
  const verdictPill = r => `<span class="verdict v-${esc(r.verdict)}">${esc(r.label)}</span>${r.certain ? '<span class="certain">from the file itself</span>' : (r.confidence != null && r.verdict === 'likely_ai' ? `<span class="certain">${Math.round(r.confidence * 100)}% confident</span>` : '')}`;
  // Harm for the section: "Not safe to post" (with what's hidden) or "OK to post" when posting;
  // a plain description of what it contains when viewing.
  function harmHtml(r, hiddenList) {
    if (!r.harm) return '';
    if (mode === 'real') return r.harm.harmful ? `<div class="harm"><b>${esc(HARM_SEEN[r.harm.category] || 'May be harmful')}.</b> ${esc(r.harm.reason)}${hiddenList ? ' Blurred on your screen.' : ''}</div>` : '';
    if (r.harm.harmful) return `<div class="harm"><h3>Not safe to post: ${esc(HARM[r.harm.category] || 'harmful')}</h3>${esc(r.harm.reason)}${hiddenList || ' Hiding parts of it wouldn\'t make it safe.'}</div>`;
    return `<div class="ok"><h3>OK to post</h3>Nothing harmful found: no threats, hate, private information or graphic content.</div>`;
  }
  // The AI result, kept short, under the harm result when posting.
  const aiAside = r => `<div class="aside">${verdictPill(r)}<p>${esc(r.summary)}</p>${editsHtml(r.edits)}<p class="meta">Switch to <a href="#real" data-goto="real">Is this real?</a> for the evidence.</p></div>`;

  function show(r) {
    last = { kind: 'image', r };
    const W = r.width || 1000, H = r.height || 1000;
    const px = (v, size) => v * size / 1000;
    $('overlay').setAttribute('viewBox', `0 0 ${W} ${H}`);
    const stroke = Math.max(2, W / 300), font = Math.max(16, W / 26);
    const inside = (v, size) => Math.min(Math.max(v, font * 0.8), size - font * 0.8); // keep the number badge on the image
    // AI evidence is outlined in "Is this real?"; harm and privacy outlines in "Check before posting".
    $('overlay').innerHTML = (mode === 'real' ? r.signs || [] : []).map((s, i) => {
      if (!s.box) return '';
      const [x1, y1, x2, y2] = s.box, rx = px(x1, W), ry = px(y1, H), bx = inside(rx, W), by = inside(ry, H);
      const shape = s.path
        ? `<g transform="translate(${s.path.x} ${s.path.y}) scale(${s.path.w / s.path.rasterW} ${s.path.h / s.path.rasterH})"><path d="${esc(s.path.d)}" fill="var(--mark-fill)" stroke="var(--mark)" stroke-width="2.5" vector-effect="non-scaling-stroke"/></g>`
        : `<rect x="${rx}" y="${ry}" width="${px(x2 - x1, W)}" height="${px(y2 - y1, H)}" rx="${stroke * 3}" fill="var(--mark-fill)" stroke="var(--mark)" stroke-width="${stroke}" stroke-dasharray="${stroke * 4} ${stroke * 2}"/>`;
      return `<g data-i="${i}">${shape}<circle cx="${bx}" cy="${by}" r="${font * 0.75}" fill="var(--mark)"/><text x="${bx}" y="${by}" fill="#fff" font-size="${font}" font-weight="700" text-anchor="middle" dominant-baseline="central">${i + 1}</text></g>`;
    }).join('');

    // Harmful parts: outlined in red, and blurred in the safe version (shown by default).
    // Everything to blur: harmful parts (red, numbered) and privacy details (grey, no number).
    const regions = ((r.harm && r.harm.regions) || []).filter(g => g.privacy || r.harm.harmful);
    $('overlay').innerHTML += (mode === 'post' ? regions : []).map((g, i) => {
      const col = g.privacy ? 'var(--unk)' : 'var(--harm)';
      const [x1, y1, x2, y2] = g.hideBox, rx = px(x1, W), ry = px(y1, H), bx = inside(rx, W), by = inside(ry, H);
      const shape = g.path
        ? `<g transform="translate(${g.path.x} ${g.path.y}) scale(${g.path.w / g.path.rasterW} ${g.path.h / g.path.rasterH})"><path d="${esc(g.path.d)}" fill="none" stroke="${col}" stroke-width="2.5" vector-effect="non-scaling-stroke"/></g>`
        : '';
      const badge = g.privacy ? '' : `<circle cx="${bx}" cy="${by}" r="${font * 0.75}" fill="${col}"/><text x="${bx}" y="${by}" fill="#fff" font-size="${font}" font-weight="700" text-anchor="middle" dominant-baseline="central">${i + 1}</text>`;
      return `<g>${shape}<rect x="${rx}" y="${ry}" width="${px(x2 - x1, W)}" height="${px(y2 - y1, H)}" rx="${stroke * 3}" fill="none" stroke="${col}" stroke-width="${stroke}" stroke-dasharray="${stroke * 4} ${stroke * 2}"/>${badge}</g>`;
    }).join('');
    makeSafe(regions);

    const prov = r.provenance || {};
    const facts = [
      ...(prov.signals || []).map(s => s.detail),
      prov.signals && !prov.signals.length ? 'The file carries no AI label or Content Credentials (most images don\'t).' : '',
    ].filter(Boolean);
    const harmful = regions.filter(g => !g.privacy);
    const hiddenList = harmful.length ? ` The parts below are blurred in the safe version.<ol class="signs" style="margin-top:10px">${harmful.map((g, i) => `<li><span class="num">${i + 1}</span><span class="what">${esc(g.what)}</span></li>`).join('')}</ol>` : '';
    $('result').innerHTML = mode === 'real' ? `
      ${verdictPill(r)}
      <p class="summary">${esc(r.summary)}</p>
      ${r.kind && r.kind !== 'photo' ? `<p class="meta">Looks like ${r.kind === 'other' ? 'something other than a photo' : 'a ' + esc(r.kind)}, not a photo.</p>` : ''}
      ${editsHtml(r.edits)}
      ${(r.signs || []).length ? `<h2>Evidence</h2><ol class="signs">${r.signs.map((s, i) => `<li data-i="${i}"><span class="num">${i + 1}</span><span><span class="what">${esc(s.what || 'Area')}</span><br>${esc(s.why)}</span></li>`).join('')}</ol>` : ''}
      <h2>What the file says</h2><ul class="facts meta">${facts.map(f => `<li>${esc(f)}</li>`).join('')}</ul>
      ${harmHtml(r, harmful.length)}
      ${privacyHtml(regions.filter(g => g.privacy).map(g => g.what))}` : `
      ${harmHtml(r, hiddenList)}
      ${privacyHtml(regions.filter(g => g.privacy).map(g => g.what))}
      ${aiAside(r)}`;
    for (const a of document.querySelectorAll('[data-goto]')) a.onclick = e => { e.preventDefault(); setMode(a.dataset.goto); };
    for (const li of document.querySelectorAll('ol.signs li')) {
      const g = () => $('overlay').querySelector(`g[data-i="${li.dataset.i}"]`);
      li.onmouseenter = () => { li.classList.add('hot'); g()?.setAttribute('opacity', '1'); [...$('overlay').children].forEach(x => x !== g() && x.setAttribute('opacity', '.25')); };
      li.onmouseleave = () => { li.classList.remove('hot'); [...$('overlay').children].forEach(x => x.removeAttribute('opacity')); };
    }
  }

  // --- Video: Muse Spark watches it; SAM 3.1 tracks each private object through every frame,
  // and the page blurs that box on each frame as the video plays. ---
  let video = null; // { result, tracks }
  // MP4 and MOV (iPhone) share one file structure and go as they are; anything else the browser
  // can play (WebM, MKV…) is re-recorded as MP4 here first, since Muse Spark reads MP4.
  async function toMp4(file) {
    if (/^video\/(mp4|quicktime)$/.test(file.type) || /\.(mp4|m4v|mov)$/i.test(file.name)) return file;
    const type = ['video/mp4;codecs=avc1.42E01F,mp4a.40.2', 'video/mp4;codecs=avc1.42E01F', 'video/mp4'].find(t => MediaRecorder.isTypeSupported(t));
    if (!type) throw new Error('This browser can\'t convert this video to MP4. Try an MP4 or MOV file.');
    const v = document.createElement('video');
    v.src = URL.createObjectURL(file); v.muted = true; v.playsInline = true;
    await new Promise((res, rej) => { v.onloadedmetadata = res; v.onerror = () => rej(new Error('This video can\'t be played in the browser. Try an MP4 or MOV file.')); });
    // Recorded WebM files often don't store their length (duration = Infinity): seeking to the end
    // makes the browser work it out.
    if (!Number.isFinite(v.duration)) {
      v.currentTime = 1e9; await new Promise(res => v.ondurationchange = () => Number.isFinite(v.duration) && res());
      v.currentTime = 0; await new Promise(res => v.onseeked = res);
    }
    if (v.duration > 60) throw new Error('Videos up to 60 seconds for now.');
    const rec = new MediaRecorder(v.captureStream(), { mimeType: type, videoBitsPerSecond: 4_000_000 });
    const chunks = []; rec.ondataavailable = e => e.data.size && chunks.push(e.data);
    const done = new Promise(res => rec.onstop = res);
    const tick = setInterval(() => { $('result').innerHTML = `<p><b>Converting to MP4…</b> ${v.currentTime.toFixed(0)} of ${v.duration.toFixed(0)} seconds</p><p class="meta">Lens reads MP4 videos, so this one is re-recorded in your browser first.</p>`; }, 300);
    rec.start(500); await v.play();
    await new Promise(res => v.onended = res);
    rec.stop(); await done; clearInterval(tick);
    return new File([new Blob(chunks, { type })], file.name.replace(/\.[^.]+$/, '') + '.mp4', { type: 'video/mp4' });
  }

  async function checkVideo(file) {
    const vid = $('vid');
    stopVideoBlur();
    vid.src = URL.createObjectURL(file);
    $('drop').style.display = 'none'; $('stage').style.display = 'none'; $('vstage').style.display = 'block';
    $('again').style.display = 'inline-block'; $('tools').style.display = 'none'; video = null;
    try { const mp4 = await toMp4(file); if (mp4 !== file) { file = mp4; vid.src = URL.createObjectURL(file); } } // play what Lens checks, so the blur lines up
    catch (e) { $('result').innerHTML = `<p>${esc(failText(e))}</p>`; return; }
    if (file.size > 20 * 1024 * 1024) { $('result').innerHTML = '<p>Videos up to 20 MB for now.</p>'; return; }
    if (tooBig(file)) return;
    const names = ['Muse Wonder is analysing the video and its audio', 'SAM 3.1 is tracking what to hide, frame by frame'];
    let s = 0; const show = () => { $('result').innerHTML = '<p><b>Checking…</b></p><ul class="steps">' + names.map((n, i) => `<li class="${i < s ? 'done' : ''}">${n}</li>`).join('') + '</ul>'; };
    show(); const timer = setInterval(() => { s = Math.min(s + 1, 1); show(); }, 12000);
    try {
      const res = await fetch('/api/lens/assess-video', { method: 'POST', body: file });
      const r = await res.json();
      if (!res.ok) throw new Error(r.error || 'Lens could not check this video.');
      showVideo(r);
    } catch (e) { $('result').innerHTML = `<p>${esc(failText(e))}</p>`; }
    finally { clearInterval(timer); }
  }

  const fmt = t => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
  function showVideo(r) {
    last = { kind: 'video', r };
    const tracks = ((r.harm && r.harm.tracks) || []).filter(t => t.privacy || r.harm.harmful);
    video = { result: r, tracks, blurOn: true };
    const harmful = tracks.filter(t => !t.privacy);
    const hiddenList = harmful.length ? ` SAM 3.1 tracked ${harmful.map(t => `the <b>${esc(t.what)}</b> through ${Object.keys(t.boxes).length} frames`).join(' and ')}; it's blurred as the video plays.` : '';
    const evidence = (r.signs || []).length ? `<h2>Evidence</h2><ol class="times">${r.signs.map(s => `<li>${s.at != null ? `<button type="button" data-at="${s.at}">${fmt(s.at)}</button>` : ''}<span class="what">${esc(s.what || 'Moment')}</span>: ${esc(s.why)}</li>`).join('')}</ol>` : '';
    const facts = `<p class="meta">${r.width}×${r.height}, ${r.duration.toFixed(1)} seconds, ${r.frameTimes.length} frames.</p>`;
    $('result').innerHTML = mode === 'real' ? `
      ${verdictPill(r)}
      <p class="summary">${esc(r.summary)}</p>
      ${editsHtml(r.edits)}
      ${evidence}
      ${harmHtml(r, harmful.length)}
      ${privacyHtml(tracks.filter(t => t.privacy).map(t => t.what))}
      ${facts}` : `
      ${harmHtml(r, hiddenList)}
      ${privacyHtml(tracks.filter(t => t.privacy).map(t => t.what))}
      ${aiAside(r)}
      ${facts}`;
    for (const a of document.querySelectorAll('[data-goto]')) a.onclick = e => { e.preventDefault(); setMode(a.dataset.goto); };
    for (const b of document.querySelectorAll('[data-at]')) b.onclick = () => { $('vid').currentTime = Number(b.dataset.at); $('vid').play(); };
    $('tools').style.display = tracks.length ? 'flex' : 'none';
    $('toggle').textContent = 'Show original';
    $('download').textContent = 'Download blurred video';
    startVideoBlur();
  }

  // The frame on screen: the last frame whose start time is at or before the video's current time.
  function frameAt(times, t) {
    let lo = 0, hi = times.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (times[mid] <= t + 0.001) lo = mid; else hi = mid - 1; }
    return lo;
  }
  // A track's box for a frame, or the nearest earlier frame's box (SAM can skip a frame or two).
  function boxAt(track, f) {
    for (let k = f; k >= Math.max(0, f - 5); k--) if (track.boxes[k]) return track.boxes[k];
    return null;
  }
  // Draws one frame's blurred patches onto `g` (size W×H, the video's own pixels scaled).
  function drawBlur(g, vid, f, W, H, full) {
    if (full) g.drawImage(vid, 0, 0, W, H); else g.clearRect(0, 0, W, H);
    if (!video.blurOn) return;
    for (const t of video.tracks) {
      const b = boxAt(t, f); if (!b) continue;
      const pad = 12, x1 = Math.max(0, b[0] - pad), y1 = Math.max(0, b[1] - pad), x2 = Math.min(1000, b[2] + pad), y2 = Math.min(1000, b[3] + pad);
      const x = x1 * W / 1000, y = y1 * H / 1000, w = (x2 - x1) * W / 1000, h = (y2 - y1) * H / 1000;
      g.save(); g.beginPath(); g.rect(x, y, w, h); g.clip();
      g.filter = `blur(${Math.max(10, Math.round(W / 50))}px)`;
      g.drawImage(vid, 0, 0, W, H); g.drawImage(vid, 0, 0, W, H);
      g.restore();
    }
  }
  let blurLoop = 0;
  function startVideoBlur() {
    stopVideoBlur();
    const vid = $('vid'), canvas = $('vblur'), g = canvas.getContext('2d');
    const tick = () => {
      if (!video) return;
      const rect = vid.getBoundingClientRect(), dpr = devicePixelRatio || 1;
      // The picture inside the element (letterboxed when the shapes differ).
      const s = Math.min(rect.width / video.result.width, rect.height / video.result.height);
      const W = Math.round(video.result.width * s), H = Math.round(video.result.height * s);
      if (canvas.width !== Math.round(W * dpr)) { canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); }
      Object.assign(canvas.style, { width: `${W}px`, height: `${H}px`, left: `${(rect.width - W) / 2}px`, top: `${(rect.height - H) / 2}px` });
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawBlur(g, vid, frameAt(video.result.frameTimes, vid.currentTime), W, H, false);
      blurLoop = vid.requestVideoFrameCallback ? vid.requestVideoFrameCallback(tick) : requestAnimationFrame(tick);
    };
    $('vid').onseeked = () => tick();
    tick();
  }
  // Also wipes the blur canvas, so the last video's blur never sits on top of the next video.
  function stopVideoBlur() { const vid = $('vid'), c = $('vblur'); if (blurLoop && vid.cancelVideoFrameCallback) vid.cancelVideoFrameCallback(blurLoop); cancelAnimationFrame(blurLoop); blurLoop = 0; c.getContext('2d').clearRect(0, 0, c.width, c.height); }

  // The blurred video, recorded in the browser: play it once, drawing each frame with its blur.
  async function downloadBlurredVideo() {
    const vid = $('vid'), W = video.result.width, H = video.result.height;
    const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d');
    const type = ['video/mp4;codecs=avc1.42E01F', 'video/mp4', 'video/webm'].find(t => MediaRecorder.isTypeSupported(t));
    const rec = new MediaRecorder(c.captureStream(30), { mimeType: type, videoBitsPerSecond: 5_000_000 });
    const chunks = []; rec.ondataavailable = e => e.data.size && chunks.push(e.data);
    const done = new Promise(res => rec.onstop = res);
    const was = video.blurOn; video.blurOn = true;
    $('download').disabled = true; $('download').textContent = 'Recording…';
    vid.pause(); vid.currentTime = 0; await new Promise(res => vid.onseeked = res); vid.onseeked = null;
    rec.start(500);
    await new Promise(res => {
      let finished = false;
      const frame = () => { if (finished) return; drawBlur(g, vid, frameAt(video.result.frameTimes, vid.currentTime), W, H, true); vid.requestVideoFrameCallback(frame); };
      vid.onended = () => { finished = true; vid.onended = null; res(); }; // no frame callback comes after the last frame
      vid.requestVideoFrameCallback(frame); vid.play();
    });
    rec.stop(); await done; video.blurOn = was; startVideoBlur();
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(chunks, { type })); a.download = `argus-lens-blurred.${type.includes('mp4') ? 'mp4' : 'webm'}`; a.click();
    $('download').disabled = false; $('download').textContent = 'Download blurred video';
  }

  // The safe version: the image with each hide box blurred hard, drawn in the browser.
  let showingSafe = false;
  async function makeSafe(regions) {
    const img = $('img'), canvas = $('safe');
    $('tools').style.display = regions.length ? 'flex' : 'none';
    if (!regions.length) { setSafe(false); return; }
    await img.decode().catch(() => {});
    const W = img.naturalWidth, H = img.naturalHeight, g = canvas.getContext('2d');
    canvas.width = W; canvas.height = H;
    g.drawImage(img, 0, 0);
    const radius = Math.max(12, Math.round(Math.max(W, H) / 45));
    for (const { hideBox: [x1, y1, x2, y2] } of regions) {
      const x = x1 * W / 1000, y = y1 * H / 1000, w = (x2 - x1) * W / 1000, h = (y2 - y1) * H / 1000;
      g.save(); g.beginPath(); g.rect(x, y, w, h); g.clip();
      g.filter = `blur(${radius}px)`;
      for (let pass = 0; pass < 3; pass++) g.drawImage(canvas, 0, 0); // blur the blurred: text can't be read back
      g.restore();
    }
    setSafe(true);
  }
  function setSafe(on) {
    showingSafe = on;
    $('safe').style.display = on ? 'block' : 'none';
    $('img').style.display = on ? 'none' : 'block';
    $('toggle').textContent = on ? 'Show original' : 'Show blurred';
  }
  $('toggle').onclick = () => {
    if (video) { video.blurOn = !video.blurOn; $('toggle').textContent = video.blurOn ? 'Show original' : 'Show blurred'; return; }
    setSafe(!showingSafe);
  };
  $('download').onclick = () => {
    if (video) return downloadBlurredVideo();
    const a = document.createElement('a'); a.href = $('safe').toDataURL('image/png'); a.download = 'argus-lens-blurred.png'; a.click();
  };

  $('file').onchange = e => check(e.target.files[0]);
  for (const b of document.querySelectorAll('.modes button')) b.onclick = () => setMode(b.dataset.mode);
  $('result').innerHTML = `<p class="empty">${MODES[mode].empty}</p>`;
  setMode(mode);
  for (const b of document.querySelectorAll('[data-sample]')) b.onclick = async e => {
    e.preventDefault(); e.stopPropagation();
    const blob = await (await fetch('/lens/samples/' + b.dataset.sample)).blob();
    check(new File([blob], b.dataset.sample, { type: blob.type }));
  };
  $('again').onclick = () => { setSafe(false); stopVideoBlur(); video = null; $('vid').pause(); $('vstage').style.display = 'none'; $('tools').style.display = 'none'; $('stage').style.display = 'none'; $('drop').style.display = ''; $('again').style.display = 'none'; $('file').value = ''; last = null; $('result').innerHTML = `<p class="empty">${MODES[mode].empty}</p>`; };
  const drop = $('drop');
  drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); check(e.dataTransfer.files[0]); };
  document.onpaste = e => { const f = [...e.clipboardData.files].find(f => f.type.startsWith('image/') || f.type.startsWith('video/')); if (f) check(f); };
