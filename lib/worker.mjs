import { spawn } from 'node:child_process';
import readline from 'node:readline';
import path from 'node:path';
import { env, ROOT, DATA } from './config.mjs';
let child; let sequence = 0;
const pending = new Map();
export function worker(action, payload) {
  if (!child) {
    child = spawn(env.ARGUS_PYTHON || 'python', ['-u', path.join(ROOT, 'backend/live_worker.py')], {
      cwd: ROOT, windowsHide: true,
      env: { ...env, PYTHONPATH: [env.ARGUS_ML_PACKAGES, env.ARGUS_PYTHON_PACKAGES, env.ARGUS_NLP_ROOT].filter(Boolean).join(path.delimiter),
        PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8', ARGUS_RUNTIME: DATA,
        HF_HUB_DISABLE_PROGRESS_BARS: '1', HF_HUB_DISABLE_XET: '1', HF_HUB_DOWNLOAD_TIMEOUT: '60', TOKENIZERS_PARALLELISM: 'false' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stderr.on('data', () => {}); // Never expose drafts, model traces or credentials to browser logs.
    readline.createInterface({ input: child.stdout }).on('line', line => {
      try { const result = JSON.parse(line); const item = pending.get(result.id); if (!item) return;
        clearTimeout(item.timer); pending.delete(result.id);
        result.error ? item.reject(new Error(result.error)) : item.resolve(result.result);
      } catch { /* model progress is not protocol data */ }
    });
    const failed = () => { child = null; for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('NLP worker stopped. Check its runtime configuration.')); } pending.clear(); };
    child.on('error', failed); child.on('exit', failed);
  }
  return new Promise((resolve, reject) => {
    const id = ++sequence; const timer = setTimeout(() => { pending.delete(id); reject(new Error('NLP operation timed out.')); child?.kill(); }, action === 'topics' ? 1200000 : 600000);
    pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ id, action, ...payload }) + '\n');
  });
}
process.on('exit', () => child?.kill());
