import 'dotenv/config';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { getSignature, decrypt } from './wxcrypt.js';
import { runClaude, resetSession, sessionInfo, WORKSPACE_DIR, GUEST_WORKSPACE_DIR, workspaceFor, outboxDirFor, shouldRecycleSession , getRuntimeConfig, setRuntimeConfig, MODEL_ALIASES, EFFORT_LEVELS, consumeMemoryNudge } from './claude.js';
import { loadOwner, saveOwner } from './store.js';
import { startScheduler } from './scheduler.js';

const CORP_ID = process.env.WECOM_CORP_ID;
const AGENT_ID = process.env.WECOM_AGENT_ID;
const SECRET = process.env.WECOM_SECRET;
const TOKEN = process.env.WECOM_TOKEN;
const AES_KEY = process.env.WECOM_AES_KEY;
const PORT = Number(process.env.PORT || 3979);
const CALLBACK_PATH = process.env.CALLBACK_PATH || '/wecom/callback';

for (const [k, v] of Object.entries({ WECOM_CORP_ID: CORP_ID, WECOM_AGENT_ID: AGENT_ID, WECOM_SECRET: SECRET, WECOM_TOKEN: TOKEN, WECOM_AES_KEY: AES_KEY })) {
  if (!v) {
    console.error(`缺少 ${k}，请检查 .env`);
    process.exit(1);
  }
}

const xml = new XMLParser({ ignoreAttributes: true });

// ---- 企业微信 API ----
let tokenCache = { v: null, exp: 0 };
async function accessToken() {
  if (tokenCache.v && Date.now() < tokenCache.exp) return tokenCache.v;
  const res = await fetch(
    `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${CORP_ID}&corpsecret=${SECRET}`
  );
  const d = await res.json();
  if (!d.access_token) throw new Error(`获取 access_token 失败: ${JSON.stringify(d).slice(0, 200)}`);
  tokenCache = { v: d.access_token, exp: Date.now() + (Number(d.expires_in || 7200) - 300) * 1000 };
  return tokenCache.v;
}

