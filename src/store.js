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

/**
 * 原子写 + 永不抛出。
 * 这些写调用发生在事件回调里（如 readline 的 'line'），一旦抛出就是 uncaughtException，
 * 整个桥接进程当场死亡、正在跑的答案一并丢失——而外置盘瞬断、TCC 授权失效、盘满
 * 在本项目都是有前科的常规故障。状态写失败远没有进程死掉严重，记日志降级即可。
 */
function writeJsonSafe(file, data) {
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
    return true;
  } catch (e) {
    console.error(`[store] 写入 ${path.basename(file)} 失败:`, e?.message ?? e);
    try { fs.rmSync(tmp, { force: true }); } catch {}
    return false;
  }
}

export function loadOwner() {
  // owner.json 内容为 "null" 时 readJson 会返回 null，直接取属性会抛——
  // 而它在每条消息路径上被调用，抛一次就是整个进程死一次
  const d = readJson(OWNER_FILE, {});
  return (d && typeof d === 'object' ? d.open_id : null) ?? null;
}

export function saveOwner(openId) {
  return writeJsonSafe(OWNER_FILE, { open_id: openId });
}

export function loadSessions() {
  return readJson(SESSIONS_FILE, {});
}

export function saveSessions(sessions) {
  return writeJsonSafe(SESSIONS_FILE, sessions);
}
