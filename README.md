# wecom-claude-bridge

**把 Claude Code 接进企业微信** —— 在企业微信里给自建应用发消息，让 Claude 回答问题、看图片、读文件，并保持上下文连续。

**Chat with Claude Code from WeCom (WeChat Work)** via a self-built app's message callback.

姊妹项目：[feishu-claude-bridge](https://github.com/demry-max/feishu-claude-bridge)（飞书版，免公网）· [dingtalk-claude-bridge](https://github.com/demry-max/dingtalk-claude-bridge)（钉钉版，免公网）

> ⚠️ **平台限制**：企业微信没有长连接/Stream 模式，消息回调**必须有公网可访问的 URL**。没有公网服务器时可用 [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) 或 frp 把本机端口映射出去（手册里有现成命令）。这是三个版本中唯一需要公网入口的。

## 特性

- 🧠 **会话记忆**：每个用户映射一个 Claude session（`--resume` 续聊）；`/new` 重开，`/status` 查看
- 🖼️ **消息类型**：文本 / 图片（Claude 直接看图）/ 文件 / 语音（需企业微信开启语音转文字，带 Recognition 字段时支持）
- 🔐 **权限分级**：首个发消息者自动成为 owner（本机只读工具 + 联网）；其他成员仅联网检索
- 🔒 **官方加解密**：回调消息 AES 解密 + SHA1 签名校验（含单测通过的最小 WXBizMsgCrypt 实现）
- 💰 **用订阅不用 API Key**：`claude -p` 无头模式调用本机 Claude Code 登录态
- 🖥️ **macOS + Windows**（cross-spawn 兼容 `.cmd`）

## 快速开始

**1. 企业微信后台配置**（[work.weixin.qq.com](https://work.weixin.qq.com/) 管理后台 → 应用管理 → 创建**自建应用**）：

1. 记下 **企业 ID（CorpId）**（我的企业页）、应用的 **AgentId / Secret**
2. 应用详情 → 接收消息 → 设置 API 接收：填回调 URL（`https://你的域名/wecom/callback`）、自定义 **Token**、随机生成 **EncodingAESKey**——先别点保存，等服务跑起来再回来点（保存时企业微信会实时校验 URL）

**2. 部署**：

```bash
npm install -g @anthropic-ai/claude-code   # 安装/更新 Claude Code CLI
claude /login                              # 弹出登录链接，浏览器完成授权

git clone https://github.com/demry-max/wecom-claude-bridge.git
cd wecom-claude-bridge
npm install
# 把 CorpId / AgentId / Secret / Token / EncodingAESKey 填入 .env
npm start                                  # 本机 3979 端口

# 没有公网服务器时，用 cloudflared 免费隧道映射：
cloudflared tunnel --url http://localhost:3979
# 输出的 https://xxx.trycloudflare.com + /wecom/callback 即回调 URL
```

回企业微信后台点「保存」通过 URL 校验，然后在企业微信里打开该应用发「你好」。**第一个发消息的人自动成为 owner**。

> 完整手册（可直接丢给 Claude Code 说「按手册部署」）：[docs/企业微信-Claude-机器人部署手册.md](docs/企业微信-Claude-机器人部署手册.md)

## 架构

```
企业微信自建应用消息
        │  HTTPS 回调（AES 加密 XML，签名校验；立即 ack 防重投）
        ▼
桥接服务（Node.js：解密、去重、串行队列、owner 鉴权、素材下载）
        │  spawn: claude -p --resume <会话ID> --allowedTools …（提示词走 stdin）
        ▼
Claude Code CLI（无头模式）→ 主动发消息 API 回复 markdown（降级纯文本）
```

## 安全

- `.env`（Secret/Token/AESKey）与运行数据均被 `.gitignore` 排除
- 回调全量验签，非法请求直接丢弃；非 owner 无本机文件权限
- 默认只授予 Claude 只读工具；勿给无人值守机器人开 Write/Bash

## License

[MIT](LICENSE)
