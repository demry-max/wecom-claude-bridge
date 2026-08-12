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
// 空闲超时：只要 Claude 还在输出就不计时；静默超过该时长才判定卡死
const CLAUDE_IDLE_TIMEOUT_MS = Number(process.env.CLAUDE_IDLE_TIMEOUT_MS || 600_000);
// 绝对上限：无论多活跃，超过该时长也终止（兜底防失控）
// 注意：v1.3.0 起 CLAUDE_TIMEOUT_MS 的语义从「硬超时」改为「绝对上限」。
// 老配置里常见的 300000（5 分钟）会让长任务必然被杀，这里自动纠正并告警。
let CLAUDE_MAX_MS = Number(process.env.CLAUDE_TIMEOUT_MS || 3_600_000);
if (CLAUDE_MAX_MS < CLAUDE_IDLE_TIMEOUT_MS) {
  console.error(
    `[config] CLAUDE_TIMEOUT_MS=${CLAUDE_MAX_MS}ms 小于空闲超时 ${CLAUDE_IDLE_TIMEOUT_MS}ms，` +
      `这是 v1.3.0 之前的旧语义残留，长任务会被误杀；已自动提升为 ${CLAUDE_IDLE_TIMEOUT_MS * 6}ms。` +
      `请在 .env 中改为 3600000 以消除此警告。`
  );
  CLAUDE_MAX_MS = CLAUDE_IDLE_TIMEOUT_MS * 6;
}
let CLAUDE_MODEL = process.env.CLAUDE_MODEL || '';
// 思考深度：low/medium/high/xhigh/max，留空=CLI 默认
let CLAUDE_EFFORT = process.env.CLAUDE_EFFORT || '';

// 模型短名 → 全名（也允许直接写全名）
export const MODEL_ALIASES = {
  fable: 'claude-fable-5',
  opus: 'claude-opus-5',
  sonnet: 'claude-sonnet-5',
  haiku: 'claude-haiku-4-5-20251001',
};
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

export function getRuntimeConfig() {
  return { model: CLAUDE_MODEL, effort: CLAUDE_EFFORT };
}

