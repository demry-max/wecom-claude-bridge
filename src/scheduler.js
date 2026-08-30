// 定时任务：机器人把任务定义写进 workspace/schedules/*.json（白名单写入权），
// 桥接负责到点执行——不给机器人 Bash/launchctl 权限，避免聊天消息能在主机跑任意命令。
//
// 任务文件格式：
// {
//   "name": "晨报",                       // 展示名
//   "when": "0 8 * * 1-5",                // cron 表达式（本地时区）；或一次性 ISO 时间 "2026-07-27T08:00"
//   "prompt": "汇总今天日程并提醒我",       // 到点后交给 Claude 执行的提示词
//   "chat_id": "oc_xxx",                  // 结果发到哪个会话
//   "enabled": true
// }
import fs from 'node:fs';
import path from 'node:path';
import { CronExpressionParser } from 'cron-parser';

const TICK_MS = 30_000;
// 迟到窗口：错过的任务只在这个窗口内补跑。机器休眠一夜后醒来，
// 不该把昨天的晨报、已经过期的模型切换全部倒着补一遍。
const MAX_LATE_MS = Number(process.env.SCHED_MAX_LATE_MS ?? 2 * 60 * 60 * 1000);

// action 型任务只允许这些动作——任务定义由机器人自己写，
// 而机器人可能被聊天内容注入，所以这里按白名单严格枚举，未知 action 一律拒绝执行。
const ALLOWED_ACTIONS = new Set(['set-model']);

function readJobs(dir) {
  if (!fs.existsSync(dir)) return [];
  const jobs = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json') || f.startsWith('._')) continue; // 跳过 exFAT 的 AppleDouble 影子文件
    try {
      const job = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      job._file = f;
      if (job.enabled === false || !job.when) continue;
      if (job.action && !ALLOWED_ACTIONS.has(job.action)) {
        console.error(`[sched] 拒绝未知 action「${job.action}」(${f})，已跳过`);
        continue;
      }
      // prompt 型（跑 Claude）或 action 型（如切模型）任一即可
      if (job.prompt || job.action) jobs.push(job);
    } catch (e) {
      console.error(`[sched] 任务文件解析失败 ${f}:`, e?.message ?? e);
    }
  }
  return jobs;
}

// 一次性任务：when 是 ISO 时间（无空格）；cron 任务：五段表达式（含空格）
function isOneShot(job) {
  const w = String(job.when).trim();
  // cron 宏（@daily/@weekly/@hourly…）不含空格，但绝不是一次性时间——
  // 早先按「无空格即一次性」判定，会把它们当成非法日期而静默永不触发
  if (w.startsWith('@')) return false;
  return !w.includes(' ');
}

// 返回 <= now 的最近一次应触发时间；不该触发则返回 null
function lastDueAt(job, now) {
  const when = String(job.when).trim();
  if (isOneShot(job)) {
    const t = new Date(when); // 本地时区
    return !isNaN(t) && t <= now ? t : null;
  }
  try {
    return CronExpressionParser.parse(when, { currentDate: now }).prev().toDate();
  } catch (e) {
    console.error(`[sched] 无效的 when「${when}」(${job.name ?? job._file}):`, e?.message ?? e);
    return null;
  }
}

/**
 * 启动调度器。onFire(job) 由调用方实现（跑 Claude 并把结果发到会话）。
 * 触发状态记录在 data/schedule-state.json，重启不会重复触发或漏触发。
 */
