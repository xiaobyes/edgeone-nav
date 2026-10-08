# 小白的导航 · EdgeOne Makers 版

把原来的 **Cloudflare Worker 单文件版**导航站移植到 **腾讯云 EdgeOne Makers**，并把 **Workers KV 换成 EdgeOne Blob 存储**。

前端功能保持不变：搜索（谷歌/必应/百度/本站）、分类与卡片管理、拖拽排序、私密链接、访客登录、主题皮肤（tweakcn / 导入导出）、站点图标、一键存活检测、导入导出、自动备份。

---

## 目录结构

```
.
├── index.html                          # 前端（原 HTML_CONTENT，改成静态文件）
├── cloud-functions/
│   └── api/
│       └── [[default]].js              # 后端：全部 /api/* 接口（Node.js 20）
├── package.json                        # 仅一个依赖：@edgeone/pages-blob
├── .gitignore
└── README.md
```

路由规则（EdgeOne Makers 文件系统路由）：

| 文件 | 路由 |
| --- | --- |
| `index.html` | `/`（静态资源优先） |
| `cloud-functions/api/[[default]].js` | `/api/*`（catch-all） |

> 因为后端挂在 `cloud-functions/api/` 下，**前端所有 `/api/xxx` 调用路径都不用改**——这也是没有把函数放进 `cloud-functions/<应用名>/` 子目录的原因（那样会多出一层路由前缀）。

---

## 与原 Cloudflare 版本的差异

| 原实现 | EdgeOne 实现 | 说明 |
| --- | --- | --- |
| `env.CARD_ORDER`（Workers KV） | `@edgeone/pages-blob` 的 `getStore()` | 见下方「数据存储」 |
| KV 的 `metadata` | 元数据写进值本身 | 例如限流记录 `{attempts, expiredAt}` |
| KV 的 `expirationTtl` | 值内记录 `expiredAt`，读取时判断并清零 | Blob 没有 TTL |
| KV 的 `list({prefix, ...})` | `store.list({ prefix })` | Blob 默认自动翻页 |
| `HTMLRewriter`（抓 favicon） | 有上限地读取 `<head>` + 正则解析 `<link rel=icon>` | Node.js 运行时没有 `HTMLRewriter` |
| `caches.default`（CDN 缓存） | 进程内 TTL 缓存 + 浏览器 `Cache-Control` | 图标缓存一周、主题代理缓存 5 分钟 |
| `caches.default` 做 getLinks 缓存 | 直接读 Blob（`consistency: 'strong'`） | 换来「保存后立刻可见」，不再有最长 60 秒的旧数据 |
| 服务端把主题注入 `__PUBLISHED_THEME__` | 前端启动时 `fetch('/api/getTheme')` | 静态托管没有服务端注入，代价是首次访问可能有极短的主题闪动 |
| `__rev__` 版本号 + 缓存键 | 已移除 | 没有 CDN 缓存后不再需要 |
| 请求体上限 8MB | 5MB | 平台单请求体上限 6MB |
| `CF-Connecting-IP` | `context.clientIp` | 取不到时回退 `x-forwarded-for` |

### 顺带修掉的问题

1. **主题字体永远同步失败**：原服务端只接受 `fonts` 为字符串、前端却提交对象，两边都对不上。现在服务端同时接受字符串和 `{ sans }` 对象。
2. **主题变量 64 字符截断**：原服务端丢弃长度 >64 的取值，而前端允许 160，导致字体栈等长值被静默丢掉。现已统一到 160，并在服务端补上与前端口径一致的字符白名单。
3. **手工备份无上限**：`/api/backupData` 每次调用都会新增一个 KV/Blob 键且从不清除。现在自动备份与手工备份都只保留最近 10 份。
4. **SSRF 黑名单不全**：图标代理是免登录的出站请求入口，原黑名单漏了 IPv6 回环（`[::1]`）、`0.0.0.0`、整数型 IP（`http://2130706433/`）和十六进制型 IP。已补齐。
5. **`/api/getLinks` 缺 CORS 头**：与其它接口不一致，配置 `ALLOWED_ORIGINS` 后跨域前端拿不到 `Access-Control-Allow-Origin`。已补。
6. **模块级 `EMPTY_DATA` 被就地修改**：原代码在 KV 读失败时会把共享常量当数据对象写。现在返回全新对象。