// 只改 .env 里的这两行，其余内容与注释原样保留
function patchEnvFile(updates) {
  const envPath = path.resolve(__dirname, '..', '.env');
  try {
    if (!fs.existsSync(envPath)) return;
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const [key, val] of Object.entries(updates)) {
      const i = lines.findIndex((l) => l.startsWith(`${key}=`));
      // 保留行尾注释
      const comment = i >= 0 ? (lines[i].match(/\s+#.*$/)?.[0] ?? '') : '';
      const line = `${key}=${val}${comment}`;
      if (i >= 0) lines[i] = line;
      else lines.push(line);
    }
    fs.writeFileSync(envPath, lines.join('\n'));
  } catch (e) {
    console.error('[config] 回写 .env 失败:', e?.message ?? e);
  }
}

/**
 * 运行时切换模型/思考档。立即生效（下一次调用即用新值），并回写 .env 让重启后保持。
 * 返回 { model, effort } 或抛错（取值非法时）。
 */
export function setRuntimeConfig({ model, effort } = {}) {
  const updates = {};
  if (model !== undefined && model !== null && model !== '') {
    const resolved = MODEL_ALIASES[String(model).toLowerCase()] ?? String(model).trim();
    if (!/^[a-zA-Z0-9._-]+$/.test(resolved)) throw new Error(`模型名不合法：${model}`);
    CLAUDE_MODEL = resolved;
    updates.CLAUDE_MODEL = resolved;
  }
  if (effort !== undefined && effort !== null && effort !== '') {
    const e = String(effort).toLowerCase().trim();
    if (!EFFORT_LEVELS.includes(e)) throw new Error(`思考档不合法：${effort}（可选 ${EFFORT_LEVELS.join('/')}）`);
    CLAUDE_EFFORT = e;
    updates.CLAUDE_EFFORT = e;
  }
  if (Object.keys(updates).length) patchEnvFile(updates);
  return getRuntimeConfig();
}
// 上下文接近压缩点时提醒机器人先固化记忆的阈值（0 = 关闭）
const CONTEXT_NUDGE_TOKENS = Number(process.env.CONTEXT_NUDGE_TOKENS ?? 850_000);
const contextSize = new Map();  // chatId → 最近一轮喂入的上下文规模
const nudgePending = new Set(); // 待注入提醒的会话

export function getContextTokens(chatId) {
  return contextSize.get(chatId) ?? 0;
}
export function getNudgeThreshold() {
  return CONTEXT_NUDGE_TOKENS;
}
// 有待提醒则返回 true 并清位（取走即消费，保证只注入一次）
export function consumeMemoryNudge(chatId) {
  if (!nudgePending.has(chatId)) return false;
  nudgePending.delete(chatId);
  return true;
}

// 飞书文档/多维表格工具开关（默认开；仅 owner 生效，权限由飞书后台 scope 决定）
const FEISHU_TOOLS = process.env.FEISHU_TOOLS !== 'false';

const sessions = loadSessions(); // { [chatId]: sessionId }

// 运行中的 claude 子进程：chatId → child，供 /cancel 终止
const running = new Map();
export function isRunning(chatId) {
  return running.has(chatId);
}
export function cancelRun(chatId) {
  const child = running.get(chatId);
  if (!child) return false;
  child.__cancelled = true;
  try {
    child.kill('SIGTERM');
    setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 2000);
  } catch { /* 已退出 */ }
  running.delete(chatId);
  return true;
}

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
    `- 模型: ${CLAUDE_MODEL || '（CLI 默认）'}`,
    `- 思考深度: ${CLAUDE_EFFORT || '（CLI 默认）'}`,
    `- 上下文: ${(contextSize.get(chatId) ?? 0).toLocaleString()} tokens${CONTEXT_NUDGE_TOKENS > 0 ? ` / 固化提醒阈值 ${CONTEXT_NUDGE_TOKENS.toLocaleString()}` : ''}`,
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

