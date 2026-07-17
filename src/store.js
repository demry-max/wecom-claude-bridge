import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const OWNER_FILE = path.join(DATA_DIR, 'owner.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function loadOwner() {
  return readJson(OWNER_FILE, {}).open_id ?? null;
}

export function saveOwner(openId) {
  fs.writeFileSync(OWNER_FILE, JSON.stringify({ open_id: openId }, null, 2));
}

export function loadSessions() {
  return readJson(SESSIONS_FILE, {});
}

export function saveSessions(sessions) {
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
}
