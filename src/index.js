import 'dotenv/config';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { getSignature, decrypt } from './wxcrypt.js';
import { runClaude, resetSession, sessionInfo, WORKSPACE_DIR } from './claude.js';
import { loadOwner, saveOwner } from './store.js';

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

  let owner = loadOwner();
  if (!owner) {
    owner = userId;
    saveOwner(owner);
    console.log(`[owner] 已锁定 owner userid = ${owner}`);
    await send(userId, `✅ 已将你登记为本机器人 owner。\n直接发消息即可对话；发送 /new 开启新会话，/status 查看会话状态。`);
    return;
  }
  const isOwner = userId === owner;

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
    resetSession(chatId);
    await send(userId, '🆕 已重置，下一条消息将开启全新 Claude 会话。');
    return;
  }
  if (text === '/status') {
    await send(userId, sessionInfo(chatId, isOwner));
    return;
  }

  const extraTools = built.attachments.length ? ['Read(./incoming/**)'] : [];

  enqueue(chatId, async () => {
    console.log(`[msg] ${isOwner ? 'owner' : userId} [${m.MsgType}]: ${text.slice(0, 80)}`);
    try {
      const answer = await runClaude(chatId, text, isOwner, extraTools);
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

server.listen(PORT, () => {
  console.log(`企业微信回调服务已启动: http://0.0.0.0:${PORT}${CALLBACK_PATH}`);
  console.log('提醒：企业微信要求回调地址可公网访问（可用 cloudflared / frp 等隧道映射本端口）');
});
