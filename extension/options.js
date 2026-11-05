const $ = id => document.getElementById(id);
const flash = (id, text) => { $(id).textContent = text; setTimeout(() => ($(id).textContent = ''), 1500); };
chrome.storage.sync.get(['server', 'apiBase', 'apiKey', 'messages', 'whatsapp', 'auto', 'limit']).then(s => {
  $('server').value = s.server || s.apiBase || 'http://localhost:8787';
  $('apiKey').value = s.apiKey || '';
  $('messages').checked = s.messages === true || s.whatsapp === true; // "whatsapp" = the older name
  $('auto').checked = s.auto === true;
  $('limit').value = s.limit || 10;
});
$('save').addEventListener('click', async () => {
  const limit = Math.min(60, Math.max(1, Math.round(Number($('limit').value) || 10)));
  await chrome.storage.sync.set({
    server: $('server').value.trim(), apiKey: $('apiKey').value.trim(),
    messages: $('messages').checked, whatsapp: $('messages').checked,
    auto: $('auto').checked, limit,
  });
  $('limit').value = limit;
  flash('saved', 'Saved');
});
$('clear').addEventListener('click', async () => {
  await chrome.storage.local.remove('harshLog');
  flash('cleared', 'Cleared');
});
