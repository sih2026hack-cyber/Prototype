// Argus on YouTube, Reddit, Instagram and (opt-in) WhatsApp Web: catches the site's
// Post/Comment/Reply/Send click (and the key that sends) before the site sees it,
// checks the text, and only lets it through when it's allowed.
//
//   clean       → posts, as if nothing happened
//   rude        → blocked; reason + a better way to say it ([Use this] posts that)
//   severe      → blocked; explanation; the writer must edit it
//   unsure      → blocked; a moderator decides; approved → [Post it]
//   unavailable → blocked (fail closed); [Try again]
(() => {
  if (window.__argusLoaded) return;
  window.__argusLoaded = true;

  // One block per site: the container that holds one comment box and its button, and
  // whether a plain Enter sends (otherwise only Ctrl/Cmd+Enter does).
  //   private:      the whole site is private messages (WhatsApp).
  //   privatePaths: pages of an otherwise public site that are private messages (Instagram DMs).
  // Private messages are off until the writer switches them on, and are checked but never
  // stored, never shown to a moderator, and sent without page context.
  const SITES = {
    youtube: { composer: 'ytd-commentbox, ytm-comment-simplebox-renderer', enterSends: false },
    reddit: { composer: 'shreddit-composer, comment-composer-host, faceplate-form, form.usertext', enterSends: false },
    // Instagram changes its markup often, so besides the known shapes it also finds the
    // box by proximity: the nearest area holding both a text box and a Post/Send button.
    // DMs: the /direct/ pages, and the pop-up chat on any page (its box is labelled "Message").
    instagram: { composer: 'form:has(textarea), form:has([contenteditable="true"])', enterSends: true, byProximity: true, privatePaths: /^\/direct\//, privateBox: /^message/i },
    whatsapp: { composer: 'footer:has([contenteditable="true"])', enterSends: true, private: true },
  };
  const detectSite = (h) =>
    h.includes('youtube') ? 'youtube' : h.includes('reddit') ? 'reddit' : h.includes('instagram') ? 'instagram' : h.includes('whatsapp') ? 'whatsapp' : null;
  const SITE = window.__ARGUS_SITE || detectSite(location.hostname);
  const CONF = SITES[SITE];
  if (!CONF) return;
  // Shows in the page's DevTools Console (filter: Argus) — so a writer can tell us what they see.
  console.info(`[Argus] running on ${SITE}`, chrome.runtime?.getManifest?.().version || '');
  // Private messages: by the page (checked on each use — Instagram is a single-page app) or
  // by the box itself. Defaults to the box being watched.
  const boxName = (el) => (el.getAttribute('aria-label') || el.getAttribute('aria-placeholder') || el.getAttribute('placeholder') || '').trim();
  const isPrivate = (editor = live && live.editor) =>
    !!CONF.private || !!CONF.privatePaths?.test(location.pathname) || (!!CONF.privateBox && !!editor && CONF.privateBox.test(boxName(editor)));
  // The writer's switch for private messages ("messages"; older versions saved it as "whatsapp").
  let messagesOn = false;
  chrome.storage?.sync
    ?.get(['messages', 'whatsapp'])
    .then((v) => (messagesOn = v.messages === true || v.whatsapp === true))
    .catch(() => {});
  chrome.storage?.onChanged?.addListener((ch) => {
    if (ch.messages) messagesOn = ch.messages.newValue === true;
  });
  const active = (editor) => !isPrivate(editor) || messagesOn;
  // What the server is told this is: private pages are reported as such, so they're never stored.
  const siteForServer = (editor) => (isPrivate(editor) && SITE === 'instagram' ? 'instagram_dm' : SITE);
  // Buttons that publish. Matched on the visible label or aria-label.
  const SUBMIT_LABEL = /^(comment|reply|save|post|send)$/i;
  // If we can't read the text inside one of this site's boxes, we block rather than let
  // an unchecked comment through (fail closed).
  const SITE_COMPOSER = CONF.composer;
  const COMPOSER = `${SITE_COMPOSER}, form`;
  const EDITOR = 'textarea, [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]';
  const POLL_MS = 4000;

  // A composer whose current text was cleared to post: the next submit goes through.
  const cleared = new WeakMap(); // composer -> { text, until }
  const busy = new WeakSet();

  // ---------- finding the box, its button and its text ----------

  const asElements = (path) => path.filter((n) => n instanceof Element);

  // A button's name: its own label or text — or, for icon-only buttons (Instagram's and
  // WhatsApp's send arrows), the label of the icon inside it.
  function labelOf(el) {
    // A button we greyed out carries our tooltip as its title: read the site's own title.
    const title = el.dataset && el.dataset.argusBlocked ? el.dataset.argusTitle : el.getAttribute('title');
    const own = (el.getAttribute('aria-label') || title || el.value || el.textContent || '').trim();
    if (own) return own;
    const icon = el.querySelector('[aria-label], title, [data-icon]');
    return (icon?.getAttribute('aria-label') || icon?.getAttribute('data-icon') || icon?.textContent || '').trim();
  }

  function submitButtonIn(path) {
    for (const el of asElements(path)) {
      if (el.matches('button, [role="button"], input[type="submit"]') && SUBMIT_LABEL.test(labelOf(el))) return el;
    }
    return null;
  }

  // Composers found by proximity count as this site's own (so an unreadable one blocks).
  const foundByProximity = new WeakSet();
  const isSiteComposer = (el) => el.matches(SITE_COMPOSER) || foundByProximity.has(el);

  function composerIn(path) {
    const known = asElements(path).find((el) => el.matches(COMPOSER));
    if (known || !CONF.byProximity) return known || null;
    const near = composerNear(path);
    if (near) foundByProximity.add(near);
    return near;
  }

  // From the text box being typed in (or the Post button being clicked), walk outwards to
  // the smallest area that contains both a text box and a submit-labelled button.
  function composerNear(path) {
    const start = asElements(path).find(
      (el) => el.matches(EDITOR) || (el.matches('button, [role="button"], input[type="submit"]') && SUBMIT_LABEL.test(labelOf(el)))
    );
    let el = start ? start.parentElement || start.getRootNode()?.host : null;
    for (let depth = 0; el && depth < 12; depth++) {
      if (el === document.body) return null;
      if (editorIn(el) && buttonIn(el)) return el;
      el = el.parentElement || el.getRootNode()?.host || null;
    }
    return null;
  }

  // querySelector that also looks inside shadow roots (Reddit uses web components) —
  // including the root element's own shadow root.
  function deepQuery(root, selector) {
    if (root.shadowRoot) {
      const inOwn = deepQuery(root.shadowRoot, selector);
      if (inOwn) return inOwn;
    }
    const direct = root.querySelector(selector);
    if (direct) return direct;
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) {
        const found = deepQuery(el.shadowRoot, selector);
        if (found) return found;
      }
    }
    return null;
  }

  function deepQueryAll(root, selector, out = []) {
    if (root.shadowRoot) deepQueryAll(root.shadowRoot, selector, out);
    out.push(...root.querySelectorAll(selector));
    for (const el of root.querySelectorAll('*')) if (el.shadowRoot) deepQueryAll(el.shadowRoot, selector, out);
    return out;
  }

  const editorIn = (composer) => deepQuery(composer, EDITOR);
  const buttonIn = (composer) =>
    deepQueryAll(composer, 'button, [role="button"], input[type="submit"]').find((b) => SUBMIT_LABEL.test(labelOf(b))) || null;
  const isField = (el) => el.tagName === 'TEXTAREA' || el.tagName === 'INPUT';
  const textOf = (editor) => (isField(editor) ? editor.value : editor.innerText || '').trim();

  // What the comment replies to: the video or post title. Shapes the suggestion only.
  // Never sent for private messages.
  function replyingTo(editor) {
    if (isPrivate(editor)) return undefined;
    const pick = (sel) => document.querySelector(sel)?.textContent?.trim();
    const t =
      SITE === 'youtube'
        ? pick('h1.ytd-watch-metadata') || pick('#title h1') || document.title
        : SITE === 'reddit'
          ? document.querySelector('shreddit-post')?.getAttribute('post-title') || pick('h1') || document.title
          : pick('h1') || document.title;
    return (t || '').slice(0, 300);
  }

  // Puts the text in the box. Resolves true only once the box really shows it.
  async function setText(editor, value) {
    const done = () => normalize(textOf(editor)) === normalize(value);
    const tick = (ms) => new Promise((r) => setTimeout(r, ms));
    editor.focus();
    if (isField(editor)) {
      // React-controlled fields ignore .value = ...; use the native setter and fire input.
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(editor), 'value').set;
      setter.call(editor, value);
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      return done();
    }
    const selectAll = () => {
      const range = document.createRange();
      range.selectNodeContents(editor);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    };
    selectAll();
    await tick(30); // editors like Lexical pick up the selection a moment later
    // Rich editors that keep their own copy of the text (Instagram's Lexical) undo direct
    // edits but accept a paste — the same way the writer would put text in.
    const data = new DataTransfer();
    data.setData('text/plain', value);
    const paste = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
    editor.dispatchEvent(paste);
    if (paste.defaultPrevented) {
      await tick(60);
      if (done()) return true;
      selectAll();
    }
    // Plain boxes (YouTube, Reddit's editor): through the browser's own editing.
    if (!document.execCommand('insertText', false, value)) {
      editor.textContent = value;
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    }
    await tick(60);
    return done();
  }

  // ---------- the card ----------

  const host = document.createElement('div');
  host.id = 'argus-card-host';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `<style>
    :host { all: initial; }
    .card { position: fixed; right: 20px; bottom: 20px; z-index: 2147483647; width: min(380px, calc(100vw - 32px));
      box-sizing: border-box; padding: 16px; border-radius: 14px; border: 1px solid #e3e6eb; background: #fff; color: #15171c;
      font: 14px/1.55 'Segoe UI', system-ui, -apple-system, sans-serif; box-shadow: 0 10px 30px rgba(21,23,28,.16); }
    .card[data-tone="warn"] { background: #fff8eb; border-color: #f6dfb4; }
    .card[data-tone="danger"] { background: #fef3f2; border-color: #f9d0cc; }
    .card[data-tone="ok"] { background: #ecfdf3; border-color: #b7ebc9; }
    .brand { font-size: 12px; color: #6a7180; margin-bottom: 4px; }
    .label { display: inline-block; margin-bottom: 6px; padding: 2px 10px; border-radius: 999px; font-size: 12px; font-weight: 650; background: #fde8c4; color: #8a4b08; }
    [data-tone="danger"] .label { background: #fbd5d1; color: #b42318; }
    .title { font-weight: 650; }
    [data-tone="warn"] .title, [data-tone="warn"] .reason { color: #8a4b08; }
    [data-tone="danger"] .title, [data-tone="danger"] .reason { color: #b42318; }
    [data-tone="ok"] .title { color: #067647; }
    .reason { margin-top: 4px; }
    .argus { margin-top: 10px; padding: 10px 12px; background: #fff; border-radius: 10px; }
    .before { color: #6a7180; text-decoration: line-through; }
    .after { margin-top: 6px; }
    .after span { background: linear-gradient(transparent 12%, #fff3b0 12%, #fff3b0 88%, transparent 88%); padding: 0 2px; }
    .buttons { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; align-items: center; }
    button { font: 600 14px 'Segoe UI', system-ui, sans-serif; border-radius: 10px; padding: 8px 14px; cursor: pointer; border: 1px solid #e3e6eb; background: #fff; color: #15171c; }
    button.primary { background: #2b4acb; border-color: #2b4acb; color: #fff; }
    [data-tone="danger"] button.primary { background: #b42318; border-color: #b42318; }
    button.close { margin-left: auto; border: 0; background: transparent; color: #6a7180; padding: 4px 6px; }
    .muted { color: #6a7180; font-size: 13px; }
    .pattern { margin-top: 10px; padding: 8px 10px; border-radius: 10px; background: #f4f3ff; color: #5925dc; font-size: 13px; font-weight: 600; }
    button:focus-visible { outline: 2px solid #2b4acb; outline-offset: 2px; }
    /* The live badge: sits in the comment box's bottom-right corner, like Grammarly's. */
    .badge { position: fixed; z-index: 2147483645; width: 26px; height: 26px; border-radius: 50%; padding: 0;
      display: grid; place-items: center; font: 700 12px 'Segoe UI', system-ui, sans-serif; cursor: pointer;
      border: 2px solid #c5cad3; background: #fff; color: #6a7180; box-shadow: 0 2px 6px rgba(21,23,28,.15); }
    .badge[hidden] { display: none; }
    .badge[data-state="checking"] { border-color: #2b4acb; border-top-color: transparent; animation: spin .8s linear infinite; }
    .badge[data-state="clean"] { border-color: #12b76a; background: #ecfdf3; color: #067647; }
    .badge[data-state="rude"] { border-color: #f79009; background: #fff8eb; color: #8a4b08; }
    .badge[data-state="severe"] { border-color: #d92d20; background: #fef3f2; color: #b42318; }
    .badge[data-state="unsure"] { border-color: #7a5af8; background: #f4f3ff; color: #5925dc; }
    /* Every Argus card: centred on the screen, page dimmed behind it — it can't be missed.
       The dimmed layer is a popover, so it opens in the browser's top layer: above everything,
       and centred on the screen whatever the site's own layout does (Instagram's moved it). */
    .backdrop { position: fixed; inset: 0; width: auto; height: auto; max-width: none; max-height: none; margin: 0;
      padding: 16px; border: 0; box-sizing: border-box; z-index: 2147483646; background: rgba(21,23,28,.45);
      display: none; place-items: center; overflow: auto; }
    .backdrop:popover-open, .backdrop.open { display: grid; }
    .card[data-mode="modal"] { position: relative; right: auto; bottom: auto; left: auto; top: auto;
      width: min(440px, calc(100vw - 32px)); padding: 20px; font-size: 15px; box-shadow: 0 20px 60px rgba(21,23,28,.35); }
    .card[data-mode="modal"] .title { font-size: 17px; }
    @keyframes spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .badge[data-state="checking"] { animation: none; } }
  </style><div class="backdrop" popover="manual"><div class="card" role="status" hidden></div></div><button class="badge" type="button" hidden aria-label="Argus">A</button>`;
  const card = shadow.querySelector('.card');
  const badge = shadow.querySelector('.badge');
  const backdrop = shadow.querySelector('.backdrop');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  // What's wrong, in two words ("Personal attack", "Threat"), above the title.
  const pill = (label) => (label ? `<div class="label">${esc(label)}</div>` : '');

  let pollTimer = null;
  let cardKey = null; // the live-checked text the open card is about (null for Post-time cards)
  const dismissed = new Set(); // live-checked texts whose card the writer closed: don't pop it again
  function hide() {
    if (cardKey) dismissed.add(cardKey);
    cardKey = null;
    card.hidden = true;
    if (backdrop.matches?.(':popover-open')) backdrop.hidePopover();
    backdrop.classList.remove('open');
    clearTimeout(pollTimer);
  }
  // Every card opens centred over a dimmed page. Closing it never posts anything.
  // focus: false when the card opens by itself mid-typing — the cursor stays in the comment box.
  function show(tone, html, actions = {}, { focus = true } = {}) {
    const mode = 'modal';
    if (!host.isConnected) document.documentElement.appendChild(host);
    clearTimeout(pollTimer);
    card.dataset.tone = tone;
    card.dataset.mode = mode;
    card.innerHTML = `<div class="brand">Argus</div>${html}`;
    card.hidden = false;
    if (backdrop.showPopover) {
      if (!backdrop.matches(':popover-open')) backdrop.showPopover();
    } else backdrop.classList.add('open'); // older browsers: a plain fixed layer
    for (const [name, fn] of Object.entries(actions)) card.querySelector(`[data-act="${name}"]`)?.addEventListener('click', fn);
    card.querySelector('[data-act="close"]')?.addEventListener('click', hide);
    if (focus) card.querySelector('button.primary, button')?.focus();
  }
  // A click on the dimmed area (not the card) closes it. Closing never posts anything.
  backdrop.addEventListener('click', (e) => e.target === backdrop && hide());
  shadow.addEventListener('keydown', (e) => e.key === 'Escape' && hide());
  document.addEventListener('keydown', (e) => e.key === 'Escape' && !card.hidden && hide());

  // ---------- the flow ----------

  function postNow(composer, button, text) {
    cleared.set(composer, { text, until: Date.now() + 5000 });
    hide();
    (button && button.isConnected ? button : buttonIn(composer))?.click();
  }

  function editIt(editor) {
    hide();
    editor.focus();
  }

  // The site wouldn't take the text from us: let the writer paste it in themselves.
  function couldNotInsert(text) {
    show('warn', `<div class="title">Paste it in yourself</div><div class="reason">This site didn't let Argus change the text. Copy the better version, then paste it over your message.</div><div class="argus"><div class="after"><span>${esc(text)}</span></div></div><div class="buttons"><button class="primary" data-act="copy">Copy</button><button class="close" data-act="close">Close</button></div>`, {
      copy: async (e) => {
        try { await navigator.clipboard.writeText(text); e.target.textContent = 'Copied'; } catch { e.target.textContent = 'Select and copy it above'; }
      },
    });
  }

  // ---------- repeat harshness (only the writer sees it; stays in this browser) ----------
  // From the 3rd harsh send to the same person (or on the same post) within a week, the card
  // says so. A nudge only: it never changes what is allowed. Who it was to is stored as a hash,
  // never the text, and entries go after 30 days. Settings has "Clear my history".
  const REPEAT = { WINDOW_MS: 7 * 24 * 3600_000, KEEP_MS: 30 * 24 * 3600_000, FROM: 3 };
  async function hashOf(value) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return [...new Uint8Array(digest)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  const ordinal = (n) => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th');

  // Who this goes to: the open chat for private messages, the post or video for comments.
  // null when we can't tell — then nothing is counted rather than counted against the wrong person.
  function conversationOf(editor) {
    if (SITE === 'whatsapp') {
      const name = document.querySelector('#main header span[dir="auto"]')?.textContent?.trim();
      return name ? { key: name, person: true } : null;
    }
    if (SITE === 'instagram' && isPrivate(editor)) {
      const thread = location.pathname.match(/^\/direct\/t\/([^/]+)/);
      if (thread) return { key: 'thread:' + thread[1], person: true };
      // The pop-up chat: the profile link in the chat panel around the box (the panel is narrow,
      // so the page's own navigation links, further out, are never reached).
      for (let el = editor.parentElement, i = 0; el && i < 20; el = el.parentElement, i++) {
        if (el.getBoundingClientRect().width > 700) break;
        const link = [...el.querySelectorAll('a[href]')].find((a) => /^\/[A-Za-z0-9._]+\/?$/.test(a.getAttribute('href')) && !/^\/(direct|explore|reels|accounts)\/?$/.test(a.getAttribute('href')));
        if (link) return { key: 'user:' + link.getAttribute('href').replace(/\//g, ''), person: true };
      }
      return null;
    }
    if (SITE === 'youtube') return { key: new URLSearchParams(location.search).get('v') || location.pathname, person: false };
    if (SITE === 'instagram') {
      const post = editor.closest('article')?.querySelector('a[href*="/p/"], a[href*="/reel/"]')?.getAttribute('href');
      return { key: post || location.pathname, person: false };
    }
    return { key: location.pathname, person: false };
  }

  // Records a harsh send and returns the card's line once it's a pattern ('' otherwise).
  async function noteRepeat(editor, text) {
    const conv = conversationOf(editor);
    if (!conv || !chrome.storage?.local) return '';
    try {
      const [who, which] = await Promise.all([hashOf(SITE + '|' + conv.key), hashOf(normalize(text))]);
      const now = Date.now();
      const { harshLog = {} } = await chrome.storage.local.get('harshLog');
      for (const k of Object.keys(harshLog)) {
        harshLog[k] = harshLog[k].filter((e) => now - e.t < REPEAT.KEEP_MS);
        if (!harshLog[k].length) delete harshLog[k];
      }
      const list = harshLog[who] || [];
      if (!list.some((e) => e.x === which)) list.push({ t: now, x: which }); // the same text tried again counts once
      harshLog[who] = list;
      await chrome.storage.local.set({ harshLog });
      const n = list.filter((e) => now - e.t < REPEAT.WINDOW_MS).length;
      if (n < REPEAT.FROM) return '';
      const what = conv.person ? 'message to this person' : `comment on this ${SITE === 'youtube' ? 'video' : 'post'}`;
      return `<div class="pattern">This is your ${ordinal(n)} harsh ${what} this week. Take a moment before you ${conv.person ? 'send' : 'post'} it.</div>`;
    } catch {
      return '';
    }
  }

  async function check(composer, button, editor, text) {
    if (busy.has(composer)) return;
    busy.add(composer);
    show('', '<div class="title">Checking your comment…</div>');
    let r;
    try {
      r = await chrome.runtime.sendMessage({ type: 'check', text, site: siteForServer(editor), replyingTo: replyingTo(editor) });
    } catch (e) {
      r = { error: whyUnreachable(e) };
    } finally {
      busy.delete(composer);
    }
    if (!r || r.error || r.verdict === 'unavailable') {
      const why = whyUnreachable(r && (r.error || r.reason));
      r = { allowed: false, verdict: 'unavailable', reason: /posted/i.test(why) ? why : `${why} It hasn't been posted.` };
    }
    // The writer changed the text while we were checking: start over on their next click.
    if (textOf(editor) !== text) return hide();

    if (r.allowed) return postNow(composer, button, text);
    const pattern = r.verdict === 'rude' || r.verdict === 'severe' ? await noteRepeat(editor, text) : '';

    if (r.verdict === 'rude') {
      const argus = r.suggestion
        ? `<div class="argus"><div class="before">${esc(text)}</div><div class="after"><span>${esc(r.suggestion)}</span></div></div>`
        : `<div class="reason">${isPrivate(editor) ? 'Try saying what upset you, without attacking the person.' : 'Try saying how you feel about the video or post, not the person.'}</div>`;
      return show(
        'warn',
        `${pill(r.label)}<div class="title">Not posted yet</div><div class="reason">${esc(r.reason)}</div>${argus}${pattern}
         <div class="buttons">${r.suggestion ? '<button class="primary" data-act="use">Use this</button>' : ''}<button data-act="edit">Edit</button></div>`,
        {
          use: async () => {
            // The suggestion already passed the check; post exactly that — once it's really in the box.
            if (await setText(editor, r.suggestion)) return postNow(composer, button, r.suggestion);
            couldNotInsert(r.suggestion);
          },
          edit: () => editIt(editor),
        }
      );
    }

    if (r.verdict === 'severe') {
      return show(
        'danger',
        `${pill(r.label)}<div class="title">This can't be posted</div><div class="reason">${esc(r.reason)}</div>${pattern}
         <div class="buttons"><button class="primary" data-act="edit">Edit my ${isPrivate(editor) ? 'message' : 'comment'}</button>${isPrivate(editor) ? '' : '<span class="muted">A moderator can see this.</span>'}</div>`,
        { edit: () => editIt(editor) }
      );
    }

    if (r.verdict === 'unsure' && r.id) return waitForModerator(composer, button, editor, text, r.id, r.reason);
    if (r.verdict === 'unsure') {
      // Private messages never go to a moderator: the writer rephrases instead.
      return show(
        'warn',
        `<div class="title">Not sure how this reads</div><div class="reason">We can't read this one confidently, so it isn't sent. Try rephrasing it more clearly.</div>
         <div class="buttons"><button class="primary" data-act="edit">Edit my message</button></div>`,
        { edit: () => editIt(editor) }
      );
    }

    return show(
      'warn',
      `<div class="title">Couldn't check right now</div><div class="reason">${esc(r.reason)}</div>
       <div class="buttons"><button class="primary" data-act="retry">Try again</button><button class="close" data-act="close">Close</button></div>`,
      { retry: () => check(composer, button, editor, textOf(editor)) }
    );
  }

  function waitForModerator(composer, button, editor, text, id, reason) {
    show(
      'warn',
      `<div class="title">A moderator is checking this</div><div class="reason">${esc(reason)}</div>
       <div class="buttons"><span class="muted">It stays unposted until they decide. You can keep this tab open.</span><button data-act="edit">Edit instead</button></div>`,
      { edit: () => editIt(editor) }
    );
    const poll = async () => {
      if (card.hidden) return; // the writer moved on
      let s;
      try {
        s = await chrome.runtime.sendMessage({ type: 'status', id });
      } catch {
        s = null;
      }
      const status = s && s.status;
      if (status === 'approved') {
        if (textOf(editor) !== text) return hide();
        return show(
          'ok',
          `<div class="title">A moderator approved this</div><div class="reason">You can post it now.</div>
           <div class="buttons"><button class="primary" data-act="post">Post it</button><button class="close" data-act="close">Not now</button></div>`,
          { post: () => postNow(composer, button, text) }
        );
      }
      if (status === 'rejected' || status === 'expired') {
        const why = status === 'rejected' ? 'A moderator looked at this and kept it blocked.' : 'No moderator answered in time, so it stays blocked.';
        return show(
          'danger',
          `<div class="title">Not posted</div><div class="reason">${why} Edit it and try again.</div>
           <div class="buttons"><button class="primary" data-act="edit">Edit my comment</button></div>`,
          { edit: () => editIt(editor) }
        );
      }
      pollTimer = setTimeout(poll, POLL_MS);
    };
    pollTimer = setTimeout(poll, POLL_MS);
  }

  // ---------- live check while typing (Grammarly-style badge) ----------
  // Only a hint: the real check still runs when the writer clicks Post. Built to be cheap:
  // checks only after a typing pause, never the same text twice, verdict only (one model
  // call), suggestions only on request, and at most LIVE_PER_MINUTE checks a minute.
  const LIVE_PAUSE_MS = 1500;
  const LIVE_MIN_CHARS = 4;
  const LIVE_PER_MINUTE = 6;
  const BADGE_TEXT = {
    idle: 'Argus checks your comment when you pause typing',
    checking: 'Checking…',
    clean: 'Looks good',
    rude: 'Could come across as rude — click for a better way to say it',
    severe: "This can't be posted — click to see why",
    unsure: 'Not sure how this reads — a moderator will check it when you post',
    paused: "Live checks paused for a moment — it'll still be checked when you post",
    unavailable: "Couldn't check right now — it'll be checked when you post",
  };
  // Says why the extension couldn't get an answer, so the writer knows what to fix.
  function whyUnreachable(err) {
    const msg = String((err && err.message) || err || '');
    if (!chrome.runtime || !chrome.runtime.id || /context invalidated/i.test(msg)) {
      return 'Argus was reloaded or updated. Reload this page (F5) to turn it back on.';
    }
    if (/failed to fetch|networkerror|load failed/i.test(msg)) {
      return "Can't reach the Argus server. Check it's running and that the Server address in Argus's settings is right.";
    }
    return msg || "Couldn't check right now.";
  }
  let liveError = '';
  const liveCache = new Map(); // normalized text -> { verdict, reason }
  const liveTimes = [];
  let live = null; // { composer, editor }
  let liveTimer = null;
  let liveInFlight = false;

  const normalize = (t) => t.trim().replace(/\s+/g, ' ').toLowerCase();

  function placeBadge() {
    if (!live || !live.editor.isConnected) return (badge.hidden = true);
    const r = live.editor.getBoundingClientRect();
    if (r.width === 0 || r.bottom < 0 || r.top > innerHeight) return (badge.hidden = true);
    badge.style.left = `${Math.min(r.right - 32, innerWidth - 32)}px`;
    badge.style.top = `${Math.min(r.bottom - 32, innerHeight - 32)}px`;
    badge.hidden = false;
  }

  // Until the draft is checked and fine, the site's Post/Send button looks and acts disabled.
  let blockedButton = null;
  function setButtonBlocked(composer, on, why = 'Argus: rewrite this comment before posting') {
    if (blockedButton && (!on || !blockedButton.isConnected)) {
      blockedButton.style.removeProperty('opacity');
      blockedButton.style.removeProperty('cursor');
      blockedButton.removeAttribute('aria-disabled');
      if (blockedButton.dataset.argusTitle !== undefined) blockedButton.title = blockedButton.dataset.argusTitle;
      delete blockedButton.dataset.argusTitle;
      delete blockedButton.dataset.argusBlocked;
      blockedButton = null;
    }
    if (!on) return;
    const b = buttonIn(composer);
    if (!b) return;
    if (!b.dataset.argusBlocked) b.dataset.argusTitle = b.title || '';
    b.dataset.argusBlocked = '1';
    b.style.setProperty('opacity', '0.4', 'important');
    b.style.setProperty('cursor', 'not-allowed', 'important');
    b.setAttribute('aria-disabled', 'true');
    b.title = why;
    blockedButton = b;
  }

  function setBadge(state) {
    badge.dataset.state = state;
    badge.textContent = state === 'clean' ? '✓' : state === 'rude' || state === 'severe' || state === 'unsure' ? '!' : 'R';
    badge.title = state === 'unsure' && isPrivate() ? 'Not sure how this reads — try rephrasing it'
      : state === 'unavailable' && liveError ? `${liveError} It will be checked when you ${isPrivate() ? 'send' : 'post'} it.`
      : BADGE_TEXT[state] || BADGE_TEXT.idle;
    badge.setAttribute('aria-label', `Argus: ${badge.title}`);
    if (live) {
      const flagged = state === 'rude' || state === 'severe' || state === 'unsure';
      const hasText = normalize(textOf(live.editor)).length > 0;
      setButtonBlocked(live.composer, flagged || (state !== 'clean' && hasText),
        flagged ? 'Argus: rewrite this before sending' : 'Argus: checking this first — click to check now');
    }
    placeBadge();
  }

  function attach(composer, editor) {
    if (live && live.editor === editor) return;
    live = { composer, editor };
    if (!host.isConnected) document.documentElement.appendChild(host);
    const cached = liveCache.get(normalize(textOf(editor)));
    setBadge(cached ? cached.verdict : 'idle');
  }

  function scheduleLive() {
    clearTimeout(liveTimer);
    if (!live) return;
    const key = normalize(textOf(live.editor));
    if (key.length < LIVE_MIN_CHARS) return setBadge('idle');
    const cached = liveCache.get(key);
    if (cached) return setBadge(cached.verdict); // never pay twice for the same text
    setBadge('idle');
    liveTimer = setTimeout(runLive, LIVE_PAUSE_MS);
  }

  async function runLive() {
    if (!live || liveInFlight) return;
    const text = textOf(live.editor);
    const key = normalize(text);
    if (key.length < LIVE_MIN_CHARS || liveCache.has(key)) return scheduleLive();
    const now = Date.now();
    while (liveTimes.length && now - liveTimes[0] > 60_000) liveTimes.shift();
    if (liveTimes.length >= LIVE_PER_MINUTE) {
      setBadge('paused');
      liveTimer = setTimeout(runLive, 60_000 - (now - liveTimes[0]) + 50);
      return;
    }
    liveTimes.push(now);
    liveInFlight = true;
    setBadge('checking');
    let r;
    try {
      r = await chrome.runtime.sendMessage({ type: 'peek', text });
    } catch (e) {
      r = { error: whyUnreachable(e) };
    } finally {
      liveInFlight = false;
    }
    const verdict = r && r.verdict && r.verdict !== 'unavailable' ? r.verdict : null;
    // Server reached but the AI didn't answer in time: say so plainly.
    liveError = verdict ? '' : r && r.verdict === 'unavailable' ? "The AI checker is slow right now, so this hasn't been checked yet." : whyUnreachable(r && (r.error || r.reason));
    if (verdict) liveCache.set(key, { verdict, reason: r.reason, label: r.label });
    // The writer kept typing while we checked: show the result only if it still applies.
    if (live && normalize(textOf(live.editor)) === key) {
      setBadge(verdict || 'unavailable');
      // A problem: open the card by itself (once per text), without taking the cursor.
      if ((verdict === 'rude' || verdict === 'severe' || verdict === 'unsure') && !dismissed.has(key) && card.hidden) {
        openFromBadge({ auto: true });
      }
    } else scheduleLive();
  }

  // Opens the card for the current draft — by itself after a live check flags a problem
  // (auto), or when the writer clicks the badge.
  async function openFromBadge({ auto = false } = {}) {
    if (!live) return;
    const { editor } = live;
    const text = textOf(editor);
    const key = normalize(text);
    const result = liveCache.get(key);
    const opts = { focus: !auto };
    const open = (tone, html, actions) => {
      show(tone, html, actions, opts);
      cardKey = key;
    };
    const close = '<div class="buttons"><button class="close" data-act="close">Close</button></div>';
    if (!result) {
      if (badge.dataset.state === 'unavailable') {
        return open('', `<div class="title">Not checked yet</div><div class="reason">${esc(badge.title)}</div><div class="buttons"><button class="primary" data-act="retry">Try again</button><button class="close" data-act="close">Close</button></div>`, {
          retry: () => { hide(); runLive(); },
        });
      }
      return open('', `<div class="title">Argus</div><div class="reason">${esc(badge.title.replace(/^Argus: /, ''))}</div>${close}`);
    }
    if (result.verdict === 'clean') return open('ok', `<div class="title">Looks good</div>${close}`);
    if (result.verdict === 'severe') {
      return open(
        'danger',
        `${pill(result.label)}<div class="title">This can't be posted</div><div class="reason">${esc(result.reason)}</div><div class="buttons"><button class="primary" data-act="edit">Edit my comment</button></div>`,
        { edit: () => editIt(editor) }
      );
    }
    if (result.verdict === 'unsure') {
      const why = isPrivate() ? "We can't read this one confidently, so it isn't sent. Try rephrasing it more clearly." : "We can't read this one confidently. When you post, a moderator will check it first.";
      return open('warn', `<div class="title">Not sure how this reads</div><div class="reason">${why}</div>${close}`);
    }

    // Rude: show the reason right away, and the better way to say it as soon as it's ready.
    const head = `${pill(result.label)}<div class="title">Could come across as rude</div><div class="reason">${esc(result.reason)}</div>`;
    open('warn', `${head}<div class="argus"><div class="muted">Finding a better way to say it…</div></div><div class="buttons"><button data-act="edit">Edit it myself</button></div>`, {
      edit: () => editIt(editor),
    });
    let s;
    try {
      s = await chrome.runtime.sendMessage({ type: 'suggest', text, replyingTo: replyingTo() });
    } catch {
      s = null;
    }
    // The writer moved on (kept typing, closed the card): drop the late answer.
    if (textOf(editor) !== text || card.hidden || cardKey !== key) return;
    if (!s || !s.suggestion) {
      return open('warn', `${head}<div class="reason">Try saying how you feel about the video or post, not the person.</div><div class="buttons"><button class="primary" data-act="edit">Edit it myself</button></div>`, {
        edit: () => editIt(editor),
      });
    }
    open(
      'warn',
      `${head}<div class="argus"><div class="before">${esc(text)}</div><div class="after"><span>${esc(s.suggestion)}</span></div></div><div class="buttons"><button class="primary" data-act="use">Use this</button><button data-act="edit">Edit it myself</button></div>`,
      {
        use: async () => {
          // Our own suggestion already scored clean on the server: no live check for it,
          // and the server answers the Post check from memory (no new AI call).
          liveCache.set(normalize(s.suggestion), { verdict: 'clean', reason: '', label: null });
          if (!(await setText(editor, s.suggestion))) return couldNotInsert(s.suggestion);
          cardKey = null; // not a dismissal — the text changed
          hide();
          editor.focus();
          scheduleLive();
        },
        edit: () => editIt(editor),
      }
    );
  }

  badge.addEventListener('click', () => openFromBadge());

  // A text box Argus doesn't recognise: print its structure once, for fixing the site setup.
  const reported = new WeakSet();
  function reportUnknownBox(path) {
    const start = asElements(path).find((el) => el.matches(EDITOR));
    if (!start || reported.has(start)) return;
    reported.add(start);
    const lines = [];
    for (let el = start, i = 0; el && i < 14; i++) {
      const a = (n) => el.getAttribute?.(n);
      const buttons = [...el.querySelectorAll('button, [role="button"]'), ...(el.shadowRoot?.querySelectorAll('button, [role="button"]') || [])].map((b) => labelOf(b).slice(0, 14)).filter(Boolean);
      lines.push(`${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${a('slot') ? ' slot=' + a('slot') : ''}${el.matches(EDITOR) ? ' [editable]' : ''}${a('role') ? ' role=' + a('role') : ''}${a('aria-label') ? ` "${a('aria-label')}"` : ''}${el.shadowRoot ? ' (shadow)' : ''} buttons: ${buttons.join(' | ')}`);
      el = el.parentElement || el.getRootNode?.().host || null;
    }
    console.info(`[Argus] didn't recognise this text box on ${SITE}. Its structure:\n${lines.join('\n')}`);
  }

  window.addEventListener(
    'focusin',
    (e) => {
      const path = e.composedPath();
      const composer = composerIn(path);
      if (!composer || !isSiteComposer(composer)) return reportUnknownBox(path);
      const editor = editorIn(composer);
      if (editor && path.includes(editor) && active(editor)) attach(composer, editor);
    },
    true
  );
  // Typing. Instagram's editor (Lexical) inserts the text itself and swallows the normal
  // 'input' event, so we also watch keys, paste and IME, and act only when the text changed.
  // It can also swap the box out mid-typing, so the box is found again from the event —
  // a moment after it, because Instagram's DM box only draws its Send button once there's text.
  let lastSeen = '';
  function onEdit(e) {
    const path = e.composedPath();
    setTimeout(() => {
      if (!live || !live.editor.isConnected || !path.includes(live.editor)) {
        const composer = composerIn(path);
        if (!composer || !isSiteComposer(composer)) return;
        const editor = editorIn(composer);
        if (!editor || !path.includes(editor) || !active(editor)) return;
        attach(composer, editor);
      }
      if (!live || !active()) return;
      const now = normalize(textOf(live.editor));
      if (now === lastSeen) return; // a key that didn't change the text (arrows, Shift…)
      lastSeen = now;
      hide();
      scheduleLive();
    }, 60); // after the page has redrawn (React commits within a frame)
  }
  for (const type of ['input', 'beforeinput', 'keyup', 'paste', 'cut', 'compositionend']) {
    window.addEventListener(type, onEdit, true);
  }
  window.addEventListener('scroll', placeBadge, true);
  window.addEventListener('resize', placeBadge);

  // ---------- catching the submit ----------

  function attempt(event, path, keyboard = false) {
    // The button we greyed out is always a submit, whatever it's called now.
    const onBlocked = !keyboard && blockedButton && path.includes(blockedButton);
    const button = keyboard ? null : onBlocked ? blockedButton : submitButtonIn(path);
    if (!keyboard && !button) return;
    // Safety net: a box we're already watching (or its greyed button) never sends unchecked,
    // even if the site has redrawn it so we can't find it the usual way.
    const watched = live && (path.includes(live.editor) || onBlocked) ? live.composer : null;
    const composer = composerIn(path) || watched;
    if (!composer) return;
    const editor = editorIn(composer);
    if (!editor) {
      if (!isSiteComposer(composer)) return; // some other form on the page: not ours
      event.preventDefault();
      event.stopImmediatePropagation();
      return show('danger', `<div class="title">Argus couldn't read this comment box</div><div class="reason">So it can't check the comment, and won't let it post unchecked. The site may have changed its layout — update the extension, or turn it off to post.</div><div class="buttons"><button class="close" data-act="close">Close</button></div>`);
    }
    if (!active(editor)) return; // a private message, and the writer hasn't switched those on
    const text = textOf(editor);
    if (!text) return;

    const ok = cleared.get(composer);
    if (ok && ok.text === text && Date.now() < ok.until) return; // cleared: let the site post it

    // Not cleared: the site never sees this click.
    event.preventDefault();
    event.stopImmediatePropagation();
    check(composer, button || buttonIn(composer), editor, text);
  }

  // Some sites act on mouse/pointer down rather than click: while the button is greyed out,
  // those never reach the site either. (The click itself is caught by attempt() below.)
  for (const type of ['pointerdown', 'mousedown', 'touchstart']) {
    window.addEventListener(
      type,
      (e) => {
        if (blockedButton && blockedButton.dataset.argusBlocked && e.composedPath().includes(blockedButton)) {
          e.preventDefault();
          e.stopImmediatePropagation();
        }
      },
      { capture: true, passive: false }
    );
  }
  window.addEventListener('click', (e) => attempt(e, e.composedPath()), true);
  window.addEventListener('submit', (e) => attempt(e, e.composedPath(), true), true);
  window.addEventListener(
    'keydown',
    (e) => {
      // Ctrl/Cmd+Enter everywhere; a plain Enter too on sites where Enter sends (Instagram,
      // WhatsApp). Shift+Enter is a new line; Enter while composing (IME) is not a send.
      if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
      if (e.ctrlKey || e.metaKey || CONF.enterSends) attempt(e, e.composedPath(), true);
    },
    true
  );
})();
