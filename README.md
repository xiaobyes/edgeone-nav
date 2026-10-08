# 个人导航页 · EdgeOne Makers 版

本项目基于 [lineagett/cf-workers-nav](https://github.com/lineagett/cf-workers-nav) 移植而来，源项目是一个部署在 Cloudflare Workers 上的轻量化导航页面，集成了书签管理、图标自动获取、拖拽排序、私密链接保护、主题换肤等功能。
把原来的 Cloudflare Worker 单文件版导航站移植到腾讯云 EdgeOne Makers，并把 Workers KV 换成 EdgeOne Blob 存储。

---

## 界面预览

以下预览图来自源项目 [lineagett/cf-workers-nav](https://github.com/lineagett/cf-workers-nav)，移植版本 UI 保持一致。

### 卡片视图

| default | claude |
|---|---|
| ![default](./images/default.webp) | ![claude](./images/claude.webp) |

### APP 视图

| amethyst-haze | graphite（编辑面板） |
|---|---|
| ![amethyst-haze](./images/app_amethyst-haze.webp) | ![graphite](./images/app_edit_graphite.webp) |

### 主题面板

![theme-panel](./images/theme-panel.webp)

---

## 目录结构

```
.
├── index.html              # 前端（原 HTML_CONTENT，改成静态文件）
├── cloud-functions/
│   └── api/
│       └── [[default]].js  # 后端：全部 /api/* 接口（Node.js 20）
├── package.json            # 仅一个依赖：@edgeone/pages-blob
├── .gitignore
└── README.md
```

**路由规则**（EdgeOne Makers 文件系统路由）：

| 文件 | 路由 |
|---|---|
| `index.html` | `/`（静态资源优先） |
| `cloud-functions/api/[[default]].js` | `/api/*`（catch-all） |

因为后端挂在 `cloud-functions/api/` 下，前端所有 `/api/xxx` 调用路径都不用改。

---

## 功能特性

前端功能与原 Cloudflare 版本保持一致，包括：

- **聚合搜索**：谷歌 / 必应 / 百度 / 本站快捷搜索
- **分类与卡片管理**：在线添加、编辑、删除链接
- **拖拽排序**：PC 端鼠标拖拽 + 移动端长按拖拽
- **私密链接**：仅在管理员登录后可见
- **访客登录**：支持配置访客密码
- **主题皮肤**：内置主题 + tweakcn 社区主题，支持导入 / 导出
- **站点图标**：自动获取 favicon，支持自定义图标 API
- **一键存活检测**：批量检测链接可用性
- **数据管理**：JSON 导入 / 导出，自动备份（保留最近 10 份）

---

## 与原 Cloudflare 版本的核心差异

| 原实现 | EdgeOne 实现 | 说明 |
|---|---|---|
| `env.CARD_ORDER`（Workers KV） | `@edgeone/pages-blob` 的 `getStore()` | 存储层替换 |
| KV 的 `metadata` | 元数据写进值本身 | 例如限流记录 `{attempts, expiredAt}` |
| KV 的 `expirationTtl` | 值内记录 `expiredAt`，读取时判断并清零 | Blob 没有 TTL |
| KV 的 `list({prefix, ...})` | `store.list({ prefix })` | Blob 默认自动翻页 |
| `HTMLRewriter`（抓 favicon） | 有上限地读取 + 正则解析 | Node.js 运行时没有 `HTMLRewriter` |
| `caches.default`（CDN 缓存） | 进程内 TTL 缓存 + 浏览器 `Cache-Control` | 图标缓存一周、主题代理缓存 5 分钟 |
| `caches.default` 做 `getLinks` 缓存 | 直接读 Blob（`consistency: 'strong'`） | 换来“保存后立刻可见”，不再有最长 60 秒的旧数据 |
| 服务端把主题注入 `__PUBLISHED_THEME__` | 前端启动时 `fetch('/api/getTheme')` | 静态托管没有服务端注入，代价是首次访问可能有极短的主题闪动 |
| `__rev__` 版本号 + 缓存键 | 已移除 | 没有 CDN 缓存后不再需要 |
| 请求体上限 8MB | 5MB | 平台单请求体上限 6MB |
| `CF-Connecting-IP` | `context.clientIp` | 取不到时回退 `x-forwarded-for` |

---

## 顺带修掉的源项目问题

移植过程中一并修复了以下源项目中的问题：
- **修改添加**：增加了页脚，增加了访客密码功能，访客输入密码后可以看到隐藏分类。增加了自定议本部LOGO功能。增加了隐藏分类功能。默认搜索改为google。
- **主题字体同步失败**：原服务端只接受 `fonts` 为字符串、前端却提交对象，两边格式不匹配。现在服务端同时接受字符串和 `{ sans }` 对象。
- **主题变量 64 字符截断**：原服务端丢弃长度 >64 的取值，而前端允许 160，导致字体栈等长值被静默丢掉。现已统一到 160，并在服务端补上与前端口径一致的字符白名单。
- **手工备份无上限**：`/api/backupData` 每次调用都会新增一个 KV/Blob 键且从不清除。现在自动备份与手工备份都只保留最近 10 份。
- **SSRF 黑名单不全**：图标代理是免登录的出站请求入口，原黑名单漏了 IPv6 回环（`[::1]`）、`0.0.0.0`、整数型 IP（`http://2130706433/`）和十六进制型 IP。已补齐。
- **`/api/getLinks` 缺 CORS 头**：与其它接口不一致，配置 `ALLOWED_ORIGINS` 后跨域前端拿不到 `Access-Control-Allow-Origin`。已补。
- **模块级 `EMPTY_DATA` 被就地修改**：原代码在 KV 读失败时会把共享常量当数据对象写。现在返回全新对象。

---

## 数据存储（Blob）

存储桶（namespace）默认名 `nav-store`，可用环境变量 `BLOB_STORE_NAME` 改。

```js
getStore({ name: 'nav-store', consistency: 'strong' })
```

首次调用会自动创建命名空间，一般不需要在控制台手工建；若因额度/权限失败，到控制台「Blob 存储」手动建一个同名存储桶再重新部署即可。

**键结构：**

```
data/<用户>/links.json          # 站点数据（分类 + 链接）
data/<用户>/theme.json          # 已发布主题（含 name/kind/source/updatedAt）
data/<用户>/site-icon.json      # 站点图标
data/<用户>/keygen.json         # 会话代次（登出后 +1，旧令牌立即失效）
limits/login/.json              # 管理员登录失败计数（自带过期时间）
limits/guest/.json              # 访客登录失败计数
backups/<用户>/nav-<时间戳>.json  # 备份，最多保留 10 份
```

所有读取都使用 `consistency: 'strong'`，写后立刻可读，不会出现“刚保存刷新又变回去”。

---

## 环境变量

在 EdgeOne Makers 控制台 → 项目 → 环境变量中配置：

| 变量 | 必填 | 说明 |
|---|---|---|
| `JWT_SECRET` | ✅ | 至少 32 字符的随机串，用于签名令牌。不要提交到仓库。 |
| `ADMIN_PASSWORD` | ✅ | 管理员密码，至少 8 字符。 |
| `GUEST_PASSWORD` | — | 访客密码；留空则关闭访客登录。 |
| `DEFAULT_USER` | — | 数据命名空间，默认 `testUser`。想换一套独立数据就改这里。 |
| `ICON_API` | — | 第三方图标接口，默认 `https://api.xinac.net/icon/?url=`。 |
| `PREFER_ICON_API` | — | `true`（默认）先走第三方接口；`false` 直接用站点自己的 favicon（更保护隐私，私密书签的域名不会发给第三方）。 |
| `BLOB_STORE_NAME` | — | Blob 存储桶名，默认 `nav-store`。 |
| `ALLOWED_ORIGINS` | — | 允许跨域的前端源，逗号分隔；同源部署不用填。 |

生成一个够强的密钥：

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

配置缺失时后端会快速失败并返回 500，响应里会写明缺了哪一项。

> **注意（老版本升级提醒）：**
> - 旧版本如果**未配置 `JWT_SECRET`**，或配置的 `JWT_SECRET` **小于 32 个字符**，必须重新配置一个 **≥32 字符** 的随机字符串。
> - 旧版本如果 **`ADMIN_PASSWORD` 小于 8 个字符**，请一并更新为 **至少 8 个字符** 的新密码。
> - 修改后需重新部署使配置生效。

---

## 部署到 EdgeOne Makers（GitHub 导入）

### 1. 推送到 GitHub

```bash
cd edgeone-nav
git init
git add .
git commit -m "feat: 小白的导航 EdgeOne Makers 版（Blob 存储）"
git branch -M main
git remote add origin https://github.com/<你的账号>/<仓库名>.git
git push -u origin main
```

### 2. 在 Makers 控制台建项目

打开 [EdgeOne Makers 控制台](https://console.cloud.tencent.com/edgeone/pages)（国际站为 `console.intl.cloud.tencent.com`）→ 新建项目 → 导入 Git 仓库 → 选中刚推送的仓库。

### 3. 构建配置

- 框架预设：**其他 / 静态站点**（不要选 Next.js 等）
- 构建命令：**留空**
- 输出目录：**根目录**

> 首页若返回 404，先检查这里的输出目录是不是根目录。

### 4. 环境变量

填 `JWT_SECRET` 与 `ADMIN_PASSWORD`（其它可留空）。

### 5. 部署

等待完成后打开分配的域名即可。

---

## 致谢

- 源项目：[lineagett/cf-workers-nav](https://github.com/lineagett/cf-workers-nav)
- [腾讯云 EdgeOne](https://edgeone.cloud.tencent.com/)
- [tweakcn](https://tweakcn.com)（主题库与社区主题）
- [hmhm2022](https://github.com/hmhm2022)
- [xinac](https://api.xinac.net/)（图标 API）

---

## 许可

本项目为源项目 [lineagett/cf-workers-nav](https://github.com/lineagett/cf-workers-nav) 的 EdgeOne 平台移植版本，请遵循源项目的开源许可。
