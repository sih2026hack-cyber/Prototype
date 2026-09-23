import fs from 'node:fs';
import path from 'node:path';
import { DATA, settings, env } from './config.mjs';
import { requestJson } from './providers.mjs';
export const readLocal = (name, fallback) => { try { return JSON.parse(fs.readFileSync(path.join(DATA, name + '.json'), 'utf8')); } catch { return fallback; } };
export function saveLocal(name, value) {
  const file = path.join(DATA, name + '.json'); fs.writeFileSync(file + '.tmp', JSON.stringify(value)); fs.renameSync(file + '.tmp', file);
  if (stateSync()) queueState(name);
}
// Render's free plan has no persistent disk: mirror runtime state to Supabase table argus_state
// (supabase/argus-state.sql) and restore it on boot. On by default when deployed; ARGUS_STATE_SYNC=true/false overrides.
const stateSync = () => dbConfigured() && (env.ARGUS_STATE_SYNC ? env.ARGUS_STATE_SYNC === 'true' : Boolean(env.RENDER));
const queued = new Map();
function queueState(name) {
  clearTimeout(queued.get(name));
  queued.set(name, setTimeout(async () => {
    queued.delete(name);
    try { const value = JSON.parse(fs.readFileSync(path.join(DATA, name + '.json'), 'utf8')); await upsert('argus_state', [{ key: name, value, updated_at: new Date().toISOString() }], 'key'); }
    catch (error) { console.error(`State sync failed for ${name}: ${error.message}`); }
  }, 1500));
}
export async function restoreState() {
  if (!stateSync()) return 0;
  try {
    let restored = 0;
    for (let offset = 0; ; offset += 20) {
      const rows = await readRows('argus_state', `select=key,value&order=key&limit=20&offset=${offset}`);
      for (const row of rows) if (/^[\w.-]+$/.test(row.key)) { fs.writeFileSync(path.join(DATA, row.key + '.json'), JSON.stringify(row.value)); restored++; }
      if (rows.length < 20) return restored;
    }
  } catch (error) { console.error(`State restore skipped: ${error.message}. Run supabase/argus-state.sql once.`); return 0; }
}
export async function flushState() { for (const name of [...queued.keys()]) { clearTimeout(queued.get(name)); queued.delete(name); } }
export function dbConfigured() { return Boolean(settings.supabaseUrl && settings.supabaseKey); }
function headers() { return { apikey: settings.supabaseKey, Authorization: `Bearer ${settings.supabaseKey}`, 'Content-Type': 'application/json' }; }
export async function readRows(table, query = '') {
  if (!dbConfigured()) throw new Error('Supabase credentials are missing.');
  return requestJson(`${settings.supabaseUrl}/rest/v1/${table}?${query}`, { headers: headers() }, `Supabase ${table}`);
}
export async function upsert(table, rows, conflict) {
  if (!rows.length) return 0;
  if (!dbConfigured()) throw new Error('Supabase credentials are missing. Data is stored locally only.');
  for (let i = 0; i < rows.length; i += 50) {
    await requestJson(`${settings.supabaseUrl}/rest/v1/${table}?on_conflict=${conflict}`, {
      method: 'POST', headers: { ...headers(), Prefer: 'resolution=merge-duplicates,return=representation' }, body: JSON.stringify(rows.slice(i, i + 50)),
    }, `Supabase ${table}`);
  }
  return rows.length;
}
export async function persistCorpus(posts) {
  posts = posts.filter(p => !p.is_seed && p.source !== 'seed' && !p.id.startsWith('seed'));
  const rows = posts.filter(p => p.nlp_row).map(p => p.nlp_row);
  const status = { nlp_written: 0, metadata_written: 0, errors: [] };
  try { status.nlp_written = await upsert('posts_nlp', rows, 'post_id'); } catch (error) { status.errors.push(error.message); }
  const metadata = posts.map(p => ({ post_id: p.id, source: p.source, source_url: p.source_url, created_at: p.created_at,
    metadata: { content_kind:p.content_kind||'comment',title:p.title,description:p.description,tags:p.tags,duration:p.duration,video_id:p.video_id,lang: p.lang, location: p.location, metrics: p.metrics, parent_id: p.parent_id, context_title: p.context_title, fetched_at: p.fetched_at },
    topic: p.topic || null, topic_source: p.topic_source || 'pending', embedding: p.embedding || null, embedding_model: p.embedding_source || null,
    analysis: { sentiment: p.sentiment, entities: p.entities, entity_source: p.entity_source, event_polarity: p.event_polarity, nuance:p.nuance,topic_id:p.topic_id,topic_probability:p.topic_probability,topic_summary:p.topic_summary,source_group:p.source_group,channel_id:p.channel_id,embedding_text_hash:p.embedding_text_hash },
  }));
  try { status.metadata_written = await upsert('argus_post_details', metadata, 'post_id'); } catch (error) { status.errors.push(error.message); }
  return status;
}
