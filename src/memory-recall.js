// 记忆自动召回：每条消息入队前，先在 memory/ 里找出可能相关的条目，
// 把"哪几个文件可能有用"作为提示注入，模型再自行决定要不要 Read。
//
// 为什么需要：记忆协议只写了"回答历史问题前先 Grep memory/"，但那依赖模型自觉——
// 它写得很勤（journal 天天有），取的时候却常常想不起来自己写过。检索这件事
// 桥接来做比让模型自觉更可靠，且零额外 token 成本（只注入几行路径提示）。
//
// 没有 embedding 也能解决大部分场景：中文按 2-4 字子串匹配，英文按单词，
// 标题/索引命中权重更高。真需要语义检索时再上向量索引。
import fs from 'node:fs';
import path from 'node:path';

const MAX_HITS = Number(process.env.MEMORY_RECALL_MAX ?? 3);
const MIN_SCORE = 2; // 低于此分认为是噪声匹配

// 高频词不具区分度，命中了也说明不了什么
const STOP = new Set([
  '什么', '怎么', '为什么', '可以', '我们', '你们', '他们', '这个', '那个', '一下', '现在',
  '需要', '应该', '还有', '就是', '不是', '没有', '如果', '因为', '所以', '知道', '告诉',
  'the', 'and', 'for', 'that', 'this', 'with', 'what', 'how', 'why', 'you', 'can', 'are',
]);

function terms(query) {
  const out = new Set();
  const q = String(query ?? '').slice(0, 500);
  // 英文/数字词
  for (const w of q.toLowerCase().match(/[a-z0-9_-]{3,}/g) ?? []) {
    if (!STOP.has(w)) out.add(w);
  }
  // 中文 2-4 字滑窗（无需分词器，对人名/项目名/术语足够有效）
  for (const run of q.match(/[一-龥]{2,}/g) ?? []) {
    for (let n = 2; n <= 4; n++) {
      for (let i = 0; i + n <= run.length; i++) {
        const t = run.slice(i, i + n);
        if (!STOP.has(t)) out.add(t);
      }
    }
  }
  return [...out];
}

function collectFiles(memDir) {
  const files = [];
  const push = (dir, prefix) => {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.md') || name.startsWith('._')) continue;
      if (name === 'MEMORY.md') continue; // 索引本身已随 CLAUDE.md 自动加载
      files.push({ abs: path.join(dir, name), rel: prefix + name });
    }
  };
  push(memDir, 'memory/');
  push(path.join(memDir, 'journal'), 'memory/journal/');
  return files;
}

/**
 * 返回一段可直接拼进提示词的召回提示；无命中时返回 ''。
 * 只在 owner 会话调用——访客工作区没有 memory/。
 */
export function recallHint(workspaceDir, query) {
  try {
    const memDir = path.join(workspaceDir, 'memory');
    if (!fs.existsSync(memDir)) return '';
    const ts = terms(query);
    if (!ts.length) return '';

    const scored = [];
    for (const f of collectFiles(memDir)) {
      let body;
      try {
        body = fs.readFileSync(f.abs, 'utf8');
      } catch {
        continue;
      }
      const lower = body.toLowerCase();
      const head = body.slice(0, 200).toLowerCase(); // 标题/描述区
      let score = 0;
      const matched = [];
      for (const t of ts) {
        const inBody = lower.split(t).length - 1;
        if (!inBody) continue;
        // 越长的词区分度越高；出现在开头（标题/description）额外加权
        score += Math.min(inBody, 3) * (t.length >= 3 ? 2 : 1) + (head.includes(t) ? 3 : 0);
        matched.push(t);
      }
      if (score >= MIN_SCORE) {
        scored.push({ rel: f.rel, score, matched: matched.sort((a, b) => b.length - a.length).slice(0, 3) });
      }
    }
    if (!scored.length) return '';
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, MAX_HITS);
    return [
      '',
      '（记忆检索：以下已有记忆可能与本次问题相关，需要时请用 Read 查看再回答，不要凭印象作答；',
      '不相关就忽略这段，也不要在回复里提及本提示。）',
      ...top.map((h) => `- ${h.rel}（命中：${h.matched.join('、')}）`),
    ].join('\n');
  } catch (e) {
    console.error('[recall]', e?.message ?? e);
    return '';
  }
}
