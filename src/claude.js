import spawn from 'cross-spawn'; // Windows 下 claude 是 .cmd，原生 spawn 会 EINVAL
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSessions, saveSessions } from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
export const WORKSPACE_DIR =
  process.env.WORKSPACE_DIR || path.resolve(__dirname, '..', 'workspace');
const ALLOWED_TOOLS =
  process.env.ALLOWED_TOOLS ?? 'Read,Grep,Glob,WebSearch,WebFetch';
// 非 owner（同事/群成员）不给本机文件工具，只允许联网检索
const NON_OWNER_TOOLS = process.env.NON_OWNER_TOOLS ?? 'WebSearch,WebFetch';
const CLAUDE_TIMEOUT_MS = Number(process.env.CLAUDE_TIMEOUT_MS || 300_000);
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || '';

const sessions = loadSessions(); // { [chatId]: sessionId }

export function resetSession(chatId) {
  delete sessions[chatId];
  saveSessions(sessions);
}

export function sessionInfo(chatId, isOwner = false) {
  const sid = sessions[chatId];
  const tools = isOwner ? ALLOWED_TOOLS : NON_OWNER_TOOLS;
  return [
    `**会话状态**`,
    `- Claude session: ${sid ? `\`${sid}\`` : '（无，下一条消息将新建）'}`,
    `- 工作目录: \`${WORKSPACE_DIR}\``,
    `- 你的身份: ${isOwner ? 'owner' : '普通成员'}`,
    `- 允许工具: ${tools || '（无）'}`,
  ].join('\n');
}

// Claude 被禁止自写 .claude 目录，agent 沉淀的技能先落 workspace/skills，
// 每次调用前由桥接同步到 .claude/skills 供 CLI 自动加载
function syncSkills() {
  const src = path.join(WORKSPACE_DIR, 'skills');
  const dest = path.join(WORKSPACE_DIR, '.claude', 'skills');
  try {
    if (fs.existsSync(src)) fs.cpSync(src, dest, { recursive: true });
  } catch (e) {
    console.error('[skills-sync]', e?.message ?? e);
  }
}

export function runClaude(chatId, prompt, isOwner = false, extraTools = []) {
  syncSkills();
  // 提示词走 stdin：--allowedTools 等可变参数选项会吞掉后置的位置参数
  const args = ['-p', '--output-format', 'json'];
  if (sessions[chatId]) args.push('--resume', sessions[chatId]);
  const tools = [isOwner ? ALLOWED_TOOLS : NON_OWNER_TOOLS, ...extraTools]
    .filter(Boolean)
    .join(',');
  if (tools) args.push('--allowedTools', tools);
  if (CLAUDE_MODEL) args.push('--model', CLAUDE_MODEL);

  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_BIN, args, {
      cwd: WORKSPACE_DIR,
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`claude CLI 超时（${CLAUDE_TIMEOUT_MS / 1000}s）`));
    }, CLAUDE_TIMEOUT_MS);

    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`claude CLI 启动失败: ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && !stdout) {
        return reject(
          new Error(`claude CLI 失败(code ${code}): ${stderr.slice(0, 500)}`)
        );
      }
      try {
        const out = JSON.parse(stdout);
        if (out.session_id) {
          sessions[chatId] = out.session_id;
          saveSessions(sessions);
        }
        if (out.is_error) {
          return reject(new Error(String(out.result ?? 'unknown error').slice(0, 500)));
        }
        resolve(out.result ?? '');
      } catch {
        // 非 JSON 输出时原样返回
        resolve(String(stdout).trim());
      }
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}