async function send(touser, content) {
  const post = async (body) => {
    const res = await fetch(
      `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${await accessToken()}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    );
    return res.json();
  };
  const chunk = content.slice(0, 2000); // 企业微信单条消息上限 2048 字节级，保守截断分片
  const chunks = [];
  for (let i = 0; i < content.length; i += 2000) chunks.push(content.slice(i, i + 2000));
  for (const c of chunks.length ? chunks : [chunk]) {
    let r = await post({ touser, msgtype: 'markdown', agentid: Number(AGENT_ID), markdown: { content: c } });
    if (r.errcode !== 0) {
      // 部分环境不支持 markdown，降级纯文本
      r = await post({ touser, msgtype: 'text', agentid: Number(AGENT_ID), text: { content: c } });
      if (r.errcode !== 0) console.error('[send]', JSON.stringify(r).slice(0, 200));
    }
  }
}

async function downloadMedia(mediaId, dest) {
  const res = await fetch(
    `https://qyapi.weixin.qq.com/cgi-bin/media/get?access_token=${await accessToken()}&media_id=${mediaId}`
  );
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('json')) {
    const d = await res.json();
    throw new Error(`下载素材失败: ${JSON.stringify(d).slice(0, 200)}`);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  return dest;
}

// ---- 去重 + 串行队列 ----
const seen = new Set();
function isDuplicate(id) {
  if (!id) return false;
  if (seen.has(id)) return true;
  seen.add(id);
  if (seen.size > 1000) for (const k of seen) { seen.delete(k); if (seen.size <= 500) break; }
  return false;
}
// 进程级兜底：宁可重启，也不要带病静默运行
// 退避退出：裸 exit 配进程管理器的重启节流会变成高频重启风暴
let exiting = false;
function bailOut(reason, delayMs = 0) {
  if (exiting) return;
  exiting = true;
  console.error(`[exit] ${reason}`);
  setTimeout(() => process.exit(1), delayMs).unref();
}

process.on('uncaughtException', (e) => {
  console.error('[fatal] uncaughtException:', e?.stack ?? e);
  bailOut('uncaughtException', 2000);
});
process.on('unhandledRejection', (e) => {
  console.error('[fatal] unhandledRejection:', e?.stack ?? e);
});

// owner 身份的权威来源：配了它，owner 记录丢失也能直接恢复，无需认领流程
const OWNER_USER_ID = (process.env.OWNER_USER_ID ?? '').trim();

const chatQueues = new Map();
function enqueue(chatId, task) {
  const next = (chatQueues.get(chatId) ?? Promise.resolve()).then(task).catch((e) => console.error('[queue]', e));
  chatQueues.set(chatId, next);
}

// ---- 消息 → 提示词 ----
async function buildPrompt(m) {
  const incomingDir = path.join(WORKSPACE_DIR, 'incoming', String(m.MsgId ?? Date.now()));
  const rel = (p) => `./${path.relative(WORKSPACE_DIR, p)}`;
  switch (m.MsgType) {
    case 'text':
      return { prompt: String(m.Content ?? '').trim(), attachments: [] };
    case 'image': {
      const p = await downloadMedia(m.MediaId, path.join(incomingDir, 'image.jpg'));
      return {
        prompt: `用户发来一张图片，已保存为 ${rel(p)}。请用 Read 工具查看图片内容，然后回应用户。`,
        attachments: [p],
      };
    }
    case 'file': {
      const name = m.Title || 'file.bin';
      const p = await downloadMedia(m.MediaId, path.join(incomingDir, path.basename(name)));
      return {
        prompt: `用户发来一个文件「${name}」，已保存为 ${rel(p)}。请用 Read 工具查看文件内容，然后回应用户。`,
        attachments: [p],
      };
    }
    case 'voice': {
      // 企业微信开启「语音转文字」后带 Recognition 字段；未开启则无法转写
      const stt = String(m.Recognition ?? '').trim();
      if (stt) return { prompt: `（用户发来一条语音，转写内容如下）\n${stt}`, attachments: [] };
      return { prompt: null, attachments: [], unsupported: '语音未携带转写文本（企业微信未开启语音识别），请改发文字。' };
    }
    default:
      return { prompt: null, attachments: [], unsupported: `暂不支持「${m.MsgType}」类型消息。` };
  }
}

async function handleMessage(m) {
  const userId = String(m.FromUserName ?? '');
  if (!userId) return;
  if (isDuplicate(m.MsgId)) return;
  const chatId = userId; // 自建应用消息均为单聊

  let owner = OWNER_USER_ID || loadOwner();
  if (!owner) {
    // 收紧自动认领：owner.json 一旦丢失（盘故障、误删、恢复旧备份），
    // 下一个私聊机器人的人就会继承全量本机工具。需显式开启才允许重新认领。
    if (process.env.ALLOW_OWNER_CLAIM !== 'true') {
      console.error(
        `[owner] owner.json 缺失且未开放认领。确需重新认领请在 .env 设 ALLOW_OWNER_CLAIM=true 后重启。当前请求者：${userId}`
      );
      await send(userId, '⚠️ 机器人的 owner 记录缺失，出于安全未自动认领。请在主机上恢复 data/owner.json 或按日志提示配置后重启。');
      return;
    }
    owner = userId;
    if (!saveOwner(owner)) {
      // 写盘失败却回复「已登记」，会让真正的 owner 之后被静默降级为访客
      await send(userId, '⚠️ owner 记录写入失败（磁盘不可写），未完成登记。请检查主机磁盘后重试。');
      return;
    }
    console.log(`[owner] 已锁定 owner userid = ${owner}`);
    await send(userId, `✅ 已将你登记为本机器人 owner。\n直接发消息即可对话；发送 /new 开启新会话，/status 查看会话状态。`);
    return;
  }
  const isOwner = userId === owner;

  // 会话键区分身份：owner 与访客的 cwd 不同（workspace vs workspace-guest），
  // 共用 session 会让访客通过 --resume 恢复出 owner 那条带私有记忆的会话
  const sessionKey = isOwner ? chatId : `guest:${chatId}`;

  let built;
  try {
    built = await buildPrompt(m);
  } catch (e) {
    console.error('[buildPrompt]', e);
    await send(userId, `⚠️ 处理该消息失败：${e?.message ?? e}`);
    return;
  }
  if (built.unsupported) {
    await send(userId, built.unsupported);
    return;
  }
  const text = built.prompt?.trim();
  if (!text) return;

  if (text === '/new') {
    resetSession(sessionKey);
    await send(userId, '🆕 已重置，下一条消息将开启全新 Claude 会话。');
    return;
  }
  if (text === '/status') {
    await send(userId, sessionInfo(sessionKey, isOwner));
    return;
  }

  const extraTools = built.attachments.length ? ['Read(./incoming/**)'] : [];

  // 上下文接近压缩点：提醒机器人先固化记忆（仅 owner——只有 owner 有 memory 写权限）
  let prompt = text;
  if (isOwner && consumeMemoryNudge(chatId)) {
    prompt +=
      '\n\n（系统提示：本会话上下文接近上限，即将被自动压缩。压缩只影响对话历史，不影响 memory/ 文件。' +
      '请先检查这段对话里有哪些值得长期保留的事实、决定、偏好还没写进 memory/——稳定偏好就地合入 USER.md，长期事实建独立文件并更新 MEMORY.md 索引，过程细节追加进 memory/journal/ 当日文件；' +
      '没有就忽略本提示，正常回答用户的问题。不要因为这条提示改变回答的语气或结构。）';
  }

  enqueue(sessionKey, async () => {
    console.log(`[msg] ${isOwner ? 'owner' : userId} [${m.MsgType}]: ${text.slice(0, 80)}`);
    try {
      const answer = await runClaude(sessionKey, prompt, isOwner, extraTools);
      await send(userId, answer || '（Claude 返回了空回复）');
    } catch (e) {
      console.error('[claude]', e);
      const msg = String(e.message ?? e);
      const friendly = msg.includes('401') || /re-?authenticate/i.test(msg)
        ? '⚠️ 主机上的 Claude 登录已过期。请在主机终端运行 claude /login 重新登录后再试。'
        : `⚠️ Claude 调用失败：${msg}`;
      await send(userId, friendly);
    }
  });
}

// ---- 回调 HTTP 服务 ----
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname !== CALLBACK_PATH) {
    res.writeHead(404).end();
    return;
  }
  const q = Object.fromEntries(url.searchParams);

  // 后台「保存回调配置」时的 URL 校验
  if (req.method === 'GET') {
    try {
      if (getSignature(TOKEN, q.timestamp, q.nonce, q.echostr) !== q.msg_signature) {
        throw new Error('signature mismatch');
      }
      const { msg } = decrypt(AES_KEY, q.echostr);
      res.writeHead(200).end(msg);
      console.log('[verify] 回调 URL 校验通过');
    } catch (e) {
      console.error('[verify]', e?.message ?? e);
      res.writeHead(403).end();
    }
    return;
  }

  if (req.method === 'POST') {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      // 立即回空 ack，避免企业微信 5 秒超时重投；实际回复走主动发消息 API
      res.writeHead(200).end('');
      try {
        const encrypted = xml.parse(body)?.xml?.Encrypt;
        if (!encrypted) return;
        if (getSignature(TOKEN, q.timestamp, q.nonce, encrypted) !== q.msg_signature) {
          console.error('[callback] 签名校验失败');
          return;
        }
        const { msg } = decrypt(AES_KEY, encrypted);
        const m = xml.parse(msg)?.xml;
        if (m?.MsgType) handleMessage(m).catch((e) => console.error('[handle]', e));
      } catch (e) {
        console.error('[callback]', e?.message ?? e);
      }
    });
    return;
  }
  res.writeHead(405).end();
});

