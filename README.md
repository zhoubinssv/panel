# 🍑 小姨子的诱惑

基于 Node.js + Express + SQLite 的 VLESS 节点管理面板，支持 NodeLoc OAuth 登录、多用户管理、SSH 自动部署、VLESS+Reality 加密、AI 智能运维。

## ✨ 功能

**节点管理**
- SSH 一键部署 xray，支持 VLESS + Reality (XTLS Vision)
- 自动生成 x25519 密钥对，兼容 Xray 26.x
- Socks5 落地支持（家宽中转）
- 多用户 UUID 隔离，自动配置同步
- 节点等级系统（Lv.0-4），按用户信任等级分配节点

**用户系统**
- NodeLoc OAuth2 登录
- 白名单机制（绕过节点等级限制）
- 用户封禁（自动移除所有节点配置）
- 订阅链接支持 v2ray / Clash Meta / sing-box 三种格式

**监控与运维**
- 5 分钟健康检测（端口探测 + 反向检测）
- 自动修复：重启 xray → SSH 诊断 → AI 分析 → TG 通知
- 独立运维 AI 配置（支持 OpenAI / Gemini / Claude）
- 手动诊断 + 修复命令确认执行
- 10 分钟流量采集，每日流量统计与排行

**安全**
- AES-256-GCM 加密存储敏感信息
- CSRF 防护、HSTS、Helmet 安全头
- 订阅按 IP 限流（5次/分钟），防 token 暴力猜测
- SQL 注入防护（列名白名单）

**其他**
- AI 多会话聊天（流式输出）
- Telegram 通知（登录/离线/轮换/运维/流量超标/订阅异常）
- 每日 3:00 自动 UUID + 订阅 token 轮换
- 滚动公告系统
- 审计日志

## 🛠 技术栈

- **后端**: Node.js + Express + better-sqlite3
- **前端**: EJS + Tailwind CSS（暗色玫瑰主题）
- **部署**: PM2 + Nginx + Cloudflare

## 🚀 部署

```bash
git clone <repo> && cd vless-panel
npm install
cp .env.example .env  # 编辑配置
pm2 start ecosystem.config.js
```

`.env` 必填项：
```
SESSION_SECRET=<随机字符串>
NODELOC_URL=https://www.nodeloc.com
NODELOC_CLIENT_ID=<OAuth Client ID>
NODELOC_CLIENT_SECRET=<OAuth Client Secret>
NODELOC_REDIRECT_URI=https://your-domain/auth/callback
```

Nginx 反代参考：
```nginx
server {
    listen 443 ssl http2;
    server_name your-domain;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header CF-Connecting-IP $http_cf_connecting_ip;
    }
}
```

## 📁 项目结构

```
src/
├── app.js                 # Express 入口，中间件，定时任务
├── middleware/             # auth, rateLimit, csrf
├── routes/
│   ├── auth.js            # OAuth 登录
│   ├── panel.js           # 用户面板 + AI + 订阅
│   ├── admin.js           # 管理后台页面
│   └── adminApi.js        # 管理 REST API
├── services/
│   ├── database.js        # SQLite 数据层
│   ├── deploy.js          # SSH 部署 + 配置同步
│   ├── health.js          # 健康检测 + 自动修复
│   ├── traffic.js         # 流量采集
│   ├── rotate.js          # UUID/Token 轮换
│   ├── ai.js              # 聊天 AI（流式）
│   ├── ops-ai.js          # 运维 AI（独立配置）
│   └── notify.js          # Telegram 通知
└── utils/
    ├── vless.js           # VLESS 链接 + 订阅生成
    ├── crypto.js          # AES-256-GCM 加解密
    └── names.js           # 中文节点名生成器
```

## 📋 管理后台

9 个功能 Tab：🌐 节点 · 👥 用户 · 📊 流量 · 🔒 白名单 · 🧠 AI · 📋 日志 · 🔍 监控 · 🔧 运维 · 🔔 通知

## 📄 License

MIT
