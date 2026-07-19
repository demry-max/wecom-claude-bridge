import spawn from 'cross-spawn'; // Windows 下 claude 是 .cmd，原生 spawn 会 EINVAL
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
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
// 思考深度：low/medium/high/xhigh/max，留空=CLI 默认
const CLAUDE_EFFORT = process.env.CLAUDE_EFFORT || '';

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

/**
 * 运行 claude 无头模式。onProgress 提供时走 stream-json 实时解析：
 * - 中间消息 = assistant 事件的 text 块；最终答案 = result 事件的 result 字段。
 * - 最终答案会先以 assistant 事件出现一次再以 result 出现，因此 assistant 文本
 *   先暂存，被下一条 assistant 文本顶替时才作为中间进度推送；result 到达时丢弃
 *   暂存，只把 result 作为最终返回——保证最终答案只发一次。
 */
export function runClaude(chatId, prompt, isOwner = false, extraTools = [], onProgress = null) {
  syncSkills();
  // 提示词走 stdin：--allowedTools 等可变参数选项会吞掉后置的位置参数
  const args = ['-p', '--output-format', 'stream-json', '--verbose'];
  if (sessions[chatId]) args.push('--resume', sessions[chatId]);
  const tools = [isOwner ? ALLOWED_TOOLS : NON_OWNER_TOOLS, ...extraTools]
    .filter(Boolean)
    .join(',');
  if (tools) args.push('--allowedTools', tools);
  if (CLAUDE_MODEL) args.push('--model', CLAUDE_MODEL);
  if (CLAUDE_EFFORT) args.push('--effort', CLAUDE_EFFORT);

  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_BIN, args, {
      cwd: WORKSPACE_DIR,
      env: process.env,
    });
    let stderr = '';
    let pending = ''; // 暂存的 assistant 文本（可能是中间进度，也可能是最终答案）
    let finalText = null;
    let finalErr = null;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`claude CLI 超时（${CLAUDE_TIMEOUT_MS / 1000}s）`));
    }, CLAUDE_TIMEOUT_MS);

    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      let d;
      try {
        d = JSON.parse(line);
      } catch {
        return; // 非 JSON 行（罕见）忽略
      }
      if (d.type === 'assistant') {
        const text = (d.message?.content ?? [])
          .filter((b) => b?.type === 'text')
          .map((b) => b.text)
          .join('\n')
          .trim();
        if (!text) return;
        if (pending && onProgress) {
          Promise.resolve(onProgress(pending)).catch((e) =>
            console.error('[progress]', e?.message ?? e)
          );
        }
        pending = text;
      } else if (d.type === 'result') {
        if (d.session_id) {
          sessions[chatId] = d.session_id;
          saveSessions(sessions);
        }
        if (d.is_error) {
          finalErr = new Error(String(d.result ?? 'unknown error').slice(0, 500));
        } else {
          finalText = String(d.result ?? pending ?? '');
        }
        pending = ''; // 暂存的就是最终答案，丢弃避免重复
      }
    });

    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`claude CLI 启动失败: ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (finalErr) return reject(finalErr);
      if (finalText !== null) return resolve(finalText);
      if (pending) return resolve(pending); // 异常缺失 result 时兜底
      reject(new Error(`claude CLI 失败(code ${code}): ${stderr.slice(0, 500)}`));
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}
