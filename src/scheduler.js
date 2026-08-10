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

function readJobs(dir) {
  if (!fs.existsSync(dir)) return [];
  const jobs = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json') || f.startsWith('._')) continue; // 跳过 exFAT 的 AppleDouble 影子文件
    try {
      const job = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      job._file = f;
      // prompt 型（跑 Claude）或 action 型（如切模型）任一即可
      if (job.enabled !== false && job.when && (job.prompt || job.action)) jobs.push(job);
    } catch (e) {
      console.error(`[sched] 任务文件解析失败 ${f}:`, e?.message ?? e);
    }
  }
  return jobs;
}

// 一次性任务：when 是 ISO 时间（无空格）；cron 任务：五段表达式（含空格）
function isOneShot(job) {
  return !String(job.when).trim().includes(' ');
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
      fs.writeFileSync(stateFile, JSON.stringify(s, null, 2));
    } catch (e) {
      console.error('[sched] 状态写入失败:', e?.message ?? e);
    }
  };

  const tick = async () => {
    const now = new Date();
    const s = loadState();
    for (const job of readJobs(schedulesDir)) {
      const due = lastDueAt(job, now);
      if (!due) continue;
      const seen = Object.prototype.hasOwnProperty.call(s, job._file);
      const last = seen ? new Date(s[job._file]) : null;

      // cron 任务首次被发现时只记基线、不补跑历史时间点
      // （否则中午建的「每天 9 点」会立刻触发一次）
      if (!seen && !isOneShot(job)) {
        s[job._file] = due.toISOString();
        saveState(s);
        console.log(`[sched] 已登记「${job.name ?? job._file}」(${job.when})，下次到点触发`);
        continue;
      }
      if (last && due <= last) continue; // 这一次已经跑过

      s[job._file] = due.toISOString();
      saveState(s);
      console.log(`[sched] 触发「${job.name ?? job._file}」(${due.toLocaleString('zh-CN')})`);
      try {
        await onFire(job);
      } catch (e) {
        console.error(`[sched] 执行失败 ${job._file}:`, e?.message ?? e);
      }

      // 一次性任务跑完即停用，避免重复
      if (isOneShot(job)) {
        try {
          const p = path.join(schedulesDir, job._file);
          const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
          raw.enabled = false;
          raw.last_run = due.toISOString();
          fs.writeFileSync(p, JSON.stringify(raw, null, 2));
        } catch (e) {
          console.error('[sched] 停用一次性任务失败:', e?.message ?? e);
        }
      }
    }
  };

  setInterval(() => tick().catch((e) => console.error('[sched]', e)), TICK_MS);
  tick().catch((e) => console.error('[sched]', e));
  console.log(`定时任务调度器已启动（每 ${TICK_MS / 1000}s 检查一次）：${schedulesDir}`);
}
