# 企业微信 ⇆ Claude 机器人部署手册

> **给 Claude 的指令**：按步骤 0→9 顺序执行。人工动作：步骤 0 登录 Claude、步骤 6 在企业微信后台建应用取凭据并保存回调配置。
>
> **效果**：企业微信里给自建应用发消息 → 本机 Claude Code 回答（文本/图片/文件，语音需租户开启转文字），会话持久续聊。
>
> ⚠️ 企业微信没有长连接模式，**回调 URL 必须公网可访问**：有公网服务器/反代最好；没有就用 cloudflared 隧道（步骤 7 有命令）。前置：macOS 或 Windows、Node ≥ 18。

## 步骤 0：安装/更新 Claude Code CLI 并登录

```bash
npm install -g @anthropic-ai/claude-code
claude --version
```

然后**必须执行**登录引导：运行 `claude /login`，终端会自动弹出登录链接/二维码——**把登录链接原样呈现给用户，让用户在浏览器完成授权**。用户确认登录完成后再继续；已登录机器向用户确认沿用即可。

## 步骤 1：初始化项目

```bash
mkdir -p ~/wecom-claude-bridge/src ~/wecom-claude-bridge/scripts/windows ~/wecom-claude-bridge/workspace
cd ~/wecom-claude-bridge
npm init -y
npm pkg set type=module scripts.start="node src/index.js"
npm install fast-xml-parser dotenv cross-spawn
```

## 步骤 2：写入 `.env` 与 `.gitignore`

`.env`（前五项待步骤 6 从企业微信后台取得后填入）：

```bash
WECOM_CORP_ID=
WECOM_AGENT_ID=
WECOM_SECRET=
WECOM_TOKEN=
WECOM_AES_KEY=
PORT=3979
CALLBACK_PATH=/wecom/callback

ALLOWED_TOOLS=Read,Grep,Glob,WebSearch,WebFetch,Write(./memory/**),Edit(./memory/**),Write(./skills/**),Edit(./skills/**)   # owner 可用工具（含记忆/技能落盘）
NON_OWNER_TOOLS=WebSearch,WebFetch                # 其他成员可用工具
CLAUDE_MODEL=                                     # 留空=默认；可填 haiku/sonnet/opus
CLAUDE_TIMEOUT_MS=300000
```

`.gitignore`：

```
node_modules/
.env
data/
workspace/
bridge.log
.DS_Store
```

## 步骤 2b：写入 Agent 工作区（长期记忆 + 技能沉淀）

```bash
mkdir -p workspace/memory workspace/skills
```

写入 `workspace/CLAUDE.md` 与 `workspace/memory/MEMORY.md`——内容从本仓库对应文件原样复制（[workspace/CLAUDE.md](../workspace/CLAUDE.md)、[workspace/memory/MEMORY.md](../workspace/memory/MEMORY.md)；git clone 部署则已自带）。作用：机器人获得跨会话长期记忆（对它说「记住…」自动落盘）与技能自动沉淀（说「存成技能」自动生成 SKILL.md，桥接会同步到 .claude/skills 供后续会话加载）。

## 步骤 3：写入 `src/store.js` 与 `src/claude.js`

这两个文件与姊妹项目完全一致，从 [feishu-claude-bridge](https://github.com/demry-max/feishu-claude-bridge/tree/main/src) 的 `src/store.js`、`src/claude.js` 原样复制。

## 步骤 4：写入 `src/wxcrypt.js` 与 `src/index.js`

从本仓库 [src/wxcrypt.js](../src/wxcrypt.js)（回调 AES 解密 + SHA1 验签）与 [src/index.js](../src/index.js)（回调 HTTP 服务、URL 校验、消息解析、素材下载、主动发消息回复、owner 鉴权、去重与串行队列）原样复制。若无法访问仓库，向用户索取文件内容。

## 步骤 5：验证 claude CLI

```bash
cd ~/wecom-claude-bridge/workspace && claude -p --output-format json --model haiku "只回复两个字：正常"
```

预期 `result` 为「正常」；报 401 则回步骤 0 重新登录。

## 步骤 6：企业微信后台建应用（人工，约 5 分钟）

引导用户到 [work.weixin.qq.com](https://work.weixin.qq.com/) 管理后台：

1. **我的企业** → 记下「企业 ID」→ 填 `.env` 的 `WECOM_CORP_ID`
2. **应用管理 → 创建自建应用**（名称如「Claude 助手」）→ 记下 **AgentId** 和 **Secret** → 填 `WECOM_AGENT_ID` / `WECOM_SECRET`
3. 应用详情 → **接收消息 → 设置 API 接收**：自定义 **Token**、点「随机生成」**EncodingAESKey**，两者填入 `.env`；回调 URL 填 `https://<公网地址>/wecom/callback`——**先不要点保存**（保存时会实时校验 URL，需等步骤 8 服务跑起来）

## 步骤 7：启动服务（含公网隧道）

```bash
cd ~/wecom-claude-bridge && npm start
```

若没有公网服务器，另开一个终端起 cloudflared 免费隧道：

```bash
# macOS: brew install cloudflared / Windows: winget install Cloudflare.cloudflared
cloudflared tunnel --url http://localhost:3979
```

把输出的 `https://xxx.trycloudflare.com/wecom/callback` 作为回调 URL（注意：免费隧道每次重启域名会变，正式使用建议固定域名反代到本机 3979）。

## 步骤 8：保存回调配置并验证

让用户回到步骤 6 的「接收消息」页点**保存**——服务日志出现 `[verify] 回调 URL 校验通过` 即配置成功。然后在企业微信里打开该应用发「你好」，**第一个发消息者自动登记为 owner**，收到回复即部署完成。

## 步骤 9：常驻自启

与 [feishu-claude-bridge 手册步骤 11](https://github.com/demry-max/feishu-claude-bridge/blob/main/docs/%E9%A3%9E%E4%B9%A6-Claude-%E6%9C%BA%E5%99%A8%E4%BA%BA%E6%9E%B6%E8%AE%BE%E6%96%B9%E6%A1%88.md) 相同：macOS 用 launchd（`examples/launchd.example.plist`，路径与 Label 换成 wecom-claude-bridge），Windows 用 `scripts/windows/install-startup.ps1`。cloudflared 隧道同样需要常驻（`cloudflared service install` 或同款自启方式）。

---

## 附录：使用与排查

| 项目 | 说明 |
|------|------|
| 用法 | 企业微信打开应用直接对话；图片/文件可发；`/new` 开新会话；`/status` 查状态 |
| 群聊 | 自建应用消息通道仅支持单聊（企业微信群机器人 webhook 只能发不能收，平台限制） |
| 语音 | 仅当企业微信消息带 Recognition 转写字段时支持，否则提示改发文字 |
| 保存回调失败 | 确认服务在跑、隧道地址正确、`.env` 的 Token/EncodingAESKey 与后台完全一致 |
| 无响应 | 查服务日志；确认签名校验未报错；免费隧道域名重启后会变，需回后台更新 |
| 提示登录过期 | 主机终端 `claude /login`；根治：`claude setup-token` 长期令牌写入 `.env` 的 `CLAUDE_CODE_OAUTH_TOKEN=` |
| 安全红线 | `.env` 不入库不外发；不给无人值守机器人开 Write/Bash；不用 `--dangerously-skip-permissions` |
