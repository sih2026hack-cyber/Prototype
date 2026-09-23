import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export function readEnv(file) {
  if (!file || !fs.existsSync(file)) return {};
  const values = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) values[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return values;
}
const local = readEnv(path.join(ROOT, '.env'));
export const env = { ...readEnv(process.env.ARGUS_ENV_FILE || local.ARGUS_ENV_FILE), ...local, ...process.env };
export const DATA = path.resolve(ROOT, env.ARGUS_DATA_DIR || 'data/runtime');
fs.mkdirSync(DATA, { recursive: true });
export const settings = {
  port: Number(env.PORT || 8787), source: env.INGEST_SOURCE || 'youtube',
  query: env.YOUTUBE_QUERY || 'Chennai flooding waterlogging news',
  youtubeKey: env.YOUTUBE_API_KEY, videoIds: (env.YOUTUBE_VIDEO_IDS || '').split(',').map(x => x.trim()).filter(Boolean),
  xToken: env.X_BEARER_TOKEN,
  xQuery: env.X_QUERY || '(flooding OR waterlogging OR "heavy rain") (Chennai OR "Tamil Nadu") lang:en -is:retweet',
  supabaseUrl: (env.SUPABASE_URL || '').replace(/\/$/, ''),
  supabaseKey: env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY,
  miniKey: env.MINIMAX_API_KEY, miniModel: env.MINIMAX_MODEL || 'MiniMax-Text-01',
  miniUrl: env.MINIMAX_BASE_URL || 'https://api.minimax.io/v1/text/chatcompletion_v2',
  pollSeconds: Math.max(180, Number(env.INGEST_INTERVAL_SECONDS || 300)),
  autoIngest: env.AUTO_INGEST === 'true', autoDiscovery: env.AUTO_DISCOVERY !== 'false',
  maxPosts: Math.min(500, Math.max(10, Number(env.MAX_POSTS_PER_RUN || 40))),
};
if (settings.miniUrl.endsWith('/v1')) settings.miniUrl += '/chat/completions';
if (/^https:\/\/[^/]+\/?$/.test(settings.miniUrl)) settings.miniUrl = settings.miniUrl.replace(/\/$/, '') + '/v1/text/chatcompletion_v2';
