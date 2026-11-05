// Drop-in comment-moderator box. Plain script, no build step:
//   <link rel="stylesheet" href="moderator-widget.css"><script src="moderator-widget.js"></script>
//   AIModerator.mount(document.querySelector('#box'), { endpoint: '/api/plugin' });
// Talks to the routes from moderatorHandler() (src/service.mjs).
(function () {
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const TITLES = {
    clean: 'Looks good — ready to post',
    rude: "Not posted yet — here's another way to say it",
    rudeNoSuggestion: 'Not posted yet — try saying it another way',
    severe: "Can't be posted",
    unsure: 'A person will check this',
    unavailable: "Couldn't check right now",
    waiting: 'Waiting for a moderator',
    approved: 'Ready to post',
    upheld: 'A moderator kept this unposted',
    expired: 'Not posted',
  };

  // options.onAllowed(text): called when the comment is cleared to post (checked clean, a suggestion
  // accepted, or approved by a moderator).
  function mount(target, { endpoint = '/api/plugin', replyingTo = null, placeholder = 'Write a comment…', checkDelay = 1800, pollEvery = 5000, onAllowed = null } = {}) {
    target.classList.add('aim');
    target.innerHTML = `<label class="aim-sr-only" for="aimDraft">Comment</label>
      <textarea class="aim-draft" id="aimDraft" maxlength="2000" placeholder="${esc(placeholder)}"></textarea>
      <div class="aim-hint" role="status"></div>
      <div class="aim-actions"><button type="button" class="aim-check">Check</button></div>
      <div class="aim-result" role="status"></div>`;
    const $ = sel => target.querySelector(sel);
    const draft = $('.aim-draft'), button = $('.aim-check'), hint = $('.aim-hint'), box = $('.aim-result');
    let hintTimer, checkTimer, pollTimer, revision = 0, inFlight = false, lastChecked = '';

    async function post(action, body) {
      const response = await fetch(endpoint + '/' + action, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'The moderator is unavailable.');
      return data;
    }

    function show(result) {
      box.dataset.verdict = result.verdict;
      const title = result.verdict === 'rude' && !result.suggestion ? TITLES.rudeNoSuggestion : TITLES[result.verdict] || result.verdict;
      box.innerHTML = `<strong>${esc(title)}</strong>`
        + (result.verdict !== 'clean' ? `<p>${esc(result.reason)}</p>` : '')
        + (result.review?.status === 'flagged' ? '<p>It was also sent to a moderator automatically.</p>' : '')
        + (result.suggestion ? `<blockquote>${esc(result.suggestion)}</blockquote>` : '')
        + '<div class="aim-buttons">'
        + (result.suggestion ? '<button type="button" class="aim-accept">Use this</button>' : '')
        + (result.verdict === 'rude' || result.verdict === 'severe' ? '<button type="button" class="aim-edit aim-secondary">Edit it myself</button>' : '')
        + (result.verdict === 'rude' ? '<button type="button" class="aim-ask aim-secondary">Ask a moderator</button>' : '')
        + '</div>';
      $('.aim-accept')?.addEventListener('click', async () => {
        try {
          const r = await post('accept', { id: result.id });
          draft.value = r.text; lastChecked = r.text; revision++;
          box.dataset.verdict = 'clean'; box.innerHTML = `<strong>${esc(TITLES.clean)}</strong>`;
          onAllowed?.(r.text);
        } catch (error) { box.insertAdjacentHTML('beforeend', `<p>${esc(error.message)}</p>`); }
      });
      $('.aim-edit')?.addEventListener('click', () => { draft.focus(); draft.setSelectionRange(draft.value.length, draft.value.length); });
      $('.aim-ask')?.addEventListener('click', async () => {
        const version = revision;
        try { const s = await post('ask', { id: result.id }); if (version === revision) review(s, version); }
        catch (error) { box.insertAdjacentHTML('beforeend', `<p>${esc(error.message)}</p>`); }
      });
      if (result.allowed) onAllowed?.(draft.value.trim());
      if (result.verdict === 'unsure' && result.review?.status === 'waiting') poll(result.id, revision);
    }

    // A comment a moderator is handling: show where it stands, and keep asking until they decide.
    // Editing the draft stops this (the edited text is checked again from the top).
    function review(s, version) {
      clearTimeout(pollTimer);
      box.dataset.verdict = s.status === 'approved' ? 'clean' : s.status === 'upheld' ? 'severe' : 'unsure';
      box.innerHTML = `<strong>${esc(TITLES[s.status] || s.status)}</strong><p>${esc(s.reason)}</p>`;
      if (s.status === 'approved') { draft.value = s.text; lastChecked = s.text; revision++; onAllowed?.(s.text); }
      else if (s.status === 'waiting') poll(s.id, version);
    }
    function poll(id, version) {
      clearTimeout(pollTimer);
      pollTimer = setTimeout(async () => {
        if (version !== revision) return;
        try { const s = await post('status', { id }); if (version === revision) review(s, version); }
        catch { if (version === revision) poll(id, version); }
      }, pollEvery);
    }

    async function check() {
      clearTimeout(checkTimer);
      const text = draft.value.trim(), version = revision;
      if (!text || text === lastChecked) return;
      if (inFlight) { checkTimer = setTimeout(check, 1200); return; }
      inFlight = true; button.disabled = true; button.textContent = 'Checking…';
      try {
        const result = await post('check', { text, replyingTo });
        lastChecked = text;
        if (version === revision) show(result);
      } catch (error) {
        if (version === revision) show({ verdict: 'unavailable', reason: error.message, allowed: false });
      } finally {
        inFlight = false; button.disabled = false; button.textContent = 'Check';
      }
    }

    draft.addEventListener('input', () => {
      revision++; const version = revision, text = draft.value.trim();
      clearTimeout(hintTimer); clearTimeout(checkTimer); clearTimeout(pollTimer);
      box.textContent = ''; delete box.dataset.verdict;
      if (!text) { hint.textContent = ''; return; }
      // Instant local hint while typing; the real check runs after a pause.
      hintTimer = setTimeout(async () => {
        try { const r = await post('preview', { text }); if (version === revision) hint.textContent = r.message || ''; } catch { /* hint only */ }
      }, 200);
      checkTimer = setTimeout(check, checkDelay);
    });
    button.addEventListener('click', () => { lastChecked = ''; check(); });
    return { get value() { return draft.value; }, set value(text) { draft.value = text; draft.dispatchEvent(new Event('input')); }, check };
  }

  globalThis.AIModerator = { mount };
})();
