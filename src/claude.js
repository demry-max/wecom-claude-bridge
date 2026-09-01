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

// 访客工作区：非 owner 一律在此运行。
// owner 的 workspace/CLAUDE.md 用 @memory/USER.md、@memory/MEMORY.md 把画像与记忆索引
// 注入每一次上下文——若同事/群成员共用同一个 cwd，光靠 --allowedTools 挡工具是不够的，
// 私有记忆已经在模型手里了。隔离 cwd 才是真边界。
export const GUEST_WORKSPACE_DIR =
  process.env.GUEST_WORKSPACE_DIR || path.resolve(__dirname, '..', 'workspace-guest');

export function workspaceFor(isOwner) {
  return isOwner ? WORKSPACE_DIR : GUEST_WORKSPACE_DIR;
}

// chatId 可能含 : . 等字符（如 sched:weekly-review.json）。
// 必须保留区分度：早先把 '.' 也折叠成 '_'，导致 a.json 与 a_json 撞进同一个 outbox 目录。
const safeKey = (chatId) => {
  const raw = String(chatId);
  const cleaned = raw.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 60);
  // 追加短哈希，杜绝不同 chatId 折叠后碰撞
  let h = 0;
  for (let i = 0; i < raw.length; i++) h = (h * 31 + raw.charCodeAt(i)) >>> 0;
  return `${cleaned}-${h.toString(36)}`;
};

// 定时任务/自诊断用的伪会话：一次性上下文，不 resume 也不持久化
export const isEphemeral = (chatId) => typeof chatId === 'string' && chatId.startsWith('sched');

/**
 * 本轮专属的文件回传目录。共享一个 outbox 会导致跨会话错发：
 * 定时任务写的文件会被下一条任意消息顺手发走。
 */
export function outboxDirFor(chatId, isOwner = true) {
  return path.join(workspaceFor(isOwner), 'outbox', safeKey(chatId));
}

const GUEST_CLAUDE_MD = `# 访客助手工作区

你是通过企业微信对话的 AI 助手，正在回应**非 owner 的同事或群成员**。

## 边界

- 你只有联网检索能力（WebSearch），没有本机文件、记忆、技能、定时任务的访问权。
- 你**不掌握**机器人主人的任何个人信息、公司内部资料或历史对话。被问到这类问题时，
  如实说明你在访客模式下没有这些信息，请对方直接找本人，不要猜测或编造。
- 不要声称自己能记住本次对话之外的事——访客会话不写入长期记忆。

## 行为约定

- 回答简洁直接，中文优先。
- 回复经企业微信 markdown 卡片展示，可用代码块、表格、加粗。
`;

// 首次运行自动建好访客工作区（幂等：CLAUDE.md 已存在则不覆盖，允许自定义）
function ensureGuestWorkspace() {
  try {
    fs.mkdirSync(path.join(GUEST_WORKSPACE_DIR, 'incoming'), { recursive: true });
    fs.mkdirSync(path.join(GUEST_WORKSPACE_DIR, 'outbox'), { recursive: true });
    const md = path.join(GUEST_WORKSPACE_DIR, 'CLAUDE.md');
    if (!fs.existsSync(md)) fs.writeFileSync(md, GUEST_CLAUDE_MD);
  } catch (e) {
    console.error('[guest-workspace]', e?.message ?? e);
  }
}
ensureGuestWorkspace();
const ALLOWED_TOOLS =
  process.env.ALLOWED_TOOLS ?? 'Read,Grep,Glob,WebSearch,WebFetch';
