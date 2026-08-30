// 回归测试：锁住 2026-08-30 两轮审查修掉的缺陷。
// 零额外依赖，用 Node 内置 test runner：npm test
//
// 教训写在这里：第一版测试全是「对源码做正则匹配」，结果把访客隔离三处
// 同时改回 owner workspace（等于修复完全回退），27 条依然全绿——那种测试
// 只能证明某段字符还在文件里，不能证明程序行为正确。
// 所以凡是能调用的，一律断言**真实返回值**；只有纯结构约束（如变量声明顺序）
// 才保留源码断言，并在注释里写明它证明不了什么。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, 'src', f), 'utf8');

const {
  buildClaudeArgs,
  workspaceFor,
  outboxDirFor,
  isEphemeral,
  WORKSPACE_DIR,
  GUEST_WORKSPACE_DIR,
} = await import('../src/claude.js');

const argVal = (args, flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

describe('访客隔离（行为断言）', () => {
  const guest = buildClaudeArgs('guest:oc_g:ou_someone', false, []);
  const owner = buildClaudeArgs('oc_owner', true, []);

  test('访客与 owner 跑在不同工作区', () => {
    assert.equal(guest.cwd, GUEST_WORKSPACE_DIR);
    assert.equal(owner.cwd, WORKSPACE_DIR);
    assert.notEqual(guest.cwd, owner.cwd);
  });


  test('访客工具集是白名单而非黑名单', () => {
    // 黑名单只能挡住你想到的名字：实测 --disallowedTools 方案下访客仍有 22 个内置工具，
    // 含 SendMessage / Artifact / CronCreate / Workflow，且都以 owner 的账号身份运行。
    const tools = (argVal(guest.args, '--tools') ?? '').split(',').filter(Boolean);
    assert.ok(tools.length > 0, '必须显式声明访客可用的内置工具');
    for (const bad of ['SendMessage', 'Artifact', 'CronCreate', 'Workflow', 'ListAgents', 'Bash', 'Task']) {
      assert.ok(!tools.includes(bad), `${bad} 绝不能出现在访客白名单里`);
    }
    // allowedTools 必须与白名单一致，否则白名单里有、免询问列表里没有 → -p 模式下会卡在询问
    const allowed = (argVal(guest.args, '--allowedTools') ?? '').split(',').filter(Boolean);
    for (const x of tools) assert.ok(allowed.includes(x), `${x} 在白名单里就必须免询问`);
  });

  test('访客不加载任何 settings 文件', () => {
    // user 级 permissions.allow 是上一轮 CRITICAL 的根源；project 级同样可能被提交进仓库
    assert.equal(argVal(guest.args, '--setting-sources'), '');
    assert.ok(guest.args.includes('--strict-mcp-config'));
  });

  test('访客默认没有 WebFetch（可探测本机与内网）', () => {
    const tools = (argVal(guest.args, '--tools') ?? '').split(',');
    assert.ok(!tools.includes('WebFetch'), 'WebFetch 不限制目标地址，实测可连 127.0.0.1 探测端口');
  });

  test('访客关闭自动记忆，且用的是真实存在的配置键', () => {
    const settings = JSON.parse(argVal(guest.args, '--settings'));
    // 键名写错（如 autoMemory）在 -p 模式下会被静默忽略，等于没设防
    assert.equal(settings.autoMemoryEnabled, false);
    assert.ok(!('autoMemory' in settings), 'autoMemory 不是 CLI 认识的键');
  });


  test('owner 不受访客那套限制影响', () => {
    assert.ok(!owner.args.includes('--strict-mcp-config'));
    assert.ok(!owner.args.includes('--disallowedTools'));
  });

  test('访客发附件时放行 Read，但仍限定在 incoming 路径', () => {
    const withFile = buildClaudeArgs('guest:a:b', false, ['Read(./incoming/**)']);
    const denied = (argVal(withFile.args, '--disallowedTools') ?? '').split(',');
    assert.ok(!denied.includes('Read'), '否则访客发的图片没法看');
    assert.match(argVal(withFile.args, '--allowedTools'), /Read\(\.\/incoming/);
  });

  test('outbox 按身份与会话隔离，不同 chatId 不碰撞', () => {
    assert.ok(outboxDirFor('oc_x', false).startsWith(GUEST_WORKSPACE_DIR));
    assert.ok(outboxDirFor('oc_x', true).startsWith(WORKSPACE_DIR));
    assert.notEqual(outboxDirFor('oc_x', true), outboxDirFor('oc_x', false));
    // 早先 safeKey 把 '.' 折叠成 '_'，两个不同任务会撞进同一个目录
    assert.notEqual(outboxDirFor('sched:a.json', true), outboxDirFor('sched:a_json', true));
    const dir = path.basename(outboxDirFor('sched:weekly.json', true));
    assert.ok(!dir.includes(':') && !dir.includes('/'), '目录名不得含路径分隔或穿越字符');
  });
});

describe('会话生命周期（行为断言）', () => {
  test('定时任务是一次性上下文：既不 resume 也不持久化', () => {
    assert.ok(isEphemeral('sched:weekly.json'));
    assert.ok(isEphemeral('sched-diag:weekly.json'));
    assert.ok(!isEphemeral('oc_normal_chat'));
    const s = buildClaudeArgs('sched:weekly.json', true, [], { resumeId: 'sess-abc' });
    assert.ok(!s.args.includes('--resume'), '只堵写不堵读的话，历史会话仍会被续下去');
    const n = buildClaudeArgs('oc_normal', true, [], { resumeId: 'sess-abc' });
    assert.equal(argVal(n.args, '--resume'), 'sess-abc', '普通会话必须能续聊');
  });

  test('运行配置随调用注入，不落共享文件', () => {
    const a = buildClaudeArgs('oc_x', true, [], { model: 'claude-opus-5', effort: 'high' });
    const sys = argVal(a.args, '--append-system-prompt');
    assert.match(sys, /claude-opus-5/);
    assert.match(sys, /oc_x/);
    assert.equal(argVal(a.args, '--model'), 'claude-opus-5');
    // 定时任务不该被告知某个真实 chat_id（否则会把排期发到别人的会话）
    const s = buildClaudeArgs('sched:x.json', true, []);
    assert.ok(!/oc_/.test(argVal(s.args, '--append-system-prompt')));
  });

  test('任务级模型覆盖全局配置', () => {
    const a = buildClaudeArgs('sched:x.json', true, [], { model: 'claude-haiku-4-5-20251001' });
    assert.equal(argVal(a.args, '--model'), 'claude-haiku-4-5-20251001');
  });
});

describe('状态写入（行为断言）', () => {
  test('写盘失败返回 false 而不是抛异常（回调里抛会打死进程）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-'));
    process.env.DATA_DIR = dir;
    const mod = await import(`../src/store.js?t=${Date.now()}`);
    assert.equal(mod.saveSessions({ a: 'b' }), true);
    assert.deepEqual(mod.loadSessions(), { a: 'b' });
    fs.chmodSync(dir, 0o500); // 只读目录
    assert.equal(mod.saveSessions({ c: 'd' }), false, '失败必须可被调用方感知');
    fs.chmodSync(dir, 0o700);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('结构约束（源码断言——只证明写法，不证明行为）', () => {



  test('调度器状态按 key 增量写，不整份覆盖', () => {
    const src = read('scheduler.js');
    assert.match(src, /const markFired/);
    assert.ok(!/\bsaveState\(s\)/.test(src), '用开局快照整体回写会抹掉并发写入');
  });


});

const { startScheduler } = await import('../src/scheduler.js');

describe('调度器（真跑 tick 的行为断言）', () => {
  const mkEnv = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-'));
    return { dir, jobs: path.join(dir, 'jobs'), state: path.join(dir, 'state.json') };
  };
  // 一次性任务的 when 按**本地时区**解析，构造测试时间必须同样用本地时区：
  // 直接用 toISOString() 会得到 UTC，在 +08 环境下凭空差 8 小时
  const localWhen = (msFromNow) => {
    const d = new Date(Date.now() + msFromNow);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  };
  const write = (env, name, job) => {
    fs.mkdirSync(env.jobs, { recursive: true });
    fs.writeFileSync(path.join(env.jobs, name), JSON.stringify(job));
  };
  // 用调度器返回的 whenIdle 等首轮 tick 真正跑完，而不是靠 sleep 猜时间
  const run = async (env, onFire) => {
    const h = startScheduler({ schedulesDir: env.jobs, stateFile: env.state, onFire });
    await h.whenIdle();
    h.stop();
  };

  test('到点的一次性任务会触发，未到点的不触发', async () => {
    const env = mkEnv();
    const fired = [];
    const past = localWhen(-60_000);
    const future = localWhen(3600_000);
    write(env, 'due.json', { name: 'due', when: past, prompt: 'x', enabled: true });
    write(env, 'later.json', { name: 'later', when: future, prompt: 'x', enabled: true });
    await run(env, (j) => fired.push(j.name));
    assert.deepEqual(fired, ['due'], '只有到点的该跑');
    fs.rmSync(env.dir, { recursive: true, force: true });
  });

  test('迟到超过窗口则跳过，不补跑', async () => {
    const env = mkEnv();
    const fired = [];
    process.env.SCHED_MAX_LATE_MS = '60000';
    const longAgo = localWhen(-3 * 3600_000);
    write(env, 'stale.json', { name: 'stale', when: longAgo, prompt: 'x', enabled: true });
    await run(env, (j) => fired.push(j.name));
    assert.deepEqual(fired, [], '关机一夜后醒来不该把昨天的任务倒着补一遍');
    const st = JSON.parse(fs.readFileSync(env.state, 'utf8'));
    assert.equal(st['stale.json'].status, 'skipped-late', '状态要能分辨「跳过」与「执行」');
    delete process.env.SCHED_MAX_LATE_MS;
    fs.rmSync(env.dir, { recursive: true, force: true });
  });

  test('未知 action 被拒绝执行（防注入的任务定义）', async () => {
    const env = mkEnv();
    const fired = [];
    const past = localWhen(-60_000);
    write(env, 'evil.json', { name: 'evil', when: past, action: 'run-shell', cmd: 'rm -rf /', enabled: true });
    write(env, 'ok.json', { name: 'ok', when: past, action: 'set-model', model: 'fable', enabled: true });
    await run(env, (j) => fired.push(j.name));
    assert.ok(!fired.includes('evil'), '白名单外的 action 必须拒绝');
    assert.ok(fired.includes('ok'));
    fs.rmSync(env.dir, { recursive: true, force: true });
  });

  test('cron 宏被识别为周期任务而非一次性时间', async () => {
    const env = mkEnv();
    const fired = [];
    write(env, 'daily.json', { name: 'daily', when: '@daily', prompt: 'x', enabled: true });
    await run(env, (j) => fired.push(j.name));
    const st = JSON.parse(fs.readFileSync(env.state, 'utf8'));
    assert.equal(st['daily.json']?.status, 'baseline', '@daily 该登记基线，而不是被当成非法日期永不触发');
    assert.deepEqual(fired, [], '首次发现只登记基线，不补跑');
    fs.rmSync(env.dir, { recursive: true, force: true });
  });

  test('改了 when 之后不会立刻补跑上一个时间点', async () => {
    const env = mkEnv();
    const fired = [];
    write(env, 'j.json', { name: 'j', when: '0 9 * * *', prompt: 'x', enabled: true });
    await run(env, (j) => fired.push(j.name));
    assert.deepEqual(fired, [], '首次只登记基线');
    write(env, 'j.json', { name: 'j', when: '0 10 * * *', prompt: 'x', enabled: true }); // 改期
    await run(env, (j) => fired.push(j.name));
    assert.deepEqual(fired, [], '改期只应重新登记基线，不该立刻触发一次');
    fs.rmSync(env.dir, { recursive: true, force: true });
  });
});

describe('调度器并发（行为断言）', () => {
  const mk = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'schedc-'));
    const jobs = path.join(dir, 'jobs');
    fs.mkdirSync(jobs, { recursive: true });
    return { dir, jobs, state: path.join(dir, 'state.json') };
  };
  const localWhen = (ms) => {
    const d = new Date(Date.now() + ms);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  };

  test('一个长任务不会把同期到点的任务饿死', async () => {
    const env = mk();
    const past = localWhen(-60_000);
    fs.writeFileSync(path.join(env.jobs, 'slow.json'), JSON.stringify({ name: 'slow', when: past, prompt: 'x', enabled: true }));
    fs.writeFileSync(path.join(env.jobs, 'fast.json'), JSON.stringify({ name: 'fast', when: past, prompt: 'x', enabled: true }));
    const done = [];
    const h = startScheduler({
      schedulesDir: env.jobs,
      stateFile: env.state,
      onFire: async (j) => {
        // 慢任务模拟周报：早先的全局重入闸会让 fast 一直等它
        if (j.name === 'slow') await new Promise((r) => setTimeout(r, 400));
        done.push(j.name);
      },
    });
    await h.whenIdle();
    h.stop();
    assert.deepEqual(done.sort(), ['fast', 'slow'], '两个都该在同一轮里跑到');
    assert.equal(done[0], 'fast', '快的先完成，说明没有被慢的挡住');
    fs.rmSync(env.dir, { recursive: true, force: true });
  });

  test('同一任务不会被重复触发', async () => {
    const env = mk();
    const past = localWhen(-60_000);
    fs.writeFileSync(path.join(env.jobs, 'j.json'), JSON.stringify({ name: 'j', when: past, prompt: 'x', enabled: true }));
    let count = 0;
    const h = startScheduler({
      schedulesDir: env.jobs,
      stateFile: env.state,
      onFire: async () => { count++; await new Promise((r) => setTimeout(r, 100)); },
    });
    await h.whenIdle();
    h.stop();
    assert.equal(count, 1);
    fs.rmSync(env.dir, { recursive: true, force: true });
  });
});
