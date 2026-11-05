// Toolbar panel: check a file on the ARGUS Lens page, open settings, flip automatic image checks,
// and show whether the ARGUS server is reachable.
const $ = id => document.getElementById(id);
chrome.storage.sync.get(['server', 'apiBase', 'auto']).then(async ({ server, apiBase, auto }) => {
  const base = (server || apiBase || 'http://localhost:8787').replace(/\/$/, '');
  $('auto').checked = auto === true;
  $('file').onclick = () => { chrome.tabs.create({ url: base + '/lens' }); window.close(); };
  try {
    const res = await fetch(base + '/api/ext/status?id=ping');
    $('server').textContent = res.ok ? `Connected to ${base}` : `ARGUS at ${base} answered HTTP ${res.status}. Check the address or extension key in Settings.`;
    if (!res.ok) $('server').className = 'bad';
  } catch {
    $('server').textContent = `Can't reach ARGUS at ${base}. Is it running?`;
    $('server').className = 'bad';
  }
});
$('settings').onclick = () => { chrome.runtime.openOptionsPage(); window.close(); };
$('auto').onchange = () => chrome.storage.sync.set({ auto: $('auto').checked });