---

## 数据存储（Blob）

存储桶（namespace）默认名 **`nav-store`**，可用环境变量 `BLOB_STORE_NAME` 改。
`getStore({ name: 'nav-store', consistency: 'strong' })` 首次调用会**自动创建**命名空间，一般不需要在控制台手工建；若因额度/权限失败，到控制台「Blob 存储」手动建一个同名存储桶再重新部署即可。

键结构：

```
data/<用户>/links.json         # 站点数据（分类 + 链接）
data/<用户>/theme.json         # 已发布主题（含 name/kind/source/updatedAt）
data/<用户>/site-icon.json     # 站点图标
data/<用户>/keygen.json        # 会话代次（登出后 +1，旧令牌立即失效）
limits/login/<IP>.json         # 管理员登录失败计数（自带过期时间）
limits/guest/<IP>.json         # 访客登录失败计数
backups/<用户>/nav-<时间戳>.json  # 备份，最多保留 10 份
```

所有读取都使用 `consistency: 'strong'`，写后立刻可读，不会出现「刚保存刷新又变回去」。

---

## 环境变量

在 EdgeOne Makers 控制台 → 项目 → 环境变量中配置：

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `JWT_SECRET` | ✅ | 至少 32 字符的随机串，用于签名令牌。**不要提交到仓库**。 |
| `ADMIN_PASSWORD` | ✅ | 管理员密码，至少 8 字符。 |
| `GUEST_PASSWORD` | — | 访客密码；留空则关闭访客登录。 |
| `DEFAULT_USER` | — | 数据命名空间，默认 `testUser`。想换一套独立数据就改这里。 |
| `ICON_API` | — | 第三方图标接口，默认 `https://api.xinac.net/icon/?url=`。 |
| `PREFER_ICON_API` | — | `true`（默认）先走上面的第三方接口；`false` 直接用站点自己的 favicon（**更保护隐私，私密书签的域名不会发给第三方**）。 |
| `BLOB_STORE_NAME` | — | Blob 存储桶名，默认 `nav-store`。 |
| `ALLOWED_ORIGINS` | — | 允许跨域的前端源，逗号分隔；同源部署不用填。 |

生成一个够强的密钥：

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

配置缺失时后端会快速失败并返回 500，响应里会写明缺了哪一项。

---

## 部署到 EdgeOne Makers（GitHub 导入）

1. **推送到 GitHub**

   ```bash
   cd edgeone-nav
   git init
   git add .
   git commit -m "feat: 小白的导航 EdgeOne Makers 版（Blob 存储）"
   git branch -M main
   git remote add origin https://github.com/<你的账号>/<仓库名>.git
   git push -u origin main
   ```