// 非 owner（同事/群成员）不给本机文件工具，只允许联网检索
const NON_OWNER_TOOLS = process.env.NON_OWNER_TOOLS ?? 'WebSearch';
// 访客可用的内置工具**白名单**（--tools）。
//
// 必须是白名单而不是黑名单：--disallowedTools 只能挡住你想到的工具名，
// 任何没列进去的内置工具照样可用。实测黑名单方案下访客手里仍有 22 个工具，
// 包括 SendMessage / Artifact / CronCreate / Workflow / ListAgents —— 而且它们
// 跑在 owner 的 Claude 账号身份下，等于访客能以 owner 身份发布网页、建定时任务、
// 甚至把消息注入 owner 正在跑的高权限会话。换成白名单后工具数从 22 降到 2。
// 白名单还天然面向未来：CLI 以后新增的内置工具不会自动对访客开放。
// 默认不含 WebFetch：它对目标地址不做限制，访客可借它探测本机与内网
// （实测 http://127.0.0.1:3000 会真的发起连接，错误信息即泄露端口可达性），
// 也可把数据编码进 URL 外传。需要访客能读网页时用 GUEST_TOOLS 显式打开。
const GUEST_TOOLS = process.env.GUEST_TOOLS ?? 'WebSearch';
// 无论 env 怎么配，这些工具对访客永远不可用（env 只能在白名单里加别的，不能解开这些）
const GUEST_HARD_DENY = [
  'Bash', 'BashOutput', 'KillShell', 'Edit', 'Write', 'NotebookEdit', 'Task', 'Agent', 'Skill',
  'SendMessage', 'Artifact', 'CronCreate', 'CronDelete', 'CronList', 'Workflow', 'ListAgents',
  'RemoteTrigger', 'PushNotification', 'ScheduleWakeup', 'TaskCreate', 'TaskUpdate',
  'DesignSync', 'EnterWorktree', 'ExitWorktree', 'Monitor',
];
// 黑名单保留作双保险（万一将来白名单被放宽，这些依然被显式拒绝）
const GUEST_DENIED_TOOLS =
  process.env.GUEST_DENIED_TOOLS ??
  'Bash,BashOutput,KillShell,Edit,Write,NotebookEdit,Task,Agent,Skill,SendMessage,Artifact,CronCreate,CronDelete,CronList,Workflow,ListAgents,RemoteTrigger,PushNotification,ScheduleWakeup,TaskCreate,TaskUpdate,DesignSync,EnterWorktree,ExitWorktree,Monitor';
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
// 注意：fable 默认指向 5.1，需要 Claude Code CLI ≥ 2.1.251；
// 旧版 CLI 会报 does not support this model，跑 `claude update` 升级，
// 或用 `fable5` 指回上一代。
export const MODEL_ALIASES = {
  fable: 'claude-fable-5-1',
  'fable5': 'claude-fable-5',
  'fable5.1': 'claude-fable-5-1',
  opus: 'claude-opus-5',
  sonnet: 'claude-sonnet-5',
  haiku: 'claude-haiku-4-5-20251001',
};
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

// 别名解析与校验：非法值回落到全局配置并告警，不把垃圾直接传给 CLI
export function normalizeModel(v) {
  if (v === undefined || v === null || v === '') return null;
  const resolved = MODEL_ALIASES[String(v).toLowerCase()] ?? String(v).trim();
  if (!/^[a-zA-Z0-9._-]+$/.test(resolved)) {
    console.error(`[config] 忽略非法模型名「${v}」，回落到全局配置`);
    return null;
  }
  return resolved;
}
export function normalizeEffort(v) {
  if (v === undefined || v === null || v === '') return null;
  const e = String(v).toLowerCase().trim();
  if (!EFFORT_LEVELS.includes(e)) {
    console.error(`[config] 忽略非法思考档「${v}」，回落到全局配置`);
    return null;
  }
  return e;
}

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
    // 原子替换：.env 是启动必需文件，写到一半被打断（掉电/拔盘）会截断成半截，
    // 下次启动即 exit(1)，launchd 会陷入每 10 秒拉起-退出的死循环
    const tmp = `${envPath}.tmp`;
    fs.writeFileSync(tmp, lines.join('\n'));
    fs.renameSync(tmp, envPath);
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
  nudgeInFlight.add(chatId); // 只是「已注入」；真正跑成功后才允许回收会话
  return true;
}

// 注入了固化提醒、但还不知道那一轮成没成功
const nudgeInFlight = new Set();

// 记忆已固化、可以安全重开会话的标记
const memoryFlushed = new Set();

/**
 * 固化提醒已被执行过的会话，下一轮开始前重开——
 * 该留的已经落盘到 memory/，继续背着上百万 token 的历史只是在重复付钱。
 * 取走即消费，避免反复重置。
 */