// ---- 定时任务：到点跑 Claude，把结果主动发给对应成员 ----
// 企业微信是单聊模型，任务文件里的 chat_id 即成员 UserID
startScheduler({
  schedulesDir: path.join(WORKSPACE_DIR, 'schedules'),
  stateFile: path.join(WORKSPACE_DIR, '..', 'data', 'schedule-state.json'),
  onFire: async (job) => {
    const touser = job.chat_id;
    // 动作型任务：切换模型/思考档，不走 Claude 调用
    if (job.action === 'set-model') {
      try {
        const next = setRuntimeConfig({ model: job.model, effort: job.effort });
        console.log(`[sched] 已切换模型 → ${next.model} / ${next.effort}`);
        if (touser) await send(touser, `🔀 ${job.name ?? '定时切换'}：模型 ${next.model || 'CLI 默认'}，思考深度 ${next.effort || 'CLI 默认'}`);
      } catch (e) {
        console.error('[sched] 切换模型失败:', e?.message ?? e);
      }
      return;
    }
    if (!touser) {
      console.error(`[sched] 任务「${job.name ?? job._file}」缺 chat_id（企业微信 UserID），跳过`);
      return;
    }
    // 定时任务用独立会话上下文，避免污染用户正在进行的对话
    const answer = await runClaude(`sched:${job._file}`, job.prompt, true, [], (p) =>
      send(touser, `⏳ ${p}`)
    );
    // 无事不报：巡检类任务返回 HEARTBEAT_OK 时静默跳过
    const body = (answer ?? '').trim();
        if (!body || /^HEARTBEAT_OK[.。!！]?$/i.test(body)) {
      console.log(`[sched] 「${job.name ?? job._file}」无需汇报，静默跳过`);
    } else {
      await send(touser, `⏰ ${job.name ?? '定时任务'}\n\n${answer || '（无输出）'}`);
    }
  },
});


// 启动时打印真正生效的配置：dotenv 不会覆盖已存在的环境变量，
// 若在 shell 里 export 过 CLAUDE_MODEL/CLAUDE_EFFORT 再手动启动，.env 会被静默忽略
{
  const cfg = getRuntimeConfig();
  const shadowed = ['CLAUDE_MODEL', 'CLAUDE_EFFORT', 'GUEST_TOOLS']
    .filter((k) => {
      try {
        const line = fs.readFileSync(path.resolve(process.cwd(), '.env'), 'utf8')
          .split('\n').find((l) => l.startsWith(`${k}=`));
        const inFile = line ? line.slice(k.length + 1).replace(/\s+#.*$/, '').trim() : null;
        return inFile && process.env[k] && process.env[k] !== inFile;
      } catch { return false; }
    });
  console.log(`[config] 生效配置：模型=${cfg.model || 'CLI 默认'} 思考档=${cfg.effort || 'CLI 默认'}`);
  if (shadowed.length) {
    console.error(`[config] ⚠️ 以下变量被 shell 环境覆盖，.env 里的值未生效：${shadowed.join(', ')}`);
  }
}

server.listen(PORT, () => {
  console.log(`企业微信回调服务已启动: http://0.0.0.0:${PORT}${CALLBACK_PATH}`);
  console.log('提醒：企业微信要求回调地址可公网访问（可用 cloudflared / frp 等隧道映射本端口）');
});