export function startScheduler({ schedulesDir, stateFile, onFire }) {
  fs.mkdirSync(schedulesDir, { recursive: true });

  const loadState = () => {
    try {
      return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    } catch {
      return {};
    }
  };
  const saveState = (s) => {
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      const tmp = `${stateFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
      fs.renameSync(tmp, stateFile);
    } catch (e) {
      console.error('[sched] 状态写入失败:', e?.message ?? e);
    }
  };

  // 每次只改自己那个 key 再落盘，绝不整份覆盖：
  // onFire 是分钟级的，期间别的任务可能已经写过状态，用开局的旧快照全量覆盖会把它们抹掉
  const markFired = (file, iso, extra = {}) => {
    const cur = loadState();
    cur[file] = { at: iso, ...extra };
    saveState(cur);
  };

  // 锁到「任务」而不是「整轮 tick」：全局闸会让一个跑几十分钟的周报
  // 把同期到点的任务一直挡在门外，直到它们超过迟到窗口被永久跳过。
  const inflight = new Set();
  const MAX_CONCURRENT = Number(process.env.SCHED_MAX_CONCURRENT ?? 2);
  let scanning = false;
  const tick = async () => {
    if (scanning) return; // 仅防止扫描本身重入；执行是异步的
    scanning = true;
    try {
      const now = new Date();
      const s = loadState();
      const pending = [];
      for (const job of readJobs(schedulesDir)) {
        if (inflight.has(job._file)) continue; // 上一轮还没跑完
        const due = lastDueAt(job, now);
        if (!due) continue;
        // 状态里连 when 一起记：改了触发时间就重新登记基线，
        // 否则编辑任务的那一刻会立刻补跑上一个时间点（"改期即补跑"）
        const rec = s[job._file];
        const prev = typeof rec === 'string' ? { at: rec, when: job.when } : (rec ?? null);
        const seen = prev !== null && prev.when === job.when;
        const last = seen && prev.at ? new Date(prev.at) : null;

        // cron 任务首次被发现时只记基线、不补跑历史时间点
        // （否则中午建的「每天 9 点」会立刻触发一次）
        if (!seen && !isOneShot(job)) {
          markFired(job._file, due.toISOString(), { when: job.when, status: 'baseline' });
          console.log(`[sched] 已登记「${job.name ?? job._file}」(${job.when})，下次到点触发`);
          continue;
        }
        if (last && due <= last) continue; // 这一次已经跑过

        // 迟到太久就放弃：关机一夜后醒来不该把昨天的任务倒着补一遍
        const lateMs = Date.now() - due.getTime();
        if (lateMs > MAX_LATE_MS) {
          markFired(job._file, due.toISOString(), { when: job.when, status: 'skipped-late' });
          console.log(
            `[sched] 跳过「${job.name ?? job._file}」：应于 ${due.toLocaleString('zh-CN')} 触发，已迟到 ${Math.round(lateMs / 60000)} 分钟（超过 ${Math.round(MAX_LATE_MS / 60000)} 分钟窗口）`
          );
          continue;
        }

        // 先占位防重复触发，跑完再落「已完成」；中途崩溃时留下 running 痕迹便于排查
        markFired(job._file, due.toISOString(), { when: job.when, status: 'running' });
        const lateNote = lateMs > 5 * 60_000 ? `（迟到补跑 ${Math.round(lateMs / 60000)} 分钟）` : '';
        console.log(`[sched] 触发「${job.name ?? job._file}」(${due.toLocaleString('zh-CN')})${lateNote}`);
        if (inflight.size >= MAX_CONCURRENT) {
          console.log(`[sched] 并发已满（${MAX_CONCURRENT}），「${job.name ?? job._file}」下一轮再试`);
          continue;
        }
        inflight.add(job._file);
        const runOne = (async () => {
          try {
            await onFire({ ...job, _late: lateMs > 5 * 60_000 ? lateMs : 0 });
            markFired(job._file, due.toISOString(), { when: job.when, status: 'done' });
          } catch (e) {
            console.error(`[sched] 执行失败 ${job._file}:`, e?.message ?? e);
            markFired(job._file, due.toISOString(), { when: job.when, status: 'failed' });
          } finally {
            inflight.delete(job._file);
            // 一次性任务跑完即停用，避免重复
            if (isOneShot(job)) {
              try {
                const fp = path.join(schedulesDir, job._file);
                const raw = JSON.parse(fs.readFileSync(fp, 'utf8'));
                raw.enabled = false;
                raw.last_run = due.toISOString();
                const tmp = `${fp}.tmp`;
                fs.writeFileSync(tmp, JSON.stringify(raw, null, 2));
                fs.renameSync(tmp, fp);
              } catch (e) {
                console.error('[sched] 停用一次性任务失败:', e?.message ?? e);
              }
            }
          }
        })();
        pending.push(runOne);
      }
      // 等本轮派发出去的任务收束，便于测试确定性；生产里它们本来就是并发的
      await Promise.allSettled(pending);
    } finally {
      scanning = false;
    }
  };

  const timer = setInterval(() => tick().catch((e) => console.error('[sched]', e)), TICK_MS);
  const first = tick().catch((e) => console.error('[sched]', e));
  console.log(`定时任务调度器已启动（每 ${TICK_MS / 1000}s 检查一次）：${schedulesDir}`);
  // 返回停止句柄：测试用它收尾，生产侧不调用即可（进程由长连接保持存活）
  return { stop: () => clearInterval(timer), whenIdle: () => first };
}