export function shouldRecycleSession(chatId) {
  if (!memoryFlushed.has(chatId)) return false;
  memoryFlushed.delete(chatId);
  const ctx = contextSize.get(chatId) ?? 0;
  return ctx >= CONTEXT_NUDGE_TOKENS; // 仍然很大才回收；已经小了就不折腾
}

function noteContext(chatId, ctx) {
  contextSize.set(chatId, ctx);
  if (CONTEXT_NUDGE_TOKENS > 0 && ctx >= CONTEXT_NUDGE_TOKENS && !nudgePending.has(chatId)) {
    nudgePending.add(chatId);
    console.log(`[context] ${chatId} 上下文 ${ctx.toLocaleString()} ≥ 阈值，下一轮将提醒固化记忆`);
  }
}

// /new 的代际计数：任务运行期间被重置时，本轮的 session_id 不得回写
const resetGeneration = new Map();

const sessions = loadSessions(); // { [chatId]: sessionId }

// 运行中的 claude 子进程：chatId → child，供 /cancel 终止
const running = new Map();
export function isRunning(chatId) {
  return running.has(chatId) || retryWaiters.has(chatId);
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

// 群里 owner 需要清扫「该群下所有访客」的会话/运行，键里带 open_id 故按前缀枚举
export function sessionKeysWithPrefix(prefix) {
  return Object.keys(sessions).filter((k) => k.startsWith(prefix));
}
export function runningKeysWithPrefix(prefix) {
  return [...running.keys()].filter((k) => k.startsWith(prefix));
}

export function resetSession(chatId) {
  delete sessions[chatId];
  saveSessions(sessions);
  // 代际 +1：正在跑的那一轮结束时不得把旧 session 写回来（否则 /new 被静默撤销）
  resetGeneration.set(chatId, (resetGeneration.get(chatId) ?? 0) + 1);
  contextSize.delete(chatId);
  nudgePending.delete(chatId);
  memoryFlushed.delete(chatId);
}

export function sessionInfo(chatId, isOwner = false) {
  const sid = sessions[chatId];
  const tools = isOwner ? ALLOWED_TOOLS : NON_OWNER_TOOLS;
  return [
    `**会话状态**`,
    `- Claude session: ${sid ? `\`${sid}\`` : '（无，下一条消息将新建）'}`,
    `- 工作目录: \`${workspaceFor(isOwner)}\``,
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
// 运行配置改为随每次调用注入系统提示词，而不是写共享的 runtime.md：
// 定时任务与聊天是并发的两个 claude 进程、共享同一工作区，写文件必然互相覆盖，
// 模型会读到别人的 chat_id（进而把排期发错会话）。逐次注入天然无竞态。
function runtimeSystemPrompt(chatId, model, effort, isOwner) {
  // 访客只需要知道自己跑在什么模型上；outbox、定时任务、chat_id 都是 owner 侧的概念，
  // 讲给访客听既没用又会诱导它去尝试没有的能力
  if (!isOwner) {
    return [
      '# 当前运行配置（由桥接注入，权威来源）',
      `- 模型：${model || '（未指定，走 claude CLI 默认）'}`,
      `- 思考深度 effort：${effort || '（未指定，走 CLI 默认）'}`,
      '',
      '被问到「你用什么模型/什么思考档位」时**以上面为准**，不要凭自身记忆推测。',
    ].join('\n');
  }
  const realChat = typeof chatId === 'string' && !chatId.startsWith('sched') ? chatId : null;
  const outboxRel = `./outbox/${safeKey(chatId)}/`;
  return [
    '# 当前运行配置（由桥接注入，权威来源）',
    `- 模型：${model || '（未指定，走 claude CLI 默认）'}`,
    `- 思考深度 effort：${effort || '（未指定，走 CLI 默认）'}`,
    `- 当前会话 chat_id：${realChat ?? '（本次为定时任务，无对应会话）'}`,
    `- 本轮文件回传目录：\`${outboxRel}\`（要发给用户的图片/文件写到**这个目录**，`,
    '  本轮结束后桥接会自动上传并清空；写到别处或 outbox 根目录都不会被发送）',
    '',
    '被问到「你用什么模型/什么思考档位」时**以上面为准**，不要凭自身记忆推测——',
    '无头模式下你无法从自身推断真实模型，猜测必然出错。',
    realChat
      ? '创建定时任务时，`chat_id` 直接用上面这个值，不要编造。'
      : '本次是定时任务，没有可用的 chat_id；不要创建需要 chat_id 的新任务。',
  ].join('\n');
}

/**
 * 运行 claude 无头模式。onProgress 提供时走 stream-json 实时解析：
 * - 中间消息 = assistant 事件的 text 块；最终答案 = result 事件的 result 字段。
 * - 最终答案会先以 assistant 事件出现一次再以 result 出现，因此 assistant 文本
 *   先暂存，被下一条 assistant 文本顶替时才作为中间进度推送；result 到达时丢弃
 *   暂存，只把 result 作为最终返回——保证最终答案只发一次。
 */
/**
 * 构造 claude CLI 的调用参数与工作目录。
 * 独立成纯函数是为了可测试——隔离是否真的生效，必须能对实际 args/cwd 下断言，
 * 而不是对源码文本做正则匹配（那种测试在隔离被整体改回去时依然全绿）。
 */
export function buildClaudeArgs(chatId, isOwner = false, extraTools = [], opts = {}) {
  const cwd = workspaceFor(isOwner);
  // 任务里写的 "haiku" 这类别名要和 /model、set-model 走同一套解析与校验，
  // 否则同一个词在三条路径上行为不一致（一处生效、一处原样传给 CLI 报错）
  const model = normalizeModel(opts.model) ?? CLAUDE_MODEL;
  const effort = normalizeEffort(opts.effort) ?? CLAUDE_EFFORT;
  const resumeId = opts.resumeId ?? sessions[chatId];
  // 提示词走 stdin：--allowedTools 等可变参数选项会吞掉后置的位置参数
  const args = ['-p', '--output-format', 'stream-json', '--verbose'];
  // 定时任务每次都该是全新上下文：只堵写不堵读的话，历史遗留的 sched 会话
  // 仍会被 --resume 一路续下去（周报因此几周累积在同一条会话里）
  if (resumeId && !isEphemeral(chatId)) args.push('--resume', resumeId);
  const tools = [
    isOwner ? ALLOWED_TOOLS : NON_OWNER_TOOLS,
    ...extraTools,
  ]
    .filter(Boolean)
    .join(',');
  if (tools) args.push('--allowedTools', tools);
  if (!isOwner) {
    // 关键：--allowedTools 不是沙箱，它只是「免询问」白名单，是加法项。
    // 用户级 ~/.claude/settings.json 里的 permissions.allow（本机含 Bash(lark-cli *)）
    // 对访客会话同样生效——实测访客能直接跑 lark-cli，而它以 owner 本人的飞书身份
    // 读写 IM/邮件/云文档/审批。要真正收权只能切断配置来源并显式禁用工具：
    //   --setting-sources project  只读项目级配置，屏蔽用户级 allow 规则
    //   --strict-mcp-config        不加载用户级 MCP（Drive/Gmail/QuickBooks 等）
    //   --disallowedTools          显式拉黑，减法项，优先级高于任何 allow
    // 不加载任何 settings 文件：user 级的 permissions.allow 是这次 CRITICAL 的根源，
    // project 级同样可能被提交进仓库（谁都能加一条 allow 规则）
    args.push('--setting-sources', '');
    args.push('--strict-mcp-config');
    // 白名单：只有这些内置工具存在于访客的工具集里。
    // 访客发了图片/文件时才追加 Read，且路径由 allowedTools 的 Read(./incoming/**) 限定。
    const needsRead = extraTools.some((e) => e.startsWith('Read('));
    // 硬下限压过 env：GUEST_TOOLS 配错或被人放宽也解不开这些
    const allowTools = GUEST_TOOLS.split(',')
      .map((s) => s.trim())
      .filter((x) => x && !GUEST_HARD_DENY.includes(x));
    if (needsRead && !allowTools.includes('Read')) allowTools.push('Read');
    args.push('--tools', allowTools.join(','));
    // 双保险：白名单之外再显式拒绝一遍高危工具（硬下限并入，去重）
    const denied = [...new Set([
      ...GUEST_HARD_DENY,
      ...GUEST_DENIED_TOOLS.split(',').map((s) => s.trim()).filter(Boolean),
    ])].filter((x) => !(x === 'Read' && needsRead));
    args.push('--disallowedTools', denied.join(','));
    // 自动记忆按 git 仓库根归档，workspace 与 workspace-guest 同属一个仓库，
    // 不关就是与 owner 共用一份（读方向泄漏、写方向是持久化提示注入）。
    // 键名是 autoMemoryEnabled——写错的键在 -p 模式下会被静默忽略，等于没设。
    args.push('--settings', JSON.stringify({ autoMemoryEnabled: false }));
  }
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  args.push('--append-system-prompt', runtimeSystemPrompt(chatId, model, effort, isOwner));
  return { args, cwd, model, effort };
}

function runClaudeOnce(chatId, prompt, isOwner = false, extraTools = [], onProgress = null, opts = {}) {
  if (isOwner) syncSkills(); // 访客工作区没有技能目录，也不该有
  const { args, cwd, effort } = buildClaudeArgs(chatId, isOwner, extraTools, opts);
  const ephemeralChat = isEphemeral(chatId);
  // 本轮专属回传目录必须先存在，否则模型写入时会失败
  try {
    fs.mkdirSync(outboxDirFor(chatId, isOwner), { recursive: true });
  } catch (e) {
    console.error('[outbox-dir]', e?.message ?? e);
  }

  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_BIN, args, {
      cwd,
      env: process.env,
    });
    running.set(chatId, child);
    const startedGeneration = resetGeneration.get(chatId) ?? 0; // /new 撤销检测用
    let stderr = '';
    let pending = ''; // 暂存的 assistant 文本（可能是中间进度，也可能是最终答案）
    let finalText = null;
    let finalErr = null;
    let timedOut = null;
    let producedOutput = false; // 是否已产生过输出/副作用——决定断连后能否安全重放
    let lastActivity = Date.now();
    const startedAt = Date.now();
    // 深度推理档静默期天然更长，空闲阈值相应放宽，避免把「在想」误判成「卡死」
    const idleLimit = /^(xhigh|max)$/.test(effort ?? '')
      ? CLAUDE_IDLE_TIMEOUT_MS * 3
      : CLAUDE_IDLE_TIMEOUT_MS;
    // 活动式超时：有输出就续命，静默过久或总时长超上限才终止
    const timer = setInterval(() => {
      const idle = Date.now() - lastActivity;
      const total = Date.now() - startedAt;
      if (idle > idleLimit) timedOut = `静默 ${Math.round(idle / 60000)} 分钟无输出`;
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
        // 任何 assistant 事件都意味着模型已开始动作（可能已调用工具、写过文件、发过消息），
        // 此后的断连不可安全重放——只有在这之前失败才允许自动重试。
        producedOutput = true;
        // 单次调用的驻留上下文＝这一条 message 的 usage（result 里的是整轮累计，
        // 会把多次工具往返叠加成虚高数字——157 万那种读数就是这么来的）
        const mu = d.message?.usage;
        if (mu) {
          const ctx =
            (mu.input_tokens ?? 0) +
            (mu.cache_read_input_tokens ?? 0) +
            (mu.cache_creation_input_tokens ?? 0);
          if (ctx > 0) noteContext(chatId, ctx);
        }
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
        producedOutput = true;
        // 定时任务是一次性的独立上下文，持久化它的 session 会让每次 --resume 复利膨胀
        // （且永远收不到固化提醒）；/new 期间跑完的任务也不该把刚删掉的会话写回来。
        const ephemeral = ephemeralChat;
        const revoked = (resetGeneration.get(chatId) ?? 0) !== startedGeneration;
        if (d.session_id && !ephemeral && !revoked) {
          sessions[chatId] = d.session_id;
          saveSessions(sessions);
        } else if (revoked) {
          console.log(`[session] ${chatId} 运行期间已 /new，丢弃本轮 session 不回写`);
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
    // CLI 启动后立刻退出（损坏的 --resume 会话、盘不可读）时写 stdin 会抛 EPIPE，
    // 无监听器会直接冒泡成 uncaughtException 打死整个桥接进程
    child.stdin.on('error', (e) => {
      if (e?.code !== 'EPIPE') console.error('[stdin]', e?.message ?? e);
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
      // 标记「本次是否已经动过手」——重试层据此决定能否安全重放
      const mark = (err) => {
        err.producedOutput = producedOutput;
        return err;
      };
      if (finalErr) return reject(mark(finalErr));
      if (finalText !== null) {
        // 这一轮确实跑完了：若本轮携带过固化提醒，此刻才算固化完成
        if (nudgeInFlight.delete(chatId)) memoryFlushed.add(chatId);
        return resolve(finalText);
      }
      if (pending) {
        if (nudgeInFlight.delete(chatId)) memoryFlushed.add(chatId);
        return resolve(pending); // 异常缺失 result 时兜底
      }
      reject(mark(new Error(`claude CLI 失败(code ${code}): ${stderr.slice(0, 500)}`)));
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

// ---- 断连自动重试 ----
// 定时任务无人值守，一次瞬时断连＝白跑一周。只对「网络类」失败重试；
// 超时、登录失效、用户取消都不重试——重跑既解决不了问题，还白烧一遍额度。
const CLAUDE_MAX_RETRIES = Number(process.env.CLAUDE_MAX_RETRIES ?? 2);
const RETRY_DELAYS_MS = [3_000, 15_000];

const RETRYABLE =
  /Connection (lost|error|closed|reset)|ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|fetch failed|network error|stream (error|disconnected)|Internal server error|overloaded|\b(502|503|529)\b/i;
// 这些即便字面上像网络问题也不该重试
const NEVER_RETRY = /Not logged in|OAuth|authenticate|Invalid API|超时|CANCELLED|启动失败/i;

// 可中止的退避等待：/cancel 在重试间隙也必须生效，
// 否则用户看到「已取消」而重试照常发生（或被告知「没有正在运行的任务」）
const retryWaiters = new Map(); // chatId → { cancel }
export function abortRetries(chatId) {
  const w = retryWaiters.get(chatId);
  if (!w) return false;
  w.cancel();
  return true;
}
const sleepAbortable = (chatId, ms) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      retryWaiters.delete(chatId);
      resolve();
    }, ms);
    retryWaiters.set(chatId, {
      cancel: () => {
        clearTimeout(timer);
        retryWaiters.delete(chatId);
        const err = new Error('CANCELLED');
        err.cancelled = true;
        reject(err);
      },
    });
  });

/**
 * 运行 claude 无头模式，网络类失败自动重试（默认最多 2 次，退避 3s / 15s）。
 * 重试次数可用 CLAUDE_MAX_RETRIES 调整，设 0 关闭。
 *
 * 重要：只重试「还没动过手」的早期失败。一旦模型已经开始输出，就可能已经写过表、
 * 发过消息、改过记忆——整段重放会造成双写，比不重试更糟。
 */
export async function runClaude(chatId, prompt, isOwner = false, extraTools = [], onProgress = null, opts = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await runClaudeOnce(chatId, prompt, isOwner, extraTools, onProgress, opts);
    } catch (e) {
      const msg = String(e?.message ?? e);
      if (e?.producedOutput && !e?.cancelled && RETRYABLE.test(msg)) {
        console.log(`[retry] ${chatId} 已产生输出，断连后不自动重放（避免重复写入/重复发送）`);
        e.message = `${msg}\n（任务已执行到一半，为避免重复写入未自动重试——请确认副作用后手动重发）`;
        throw e;
      }
      const retryable =
        !e?.cancelled && !NEVER_RETRY.test(msg) && RETRYABLE.test(msg) && attempt < CLAUDE_MAX_RETRIES;
      if (!retryable) throw e;

      const delay = RETRY_DELAYS_MS[attempt] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
      console.log(
        `[retry] ${chatId} 网络类失败，${delay / 1000}s 后重试（${attempt + 1}/${CLAUDE_MAX_RETRIES}）：${msg.slice(0, 120)}`
      );
      if (onProgress) {
        try {
          await onProgress(`⚠️ 连接中断，${delay / 1000} 秒后自动重试（第 ${attempt + 1}/${CLAUDE_MAX_RETRIES} 次）`);
        } catch {}
      }
      await sleepAbortable(chatId, delay);
    }
  }
}