2. **在 Makers 控制台建项目**
   打开 [EdgeOne Makers 控制台](https://console.cloud.tencent.com/edgeone/pages)（国际站为 console.intl.cloud.tencent.com）→ 新建项目 → **导入 Git 仓库** → 选中刚推送的仓库。

3. **构建配置**

   - 框架预设：**其他 / 静态站点**（不要选 Next.js 等）
   - 构建命令：**留空**
   - 输出目录：**根目录 `.`**

   > 首页若返回 404，先检查这里的输出目录是不是根目录。

4. **环境变量**：填 `JWT_SECRET` 与 `ADMIN_PASSWORD`（其它可留空）。

5. **部署**，等待完成后打开分配的域名。

### 或者用 EdgeOne CLI 部署

```bash
npm install -g edgeone@latest      # 需要 ≥ 1.6.0
edgeone login --site china         # 或 --site global

cd edgeone-nav
npm install
edgeone makers deploy -n my-nav
```

> ⚠️ 本项目用了 Blob 存储，**不能用「免登录部署」**：那种模式拿不到存储凭据，页面能开但数据会全部读不到。请先登录。

---

## 本地开发

```bash
npm install
edgeone makers link                       # Blob 需要先把本地目录关联到线上项目
edgeone makers dev -n my-nav --skip-env-sync   # 本机 http://localhost:8088
```

Blob 在本地也是读写线上命名空间，所以 `link` 这一步不能跳过。

---

## 首次使用

1. 打开站点 → 右上角「设置」→「登录 / 退出」→ 输入 `ADMIN_PASSWORD`。
2. 登录后进入「编辑模式」，即可新建分类、添加卡片、拖拽排序、标记私密链接。
3. 「主题皮肤」「本站图标设置」「一键检测」「导出/导入配置」同样在登录后可用。

### 从 Cloudflare 版本搬迁数据

在原站点（Cloudflare 版）登录 → 设置 → **导出配置**，得到 `nav_export_日期.json`；在新站点登录后 → 设置 → **导入配置** → 选择该文件即可。

注意：导出文件只含站点数据；**主题和站点图标不在其中**，需要在新站点重新选一次（主题也可以先用「导出主题」→ 在新站点「导入主题」）。

---

## 平台限制（EdgeOne Makers Cloud Functions）

| 项目 | 限制 |
| --- | --- |
| 运行时 | Node.js 20.x，ESM |
| 单请求体 | 6 MB（代码内已限 5 MB） |
| 单次执行 | 120 秒 |
| 代码包 | 128 MB |
| Blob | 免费额度 1 GB |

首次访问时，每个书签图标都会经 `/api/icon` 抓取一次；之后由浏览器缓存一周，同一实例内还有 10 分钟的内存缓存。

---

## 可选加固（未默认启用，行为保持不变）

1. **访客令牌不可吊销**：访客 JWT 不带 `kid` 也不校验会话代次，所以登出或更换 `GUEST_PASSWORD` 后，已发出的访客令牌在 30 天内仍然有效。要收紧的话，在 `cloud-functions/api/[[default]].js` 里：
   - `validateGuestToken()` 增加 `const gen = await currentKeyGen(env); if (!payload.kid || payload.kid !== gen) return { isValid: false };`
   - `handleGuestLogin()` 签发时加上 `kid: await currentKeyGen(env)`
   代价是：管理员一旦「退出登录」，所有访客也会被踢下线需要重新验证。

2. **前端小问题**（`index.html`）：
   - `dragStart()` 只设置了 `effectAllowed`、没调 `dataTransfer.setData()`，Firefox 下卡片拖拽不会启动；加一行 `try { e.dataTransfer.setData('text/plain', this.getAttribute('data-url') || ''); } catch (_) {}` 即可。
   - `renderStatus()` 里 `if (!isLocal && latency > 1000)` 是死分支（探测结果 `source` 恒为 `'local'`），所以超过 1 秒的站点只会显示「慢」，永远不会显示「离线」。想分级就把 `!isLocal` 去掉。
   - `checkAllSites()` 用了原生 `alert()`，与全站 `customAlert` 风格不一致，部分内嵌浏览器会屏蔽。

3. **想要零闪动的主题注入**：现在 `/` 是静态文件，主题由前端启动时拉取（首次访问可能有几十毫秒的默认配色）。若要求完全无闪动，可以加一个 `middleware.js` 把 `/` 重写到后端渲染路由，由函数把主题注入 HTML——需要额外维护一份 HTML 模板，本项目没有采用。

---

## 排错

| 现象 | 原因 / 处理 |
| --- | --- |
| 接口全部返回 500，body 里有 `messages` | 环境变量缺失：按提示补 `JWT_SECRET`（≥32 字符）/ `ADMIN_PASSWORD`（≥8 字符） |
| 页面能打开但列表一直加载失败 | 存储没绑上：确认用了登录态部署，并在控制台看到一个名为 `nav-store` 的 Blob 存储 |
| 首页 404，但 `/api/getTheme` 正常 | 构建配置里的输出目录不是根目录，改成 `.` |
| 登录提示已被限制 | 同一 IP 连续 5 次密码错误会锁定 15 分钟 |
| 换设备后主题/字体没跟着变 | 主题需要登录后保存（`/api/saveTheme`）；未登录的临时换肤只存在浏览器本地 |
| 图标大面积变成白块 | 目标站点没有可用的 favicon，或第三方图标接口不可用；可把 `PREFER_ICON_API` 设为 `false` 改用站点自带 favicon |

---

## 许可

MIT
