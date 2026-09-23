import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA, env } from './config.mjs';
const saltFile = path.join(DATA, '.author-salt');
if (!env.ARGUS_HASH_SALT && !fs.existsSync(saltFile)) fs.writeFileSync(saltFile, crypto.randomBytes(32).toString('hex'));
const salt = env.ARGUS_HASH_SALT || fs.readFileSync(saltFile, 'utf8');
export function redact(text) {
  return String(text || '').replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[EMAIL]')
    .replace(/\b\d{4}[ -]?\d{4}[ -]?\d{4}\b/g, '[ID]')
    .replace(/(?<!\w)\+?\d[\d ()-]{8,}\d(?!\w)/g, '[PHONE]');
}
export function hashAuthor(value) { return value ? crypto.createHmac('sha256', salt).update(String(value)).digest('hex') : null; }
export function cleanPost(post) {
  return { ...post, text: redact(post.text).replace(/@[\w.]+/g, '@user'),
    location: post.location ? redact(post.location) : null,
    author_ref: hashAuthor(post.author_ref), pii_redacted: true };
}