// 模型对自身身份的自述不可靠（无头模式无人告知它跑在哪个模型上，它会凭训练记忆瞎猜）。
// 由桥接把真实配置写进工作区，CLAUDE.md 用 @runtime.md 引入，问到时以此为准。
function writeRuntimeInfo(chatId) {
  try {
    // 定时任务用的是 sched: 前缀的伪会话，不是真实飞书会话，不写入
    const realChat = typeof chatId === 'string' && !chatId.startsWith('sched:') ? chatId : null;
    fs.writeFileSync(
      path.join(WORKSPACE_DIR, 'runtime.md'),
      [
        '# 当前运行配置（桥接自动生成，权威来源）',
        '',
        `- 模型：${CLAUDE_MODEL || '（未指定，走 claude CLI 默认）'}`,
        `- 思考深度 effort：${CLAUDE_EFFORT || '（未指定，走 CLI 默认）'}`,
        `- 当前会话 chat_id：${realChat ?? '（本次为定时任务，无会话）'}`,
        '',
        '用户问「你用什么模型/什么档位」时，**以本文件为准**，不要凭自身记忆推测。',
        '创建定时任务时，`chat_id` 直接用上面这个值。',
      ].join('\n') + '\n'
    );
  } catch (e) {
    console.error('[runtime-info]', e?.message ?? e);
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
  writeRuntimeInfo(chatId);
  // 提示词走 stdin：--allowedTools 等可变参数选项会吞掉后置的位置参数
  const args = ['-p', '--output-format', 'stream-json', '--verbose'];
  if (sessions[chatId]) args.push('--resume', sessions[chatId]);
  const tools = [
    isOwner ? ALLOWED_TOOLS : NON_OWNER_TOOLS,
    ...extraTools,
    isOwner && FEISHU_TOOLS ? 'mcp__feishu' : '',
  ]
    .filter(Boolean)
    .join(',');
  if (tools) args.push('--allowedTools', tools);
  if (CLAUDE_MODEL) args.push('--model', CLAUDE_MODEL);
  if (CLAUDE_EFFORT) args.push('--effort', CLAUDE_EFFORT);
  // 飞书文档/多维表格工具：只用应用自己的租户凭据，且仅 owner 可用
  if (isOwner && FEISHU_TOOLS) {
    args.push('--mcp-config', JSON.stringify({
      mcpServers: {
        feishu: {
          type: 'stdio',
          command: process.execPath,
          args: [path.join(__dirname, 'mcp-feishu.js')],
          env: {
            FEISHU_APP_ID: process.env.FEISHU_APP_ID ?? '',
            FEISHU_APP_SECRET: process.env.FEISHU_APP_SECRET ?? '',
            FEISHU_DOMAIN: process.env.FEISHU_DOMAIN ?? '',
          },
        },
      },
    }));
  }

  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_BIN, args, {
      cwd: WORKSPACE_DIR,
      env: process.env,
    });
    running.set(chatId, child);
    let stderr = '';
    let pending = ''; // 暂存的 assistant 文本（可能是中间进度，也可能是最终答案）
    let finalText = null;
    let finalErr = null;
    let timedOut = null;
    let lastActivity = Date.now();
    const startedAt = Date.now();
    // 活动式超时：有输出就续命，静默过久或总时长超上限才终止
    const timer = setInterval(() => {
      const idle = Date.now() - lastActivity;
      const total = Date.now() - startedAt;
      if (idle > CLAUDE_IDLE_TIMEOUT_MS) timedOut = `静默 ${Math.round(idle / 60000)} 分钟无输出`;
      else if (total > CLAUDE_MAX_MS) timedOut = `总时长超过 ${Math.round(CLAUDE_MAX_MS / 60000)} 分钟上限`;
      if (timedOut) {
        clearInterval(timer);
        try { child.kill('SIGKILL'); } catch {}
      }
    }, 15_000);

    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      lastActivity = Date.now(); // 有输出即续命
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
        // 记录本轮喂入的上下文规模；接近压缩点则置位，下一轮提醒固化记忆
        const u = d.usage ?? {};
        const ctx =
          (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        if (ctx > 0) {
          contextSize.set(chatId, ctx);
          if (CONTEXT_NUDGE_TOKENS > 0 && ctx >= CONTEXT_NUDGE_TOKENS) {
            nudgePending.add(chatId);
            console.log(`[context] ${chatId} 上下文 ${ctx.toLocaleString()} ≥ 阈值，下一轮将提醒固化记忆`);
          }
        }
        if (d.is_error) {
          finalErr = new Error(String(d.result ?? 'unknown error').slice(0, 500));
        } else {
          finalText = String(d.result ?? pending ?? '');
        }
        pending = ''; // 暂存的就是最终答案，丢弃避免重复
      }
    });

    child.stderr.on('data', (d) => { stderr += d; lastActivity = Date.now(); });
    child.on('error', (e) => {
      clearInterval(timer);
      running.delete(chatId);
      reject(new Error(`claude CLI 启动失败: ${e.message}`));
    });
    child.on('close', (code) => {
      clearInterval(timer);
      running.delete(chatId);
      if (child.__cancelled) {
        const err = new Error('CANCELLED');
        err.cancelled = true;
        return reject(err);
      }
      if (timedOut) return reject(new Error(`claude CLI 超时（${timedOut}）`));
      if (finalErr) return reject(finalErr);
      if (finalText !== null) return resolve(finalText);
      if (pending) return resolve(pending); // 异常缺失 result 时兜底
      reject(new Error(`claude CLI 失败(code ${code}): ${stderr.slice(0, 500)}`));
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}
