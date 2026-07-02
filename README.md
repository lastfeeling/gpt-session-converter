# ChatGPT / Codex 本地转 CPA / sub2api

单文件离线工具。在浏览器里把 **ChatGPT session JSON / Codex `auth.json` / CPA JSON / JSONL / sub2api bundle** 转换成 **CPA（CLIProxyAPI / Codex auth）** 或 **sub2api 批量导入格式**。

- 🔒 **纯前端、零上传**：所有解析和转换都在浏览器本地完成，不请求任何接口，不加载外部脚本。
- 🧩 **多种输入**：单个 JSON、多行 JSONL、Codex `auth.json`、CPA JSON、sub2api 导出的数组，自动识别。
- 📦 **两种输出**：
  - **CPA**：单账号导出一个 `auth.json`；多账号打包成 `cpa_accounts.tar`，包内每个账号一个 JSON。
  - **sub2api**：合并为一个数组 `sub2api.json`，可直接批量导入。
- 🪪 **回填 claims**：可从 JWT 自动解析 `email` / `account_id` / 过期时间。
- ☁️ **部署在 Cloudflare Workers**（静态资源模式），支持一键部署。

## 一键部署到 Cloudflare

点下面的按钮即可一键部署：

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/lastfeeling/gpt-session-converter)

Cloudflare 会克隆仓库、读取 `wrangler.jsonc`，把 `public/` 目录作为静态资源发布成一个 Worker。全程无需本地安装依赖。

## 推送到 GitHub

```bash
git init
git add .
git commit -m "init: chatgpt/codex -> cpa/sub2api 本地转换工具"
git branch -M main
git remote add origin https://github.com/<你的用户名>/<仓库名>.git
git push -u origin main
```

## 项目结构

```
.
├── public/
│   ├── index.html   # 页面（样式 + 结构）
│   └── app.js       # 全部转换逻辑（本地执行）
├── wrangler.jsonc   # Cloudflare Workers 静态资源配置
├── package.json
└── README.md
```

## 本地预览（可选）

无需构建。任意静态服务器都能打开 `public/`，例如：

```bash
npx wrangler dev
```

或者直接用浏览器打开 `public/index.html`（处理敏感 token 时可断网后打开）。

## 输出格式

**CPA（CLIProxyAPI / Codex auth）**

```json
{
  "type": "codex",
  "id_token": "...",
  "access_token": "...",
  "refresh_token": "...",
  "account_id": "...",
  "last_refresh": "...",
  "email": "...",
  "expired": "..."
}
```

**sub2api bundle**

```json
[
  {
    "name": "demo@example.com",
    "platform": "openai",
    "type": "oauth",
    "credentials": {
      "access_token": "...",
      "id_token": "...",
      "refresh_token": "...",
      "chatgpt_account_id": "...",
      "email": "demo@example.com",
      "expires_at": "..."
    }
  }
]
```

## 说明与边界

- session JSON 通常不含真正的 OAuth `refresh_token`。缺失时 CPA 会写入占位 `rt_0`，JWT 过期后自动刷新可能失效。
- 本工具仅用于本地格式转换，请仅在你有权处理相应账号 / token 的前提下使用，并遵守相关服务条款与当地法律法规。
