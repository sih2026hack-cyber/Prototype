// Drop-in writing-moderator box. Plain script, no build step:
//   <link rel="stylesheet" href="moderator-widget.css"><script src="moderator-widget.js"></script>
//   AIModerator.mount(document.querySelector('#box'), { endpoint: '/api/plugin' });
// Talks to the routes from moderatorHandler() (src/service.mjs).
(function () {
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const NAMES = { high_risk: 'High risk · threat warning', review: 'Review suggested', safe: 'Checked', unchecked: 'Local preview' };

  function mount(target, { endpoint = '/api/plugin', placeholder = 'Try a draft here. The moderator will check it as you write…', idleText = 'Drafts are sent for AI checking and saved after you pause.', previewDelay = 200, aiDelay = 1800, onAccept = null } = {}) {
    target.classList.add('aim');
    target.innerHTML = `<label class="aim-sr-only" for="aimDraft">Draft to check</label>
      <textarea class="aim-draft" id="aimDraft" maxlength="2000" placeholder="${esc(placeholder)}"></textarea>
      <div class="aim-actions"><button type="button" class="aim-check">Check with AI</button><span class="aim-status" role="status">${esc(idleText)}</span></div>
      <div class="aim-result" role="status"></div>`;
    const $ = sel => target.querySelector(sel);
    const draft = $('.aim-draft'), button = $('.aim-check'), status = $('.aim-status'), box = $('.aim-result');
    let previewTimer, aiTimer, revision = 0, inFlight = false, lastChecked = '', latest = null;

    async function post(action, body) {
      const response = await fetch(endpoint + '/' + action, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'The moderator is unavailable.');
      return data;
    }
    function show(result, preview = false) {
      box.dataset.risk = result.verdict;
      box.innerHTML = `<strong>${esc(NAMES[result.verdict] || result.verdict)}</strong><p>${esc(result.reason || '')}</p>`
        + (result.corrected_text ? `<p>Suggestion: ${esc(result.corrected_text)}</p>` : '')
        + (result.warning ? `<p>${esc(result.warning)}</p>` : '')
        + (!preview && result.note ? `<p class="aim-note">${esc(result.note)}</p>` : '')
        + (!preview && result.complete && result.corrected_text ? '<button type="button" class="aim-accept">Use suggestion</button>' : '');
      if (preview) return;
      latest = result;
      $('.aim-accept')?.addEventListener('click', async () => {
        try {
          const r = await post('accept', { id: latest.id });
          draft.value = r.text; revision++; lastChecked = r.text;
          status.textContent = `Suggestion accepted · ${r.storage}`;
          onAccept?.(r.text);
        } catch (error) { status.textContent = error.message; }
      });
    }
    async function check() {
      clearTimeout(aiTimer);
      const text = draft.value.trim(), version = revision;
      if (!text || text === lastChecked) return;
      if (inFlight) { aiTimer = setTimeout(check, 1500); return; }
      inFlight = true; button.disabled = true; status.textContent = 'Checking your draft…';
      try {
        const result = await post('check', { text }); lastChecked = text;
        if (version === revision) { show(result); status.textContent = `${result.complete ? 'AI check' : 'Local check'} saved · ${result.storage}`; }
      } catch (error) { if (version === revision) status.textContent = error.message; }
      finally {
        inFlight = false; button.disabled = false;
        if (version !== revision && draft.value.trim()) aiTimer = setTimeout(check, aiDelay);
      }
    }
    draft.addEventListener('input', () => {
      revision++; const version = revision, text = draft.value.trim();
      clearTimeout(previewTimer); clearTimeout(aiTimer);
      box.textContent = ''; status.textContent = text ? 'Checking your draft as you type…' : 'Type a draft to begin.';
      if (!text) return;
      previewTimer = setTimeout(async () => { try { const r = await post('preview', { text }); if (version === revision) show(r, true); } catch {} }, previewDelay);
      aiTimer = setTimeout(check, aiDelay);
    });
    button.addEventListener('click', () => { lastChecked = ''; check(); });
    return { get value() { return draft.value; }, set value(text) { draft.value = text; draft.dispatchEvent(new Event('input')); }, check };
  }

  globalThis.AIModerator = { mount };
})();
