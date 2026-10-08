/**
 * 小白导航 · EdgeOne Makers 后端
 * ---------------------------------------------------------------------------
 * 由 Cloudflare Worker 版本移植：
 *   - Workers KV        → EdgeOne Makers Blob（@edgeone/pages-blob）
 *   - HTMLRewriter      → 正则解析（Node.js 运行时没有 HTMLRewriter）
 *   - caches.default    → 进程内记忆缓存 + 浏览器 Cache-Control
 *   - 服务端注入 HTML   → 改为静态 index.html + 运行时拉取 /api/getTheme
 *
 * 路由：本文件位于 cloud-functions/api/[[default]].js，
 * 按 EdgeOne Makers 的文件系统路由规则，负责全部 /api/* 请求。
 *
 * 运行时：Node.js 20（Cloud Functions）
 */

import { getStore } from '@edgeone/pages-blob';

/* ==========================================================================
 * 1. 配置（Makers 控制台环境变量，兼容 process.env / context.env）
 * ========================================================================== */

const DEFAULTS = {
    USER: 'testUser',
    ICON_API: 'https://api.xinac.net/icon/?url=',
    PREFER_ICON_API: true,
    GUEST_PASSWORD: '',
    BLOB_STORE: 'nav-store'
};

let DEFAULT_USER = DEFAULTS.USER;
let ICON_API = DEFAULTS.ICON_API;
let PREFER_ICON_API = DEFAULTS.PREFER_ICON_API;
let GUEST_PASSWORD = DEFAULTS.GUEST_PASSWORD;
let BLOB_STORE_NAME = DEFAULTS.BLOB_STORE;

function envGet(env, key) {
    try {
        const v = env ? env[key] : undefined;
        if (v !== undefined && v !== null && v !== '') return v;
    } catch (e) { /* ignore */ }
    try {
        const v = (typeof process !== 'undefined' && process.env) ? process.env[key] : undefined;
        if (v !== undefined && v !== null && v !== '') return v;
    } catch (e) { /* ignore */ }
    return undefined;
}

function resolveConfig(env) {
    const user = envGet(env, 'DEFAULT_USER');
    if (user) DEFAULT_USER = String(user);
    const iconApi = envGet(env, 'ICON_API');
    if (iconApi) ICON_API = String(iconApi);
    const prefer = envGet(env, 'PREFER_ICON_API');
    if (prefer !== undefined) PREFER_ICON_API = String(prefer) === 'true';
    const guest = envGet(env, 'GUEST_PASSWORD');
    if (guest) GUEST_PASSWORD = String(guest);
    const storeName = envGet(env, 'BLOB_STORE_NAME');
    if (storeName) BLOB_STORE_NAME = String(storeName);
}

function assertEnv(env) {
    const messages = [];
    const secret = envGet(env, 'JWT_SECRET');
    const admin = envGet(env, 'ADMIN_PASSWORD');
    if (!secret || String(secret).length < 32) messages.push('JWT_SECRET 未配置或强度不足（需 ≥32 字符）');
    if (!admin || String(admin).length < 8) messages.push('ADMIN_PASSWORD 未配置或过短（需 ≥8 字符）');
    if (messages.length > 0) {
        const e = new Error('FATAL: 配置缺失或无效: ' + messages.join('; '));
        e.code = 'CONFIG_ERROR';
        e.messages = messages;
        throw e;
    }
}

/* ==========================================================================
 * 2. Blob 存储（替代 Workers KV）
 *
 * KV 语义 → Blob 语义对照：
 *   kv.get(key)                     → store.get(key, { type: 'text' })（键不存在返回 null）
 *   kv.get(key, 'json')             → 读文本后 JSON.parse
 *   kv.put(key, value)              → store.set(key, value)
 *   kv.put(key, value, {metadata})  → 元数据写进 value 本身
 *   kv.put(..., {expirationTtl})    → 值里记录过期时间，读时判断并重置
 *   kv.delete(key)                  → store.delete(key)
 *   kv.list({prefix})               → store.list({ prefix })（默认自动翻页）
 *
 * 所有 store 一律 consistency: 'strong'，写后立刻可读。
 * ========================================================================== */

const _stores = new Map();

function navStore() {
    const name = BLOB_STORE_NAME || DEFAULTS.BLOB_STORE;
    let s = _stores.get(name);
    if (!s) {
        s = getStore({ name, consistency: 'strong' });
        _stores.set(name, s);
    }
    return s;
}

const KEY = {
    links: (user) => `data/${encodeURIComponent(user)}/links.json`,
    theme: (user) => `data/${encodeURIComponent(user)}/theme.json`,
    siteIcon: (user) => `data/${encodeURIComponent(user)}/site-icon.json`,
    keygen: (user) => `data/${encodeURIComponent(user)}/keygen.json`,
    limit: (scope, ip) => `limits/${scope}/${encodeURIComponent(ip)}.json`,
    backupPrefix: (user) => `backups/${encodeURIComponent(user)}/`,
    backup: (user, stamp) => `backups/${encodeURIComponent(user)}/nav-${stamp}.json`
};

async function blobGetText(store, key) {
    try {
        const v = await store.get(key, { type: 'text' });
        return typeof v === 'string' ? v : null;
    } catch (e) {
        return null;
    }
}

async function blobGetJson(store, key) {
    const text = await blobGetText(store, key);
    if (typeof text !== 'string' || text === '') return null;
    try {
        const v = JSON.parse(text);
        return v && typeof v === 'object' ? v : null;
    } catch (e) {
        return null;
    }
}

async function blobPutText(store, key, text) {
    await store.set(key, String(text));
}

async function blobPutJson(store, key, value) {
    await store.set(key, JSON.stringify(value));
}

async function blobDelete(store, key) {
    try {
        await store.delete(key);
    } catch (e) { /* 删除不存在/失败都不影响主流程 */ }
}

async function blobListKeys(store, prefix) {
    try {
        const res = await store.list({ prefix });
        const blobs = (res && res.blobs) || [];
        return blobs.map((b) => b.key).filter(Boolean);
    } catch (e) {
        return [];
    }
}

/* ==========================================================================
 * 3. 通用工具
 * ========================================================================== */

function base64UrlEncode(str) {
    return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlEncodeUint8(arr) {
    const str = String.fromCharCode(...arr);
    return base64UrlEncode(str);
}

function base64UrlDecode(str) {
    let s = str.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    return atob(s);
}

async function createJWT(payload, secret) {
    const encoder = new TextEncoder();
    const header = { alg: 'HS256', typ: 'JWT' };
    const headerEncoded = base64UrlEncode(JSON.stringify(header));
    const payloadEncoded = base64UrlEncode(JSON.stringify(payload));
    const toSign = encoder.encode(`${headerEncoded}.${payloadEncoded}`);
    const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signature = await crypto.subtle.sign('HMAC', key, toSign);
    const signatureEncoded = base64UrlEncodeUint8(new Uint8Array(signature));
    return `${headerEncoded}.${payloadEncoded}.${signatureEncoded}`;
}

async function validateJWT(token, secret) {
    try {
        const encoder = new TextEncoder();
        const parts = String(token).split('.');
        if (parts.length !== 3) return null;
        const [headerEncoded, payloadEncoded, signature] = parts;
        const data = encoder.encode(`${headerEncoded}.${payloadEncoded}`);
        const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
        const expectedSigBuffer = await crypto.subtle.sign('HMAC', key, data);
        const expectedSig = base64UrlEncodeUint8(new Uint8Array(expectedSigBuffer));
        if (!(await timingSafeStringEqual(signature, expectedSig))) return null;
        return JSON.parse(base64UrlDecode(payloadEncoded));
    } catch (e) {
        return null;
    }
}

let _tseKey = null;
async function timingSafeStringEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    if (!_tseKey) {
        _tseKey = await crypto.subtle.importKey('raw', new TextEncoder().encode('cfile-tse-fixed-key-v1'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    }
    const [ha, hb] = await Promise.all([
        crypto.subtle.sign('HMAC', _tseKey, new TextEncoder().encode(a)),
        crypto.subtle.sign('HMAC', _tseKey, new TextEncoder().encode(b))
    ]);
    const ua = new Uint8Array(ha);
    const ub = new Uint8Array(hb);
    if (ua.length !== ub.length) return false;
    let diff = 0;
    for (let i = 0; i < ua.length; i++) diff |= ua[i] ^ ub[i];
    return diff === 0;
}

function parseCookie(cookieHeader) {
    const cookies = {};
    if (!cookieHeader) return cookies;
    cookieHeader.split(';').forEach((cookie) => {
        const s = cookie.trim();
        if (!s) return;
        const i = s.indexOf('=');
        if (i < 0) return;
        const name = s.slice(0, i).trim();
        const value = s.slice(i + 1).trim();
        try {
            cookies[name] = decodeURIComponent(value);
        } catch (e) {
            cookies[name] = value;
        }
    });
    return cookies;
}

async function validateServerToken(authHeader, env) {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return { isValid: false, status: 401, response: { error: 'Unauthorized', message: '未登录' } };
    }
    const token = authHeader.slice(7);
    const payload = await validateJWT(token, envGet(env, 'JWT_SECRET'));
    if (!payload) return { isValid: false, status: 401, response: { error: 'Invalid', message: 'Token无效' } };
    if (payload.exp < Math.floor(Date.now() / 1000)) return { isValid: false, status: 401, response: { error: 'Expired', message: 'Token过期' } };
    if (payload.type !== 'access') return { isValid: false, status: 403, response: { error: 'Forbidden', message: '令牌类型错误' } };
    const gen = await currentKeyGen(env);
    if (!payload.kid || payload.kid !== gen) return { isValid: false, status: 401, response: { error: 'Revoked', message: '会话已失效，请重新登录' } };
    return { isValid: true, payload };
}

async function validateGuestToken(authHeader, env) {
    if (!GUEST_PASSWORD) return { isValid: false };
    if (!authHeader || !authHeader.startsWith('Bearer ')) return { isValid: false };
    const token = authHeader.slice(7);
    const payload = await validateJWT(token, envGet(env, 'JWT_SECRET'));
    if (!payload) return { isValid: false };
    if (payload.exp < Math.floor(Date.now() / 1000)) return { isValid: false };
    if (payload.type !== 'guest') return { isValid: false };
    return { isValid: true, payload };
}

/* 会话代次：管理员退出登录时 +1，使旧 access/refresh 令牌立即失效 */
let _genCache = { value: null, expireAt: 0 };
async function currentKeyGen(env) {
    const now = Date.now();
    if (_genCache.value !== null && _genCache.expireAt > now) return _genCache.value;
    let v = null;
    try {
        v = await blobGetText(navStore(), KEY.keygen(DEFAULT_USER));
    } catch (e) { /* KV 不可用时退化为默认代次 */ }
    _genCache = { value: (v && String(v).trim()) || '1', expireAt: now + 60000 };
    return _genCache.value;
}

async function bumpKeyGen(env) {
    try {
        const gen = String(Number((await currentKeyGen(env)) || '1') + 1);
        _genCache = { value: gen, expireAt: Date.now() + 60000 };
        await blobPutText(navStore(), KEY.keygen(DEFAULT_USER), gen);
        return gen;
    } catch (e) {
        return null;
    }
}

function jsonResponse(data, status, extraHeaders) {
    return new Response(JSON.stringify(data), {
        status: status || 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...(extraHeaders || {}) }
    });
}

function corsHeaders(request, env) {
    const list = envGet(env, 'ALLOWED_ORIGINS') ? String(envGet(env, 'ALLOWED_ORIGINS')).split(',').filter(Boolean) : [];
    const origin = request ? request.headers.get('Origin') : null;
    if (!origin || !list.includes(origin)) return {};
    return { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true', 'Vary': 'Origin' };
}

/* EdgeOne 的 waitUntil 在 context 上；不存在时退化为普通 Promise */
function background(context, promise) {
    try {
        if (context && typeof context.waitUntil === 'function') {
            context.waitUntil(promise);
            return;
        }
    } catch (e) { /* ignore */ }
    Promise.resolve(promise).catch(() => { });
}

function clientIpOf(context, request) {
    try {
        if (context && context.clientIp) return String(context.clientIp);
    } catch (e) { /* ignore */ }
    const xff = request.headers.get('x-forwarded-for');
    if (xff) return String(xff).split(',')[0].trim() || 'unknown';
    return 'unknown';
}

async function readJsonBody(request, maxBytes = 5 * 1024 * 1024) {
    const len = Number(request.headers.get('content-length') || 0);
    if (len > maxBytes) return { ok: false, reason: 'TOO_LARGE' };
    let text;
    try {
        text = await request.text();
    } catch (e) {
        return { ok: false, reason: 'READ_FAILED' };
    }
    if (text.length > maxBytes) return { ok: false, reason: 'TOO_LARGE' };
    try {
        return { ok: true, data: JSON.parse(text) };
    } catch (e) {
        return { ok: false, reason: 'BAD_JSON' };
    }
}

/* ==========================================================================
 * 4. 登录限流（KV 的 expirationTtl + metadata → 值内自带过期时间）
 * ========================================================================== */

const MAX_ATTEMPTS = 5;
const LOCK_MS = 900 * 1000;

async function readRateLimit(store, key) {
    const rec = await blobGetJson(store, key);
    if (!rec) return { attempts: 0, expiredAt: 0 };
    const attempts = Number(rec.attempts) || 0;
    const expiredAt = Number(rec.expiredAt) || 0;
    if (expiredAt > 0 && expiredAt <= Date.now()) return { attempts: 0, expiredAt: 0 };
    return { attempts, expiredAt };
}

async function writeRateLimit(store, key, attempts, expiredAt) {
    await blobPutJson(store, key, { attempts, expiredAt });
}

async function clearRateLimit(store, key) {
    await blobDelete(store, key);
}

/* 单次失败的处理：返回 Response 或 null（null 表示校验通过） */
async function recordFailedAttempt(store, key, attempts, cors) {
    const newAttempts = attempts + 1;
    const newExpiredAt = Date.now() + LOCK_MS;
    await writeRateLimit(store, key, newAttempts, newExpiredAt);
    const remaining = Math.max(0, MAX_ATTEMPTS - newAttempts);
    if (newAttempts >= MAX_ATTEMPTS) {
        return jsonResponse(
            { valid: false, locked: true, remaining: 0, retryAfter: Math.max(1, Math.ceil((newExpiredAt - Date.now()) / 1000)) },
            429,
            cors
        );
    }
    return jsonResponse({ valid: false, remaining }, 403, cors);
}

function lockedResponse(expiredAt, cors) {
    const waitSec = Math.max(1, Math.ceil((expiredAt - Date.now()) / 1000));
    return jsonResponse({ valid: false, locked: true, remaining: 0, retryAfter: waitSec }, 429, cors);
}

/* ==========================================================================
 * 5. 主题
 * ========================================================================== */

const SAFE_THEME_KEY = /^[A-Za-z0-9-]{1,40}$/;
const SAFE_THEME_VALUE = /^[a-zA-Z0-9#%.,()\/ '"_+-]{1,160}$/;

function sanitizeThemeVars(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const out = {};
    let n = 0;
    for (const k of Object.keys(v)) {
        if (typeof k !== 'string' || !SAFE_THEME_KEY.test(k)) continue;
        const val = v[k];
        if (typeof val !== 'string') continue;
        const sv = val.trim();
        if (!sv || sv.length > 160) continue;
        if (!SAFE_THEME_VALUE.test(sv)) continue;
        out[k] = sv;
        if (++n > 200) break;
    }
    return Object.keys(out).length ? out : null;
}

/* 前端提交的 fonts 既可能是字符串，也可能是 { sans } 对象，两种都要接受 */
function sanitizeFonts(f) {
    let sans = null;
    if (typeof f === 'string') sans = f;
    else if (f && typeof f === 'object' && !Array.isArray(f)) sans = f.sans || f.fontSans || f.fontFamily || f.font || null;
    if (typeof sans !== 'string') return null;
    const sv = sans.trim();
    if (!sv || sv.length > 160) return null;
    if (!SAFE_THEME_VALUE.test(sv)) return null;
    return { sans: sv };
}

function sanitizeThemeData(td) {
    if (!td || typeof td !== 'object' || Array.isArray(td)) return null;
    const light = sanitizeThemeVars(td.light);
    const dark = sanitizeThemeVars(td.dark);
    if (!light && !dark) return null;
    const res = { light: light || dark, dark: dark || light };
    const theme = sanitizeThemeVars(td.theme);
    if (theme) res.theme = theme;
    const fonts = sanitizeFonts(td.fonts);
    if (fonts) res.fonts = fonts;
    return res;
}

const _pubThemeMemo = { value: null, expireAt: 0 };
async function getPublishedTheme(env) {
    const now = Date.now();
    if (_pubThemeMemo.expireAt > now) return _pubThemeMemo.value;
    let theme = null;
    try {
        theme = await blobGetJson(navStore(), KEY.theme(DEFAULT_USER));
    } catch (e) {
        theme = null;
    }
    _pubThemeMemo.value = theme;
    _pubThemeMemo.expireAt = now + 5000;
    return theme;
}

async function handleGetTheme(request, env) {
    const theme = await getPublishedTheme(env);
    return jsonResponse({ ok: true, theme }, 200, { ...corsHeaders(request, env), 'Cache-Control': 'no-cache' });
}

async function handleSaveTheme(request, env) {
    const v = await validateServerToken(request.headers.get('Authorization'), env);
    const cors = corsHeaders(request, env);
    if (!v.isValid) return jsonResponse(v.response, v.status, cors);
    const body = await readJsonBody(request, 40 * 1024);
    if (!body.ok) return jsonResponse({ error: body.reason }, body.reason === 'TOO_LARGE' ? 413 : 400, cors);
    const b = body.data || {};
    let themeData = null;
    if (b.themeData != null) {
        themeData = sanitizeThemeData(b.themeData);
        if (!themeData) return jsonResponse({ error: 'INVALID_THEME' }, 422, cors);
    }
    const rec = {
        themeData,
        name: typeof b.name === 'string' ? b.name.slice(0, 80) : '',
        kind: ['builtin', 'custom', 'ai', 'default'].indexOf(b.kind) >= 0 ? b.kind : 'custom',
        source: typeof b.source === 'string' ? b.source.slice(0, 500) : '',
        updatedAt: Date.now()
    };
    try {
        await blobPutJson(navStore(), KEY.theme(DEFAULT_USER), rec);
    } catch (e) {
        return jsonResponse({ error: 'BLOB_WRITE_FAILED' }, 500, cors);
    }
    _pubThemeMemo.expireAt = 0;
    return jsonResponse({ ok: true, updatedAt: rec.updatedAt }, 200, cors);
}

/* ==========================================================================
 * 6. tweakcn 主题代理（替代 caches.default，改为进程内 TTL 缓存）
 * ========================================================================== */

const THEME_MEMO = new Map();
const THEME_MEMO_TTL = 5 * 60 * 1000;
const THEME_MEMO_MAX = 50;

async function handleThemeProxy(request) {
    const corsTheme = { 'Access-Control-Allow-Origin': '*' };
    const url = new URL(request.url);
    const id = url.searchParams.get('id');
    if (!id) return jsonResponse({ error: 'Missing id' }, 400, corsTheme);
    const hit = THEME_MEMO.get(id);
    if (hit && hit.expireAt > Date.now()) {
        return new Response(hit.body, {
            status: 200,
            headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300, s-maxage=300', ...corsTheme, 'X-Theme-Cache-Status': 'HIT' }
        });
    }
    const targetUrl = 'https://tweakcn.com/r/themes/' + encodeURIComponent(id);
    try {
        const upstream = await fetch(targetUrl, { headers: { 'Accept': 'application/json', 'User-Agent': 'tweakcn-theme-proxy/1.0' } });
        if (!upstream.ok) return jsonResponse({ error: 'upstream ' + upstream.status }, upstream.status, corsTheme);
        const body = await upstream.text();
        if (THEME_MEMO.size >= THEME_MEMO_MAX) {
            const first = THEME_MEMO.keys().next().value;
            if (first !== undefined) THEME_MEMO.delete(first);
        }
        THEME_MEMO.set(id, { body, expireAt: Date.now() + THEME_MEMO_TTL });
        return new Response(body, {
            status: 200,
            headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300, s-maxage=300', ...corsTheme, 'X-Theme-Cache-Status': 'MISS' }
        });
    } catch (e) {
        return jsonResponse({ error: 'failed to fetch theme: ' + e.message }, 502, corsTheme);
    }
}

/* ==========================================================================
 * 7. 图标代理
 *    KV → Blob 之外的第二处平台差异：Node.js 没有 HTMLRewriter，
 *    改为读取 <head>（最多 1MB、遇到 </head> 即停）后用正则提取 <link rel="icon">
 * ========================================================================== */

const ICON_SCHEME_OK = new Set(['http:', 'https:']);
const HOST_DENY = /(^|\.)(localhost|127\.|0\.0\.0\.0$|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|metadata\.google|i-1\.internal)/i;
const ICON_CT_OK = /^image\/(png|jpeg|gif|webp|ico|x-icon|vnd\.microsoft\.icon|avif|bmp)/i;
const FETCH_ICON_MAX_HTML = 1 * 1024 * 1024;
const ICON_FETCH_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8'
};

/* SSRF 防护：拒绝回环/内网/链路本地，含 IPv6 与整数、十六进制写法 */
function isDeniedHost(hostname) {
    const h = String(hostname || '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
    if (!h) return true;
    if (HOST_DENY.test(h)) return true;
    if (h.includes(':')) {
        if (h === '::1' || h === '::') return true;
        if (/^fe80:/.test(h)) return true;
        if (/^f[cd][0-9a-f]{2}:/.test(h)) return true;
    }
    if (/^\d+$/.test(h)) return true;
    if (/^0x[0-9a-f]+$/i.test(h)) return true;
    return false;
}

function decodeHtmlEntities(s) {
    return String(s)
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#0*39;/g, "'")
        .replace(/&#x0*27;/gi, "'")
        .replace(/&apos;/gi, "'");
}

function attrOf(tag, name) {
    const re = new RegExp('\\b' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s"\'>]+))', 'i');
    const m = re.exec(tag);
    if (!m) return '';
    for (let i = 1; i <= 3; i++) {
        if (m[i] !== undefined) return decodeHtmlEntities(m[i]);
    }
    return '';
}

function extractIconCandidates(html, baseUrl) {
    const out = [];
    const seen = new Set();
    const headMatch = /<head\b[^>]*>([\s\S]*?)<\/head>/i.exec(html);
    const scope = headMatch ? headMatch[1] : html.slice(0, 100000);
    const linkRe = /<link\b[^>]*>/gi;
    let m;
    while ((m = linkRe.exec(scope)) !== null) {
        const tag = m[0];
        const words = (attrOf(tag, 'rel') || '').toLowerCase().split(/\s+/).filter(Boolean);
        const apple = words.includes('apple-touch-icon');
        if (!apple && !words.includes('icon')) continue;
        const href = attrOf(tag, 'href');
        if (!href) continue;
        let abs;
        try {
            abs = new URL(href, baseUrl).toString();
        } catch (e) {
            continue;
        }
        if (seen.has(abs)) continue;
        seen.add(abs);
        let size = 0;
        const sizes = attrOf(tag, 'sizes') || '';
        const sizeRe = /(\d+)x(\d+)/g;
        let sm;
        while ((sm = sizeRe.exec(sizes)) !== null) size = Math.max(size, Number(sm[1]), Number(sm[2]));
        out.push({ url: abs, apple, size, type: (attrOf(tag, 'type') || '').toLowerCase() });
    }
    return out;
}

function scoreIconCandidate(c) {
    return (c.apple ? 2 : 0) +
        (c.size >= 180 ? 3 : c.size >= 96 ? 2 : c.size > 0 ? 1 : 0) +
        (/^image\/(png|jpeg|svg\+xml)$/.test(c.type) ? 1 : 0);
}

/* 有上限地读取响应文本：超过上限或命中 stopAt 就停止并取消读取 */
async function readBoundedText(res, maxBytes, stopAt) {
    const body = res.body;
    if (!body || typeof body.getReader !== 'function') {
        try {
            const t = await res.text();
            return t.slice(0, maxBytes);
        } catch (e) {
            return '';
        }
    }
    const reader = body.getReader();
    const decoder = new TextDecoder('utf-8');
    let out = '';
    let total = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value ? value.byteLength : 0;
            out += decoder.decode(value || new Uint8Array(0), { stream: true });
            if (stopAt && out.toLowerCase().includes(stopAt)) break;
            if (total > maxBytes) break;
        }
        out += decoder.decode();
    } catch (e) {
        /* 中途出错就用已经读到的部分 */
    } finally {
        try {
            await reader.cancel();
        } catch (e) { /* ignore */ }
    }
    return out;
}

async function safeFetchIcon(target, ms = 3500, allowSvg = false) {
    let u;
    try {
        u = new URL(target);
    } catch (e) {
        return null;
    }
    if (!ICON_SCHEME_OK.has(u.protocol)) return null;
    if (isDeniedHost(u.hostname)) return null;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
        const res = await fetch(u.toString(), {
            headers: { 'User-Agent': ICON_FETCH_HEADERS['User-Agent'] },
            redirect: 'follow',
            signal: ctrl.signal
        });
        if (!res.ok) return null;
        const ct = (res.headers.get('content-type') || '').toLowerCase();
        if (allowSvg) {
            if (!ICON_CT_OK.test(ct) && ct !== 'image/svg+xml') return null;
        } else if (!ICON_CT_OK.test(ct)) {
            return null;
        }
        return res;
    } catch (e) {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

function faviconUrl(targetUrl, path) {
    try {
        return new URL(path, targetUrl).toString();
    } catch (e) {
        return '';
    }
}

async function fetchBestIcon(targetUrl) {
    let u;
    try {
        u = new URL(targetUrl);
    } catch (e) {
        return null;
    }
    if (!ICON_SCHEME_OK.has(u.protocol) || isDeniedHost(u.hostname)) return null;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    try {
        const response = await fetch(targetUrl, { headers: ICON_FETCH_HEADERS, redirect: 'follow', signal: ctrl.signal });
        if (!response.ok) return null;
        const html = await readBoundedText(response, FETCH_ICON_MAX_HTML, '</head>');
        const candidates = extractIconCandidates(html, targetUrl);
        candidates.sort((a, b) => scoreIconCandidate(b) - scoreIconCandidate(a));
        const urls = [];
        const pushUrl = (x) => {
            if (x && !urls.includes(x)) urls.push(x);
        };
        candidates.slice(0, 3).forEach((c) => pushUrl(c.url));
        pushUrl(faviconUrl(targetUrl, '/favicon.ico'));
        pushUrl(faviconUrl(targetUrl, '/favicon.svg'));
        const deadline = Date.now() + 4000;
        for (const iconUrl of urls) {
            const ms = Math.min(1500, deadline - Date.now());
            if (ms <= 0) break;
            const res = await safeFetchIcon(iconUrl, ms, true);
            if (res) return res;
        }
        return null;
    } catch (e) {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

/* 进程内图标缓存：替代 caches.default（浏览器仍由 Cache-Control 缓存一周） */
const ICON_MEMO = new Map();
const ICON_MEMO_TTL = 10 * 60 * 1000;
const ICON_MEMO_MAX_ENTRIES = 200;
const ICON_MEMO_MAX_BYTES = 4 * 1024 * 1024;
const ICON_MEMO_MAX_ITEM = 256 * 1024;
let _iconMemoBytes = 0;

function iconMemoGet(key) {
    const hit = ICON_MEMO.get(key);
    if (!hit) return null;
    if (hit.expireAt <= Date.now()) {
        ICON_MEMO.delete(key);
        _iconMemoBytes -= hit.buf.byteLength;
        return null;
    }
    return hit;
}

function iconMemoSet(key, buf, ct) {
    if (!buf || buf.byteLength === 0 || buf.byteLength > ICON_MEMO_MAX_ITEM) return;
    while (ICON_MEMO.size >= ICON_MEMO_MAX_ENTRIES || _iconMemoBytes + buf.byteLength > ICON_MEMO_MAX_BYTES) {
        const first = ICON_MEMO.keys().next().value;
        if (first === undefined) break;
        const old = ICON_MEMO.get(first);
        ICON_MEMO.delete(first);
        if (old) _iconMemoBytes -= old.buf.byteLength;
    }
    ICON_MEMO.set(key, { buf, ct, expireAt: Date.now() + ICON_MEMO_TTL });
    _iconMemoBytes += buf.byteLength;
}

function normalizeIconContentType(raw) {
    const ct = String(raw || '').toLowerCase();
    return ct === 'image/svg+xml' ? 'image/svg+xml' : 'image/png';
}

function iconResponse(body, contentType, cacheStatus, extra) {
    return new Response(body, {
        status: 200,
        headers: {
            'Content-Type': contentType,
            'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': "default-src 'none'; sandbox",
            'Content-Disposition': 'inline; filename="icon"',
            'Referrer-Policy': 'no-referrer',
            'Cross-Origin-Resource-Policy': 'same-origin',
            'Cache-Control': 'public, max-age=604800, s-maxage=604800, immutable',
            'Access-Control-Allow-Origin': '*',
            'X-Icon-Cache-Status': cacheStatus,
            ...(extra || {})
        }
    });
}

async function handleIconProxy(request) {
    const url = new URL(request.url);
    const targetUrl = url.searchParams.get('url');
    if (!targetUrl) return new Response('Missing URL', { status: 400 });

    const cacheKey = url.toString();
    const memo = iconMemoGet(cacheKey);
    if (memo) return iconResponse(memo.buf, memo.ct, 'HIT');

    let upstreamResponse = null;
    if (PREFER_ICON_API) {
        const upstreamApi = `${ICON_API}${encodeURIComponent(targetUrl)}`;
        upstreamResponse = await safeFetchIcon(upstreamApi, 3500, true);
        if (!upstreamResponse) {
            upstreamResponse = await safeFetchIcon(faviconUrl(targetUrl, '/favicon.ico'), 3500);
            if (!upstreamResponse) upstreamResponse = await fetchBestIcon(targetUrl);
        }
    } else {
        upstreamResponse = await safeFetchIcon(faviconUrl(targetUrl, '/favicon.ico'), 3500);
        if (!upstreamResponse) upstreamResponse = await fetchBestIcon(targetUrl);
    }

    if (upstreamResponse) {
        const ct = normalizeIconContentType(upstreamResponse.headers.get('content-type'));
        try {
            const buf = new Uint8Array(await upstreamResponse.arrayBuffer());
            iconMemoSet(cacheKey, buf, ct);
            return iconResponse(buf, ct, 'MISS');
        } catch (e) {
            /* 读取上游失败，落到默认图标 */
        }
    }

    const fallbackSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" style="display:block;width:100%;height:100%"><rect width="64" height="64" fill="white"/></svg>';
    return iconResponse(fallbackSvg, 'image/svg+xml', 'DEFAULT');
}

/* ==========================================================================
 * 8. 站点图标设置
 * ========================================================================== */

async function handleGetSiteIcon(request, env) {
    const cors = corsHeaders(request, env);
    try {
        const rec = await blobGetJson(navStore(), KEY.siteIcon(DEFAULT_USER));
        const icon = rec && typeof rec.icon === 'string' ? rec.icon : '';
        return jsonResponse({ icon }, 200, { ...cors, 'Cache-Control': 'no-cache' });
    } catch (e) {
        return jsonResponse({ icon: '' }, 200, cors);
    }
}

async function handleSaveSiteIcon(request, env) {
    const cors = corsHeaders(request, env);
    const v = await validateServerToken(request.headers.get('Authorization'), env);
    if (!v.isValid) return jsonResponse(v.response, v.status, cors);
    const body = await readJsonBody(request, 10 * 1024);
    if (!body.ok) return jsonResponse({ error: body.reason }, 400, cors);
    const b = body.data || {};
    const icon = typeof b.icon === 'string' ? b.icon.slice(0, 1000) : '';
    try {
        await blobPutJson(navStore(), KEY.siteIcon(DEFAULT_USER), { icon });
        return jsonResponse({ ok: true }, 200, cors);
    } catch (e) {
        return jsonResponse({ error: 'BLOB_WRITE_FAILED' }, 500, cors);
    }
}

/* ==========================================================================
 * 9. 数据校验（与 Cloudflare 版本一致）
 * ========================================================================== */

const MAX_CATEGORIES = 100;
const MAX_LINKS_TOTAL = 3000;
const MAX_NAME = 120;
const MAX_TIPS = 500;
const MAX_URL = 2048;
const URL_SCHEME_OK = new Set(['http:', 'https:']);

function safeJsonParse(text, fallback) {
    if (typeof text !== 'string' || text === '') return { ok: false, data: fallback };
    try {
        const v = JSON.parse(text);
        if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, data: fallback };
        return { ok: true, data: v };
    } catch (e) {
        return { ok: false, data: fallback };
    }
}

function validateCategories(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'CATEGORIES_TYPE' };
    const keys = Object.keys(raw);
    if (keys.length > MAX_CATEGORIES) return { ok: false, reason: 'TOO_MANY_CATEGORIES' };
    let total = 0;
    for (const name of keys) {
        if (typeof name !== 'string' || name.length === 0 || name.length > MAX_NAME) return { ok: false, reason: 'BAD_CATEGORY_NAME' };
        const cat = raw[name];
        const links = Array.isArray(cat) ? cat : (cat && Array.isArray(cat.links) ? cat.links : null);
        if (!links) return { ok: false, reason: 'BAD_CATEGORY_SHAPE' };
        total += links.length;
        for (const l of links) {
            if (!l || typeof l !== 'object') return { ok: false, reason: 'BAD_LINK' };
            if (typeof l.name !== 'string' || l.name.length === 0 || l.name.length > MAX_NAME) return { ok: false, reason: 'BAD_NAME' };
            if (typeof l.url !== 'string' || l.url.length === 0 || l.url.length > MAX_URL) return { ok: false, reason: 'BAD_URL' };
            let u;
            try {
                u = new URL(l.url);
            } catch (e) {
                return { ok: false, reason: 'BAD_URL_FORMAT' };
            }
            if (!URL_SCHEME_OK.has(u.protocol)) return { ok: false, reason: 'URL_SCHEME' };
            if (l.tips != null && typeof l.tips !== 'string') return { ok: false, reason: 'BAD_TIPS' };
            if (l.icon != null && typeof l.icon !== 'string') return { ok: false, reason: 'BAD_ICON' };
            for (const flag of ['isPrivate', 'isDirect']) {
                if (l[flag] != null && typeof l[flag] !== 'boolean') return { ok: false, reason: 'BAD_FLAG' };
            }
        }
    }
    if (total > MAX_LINKS_TOTAL) return { ok: false, reason: 'TOO_MANY_LINKS' };
    return { ok: true };
}

function sanitizeCategories(raw) {
    const out = {};
    for (const name of Object.keys(raw)) {
        const cat = Array.isArray(raw[name]) ? { isHidden: false, links: raw[name] } : raw[name];
        out[name] = {
            isHidden: !!cat.isHidden,
            links: (cat.links || []).map((l) => ({
                name: String(l.name).slice(0, MAX_NAME),
                url: String(l.url).slice(0, MAX_URL),
                tips: l.tips ? String(l.tips).slice(0, MAX_TIPS) : '',
                icon: l.icon ? String(l.icon).slice(0, MAX_URL) : '',
                isPrivate: !!l.isPrivate,
                isDirect: !!l.isDirect,
                category: l.category ? String(l.category).slice(0, MAX_NAME) : name
            }))
        };
    }
    return out;
}

function normalizeCategories(categories) {
    for (const key in categories) {
        if (Array.isArray(categories[key])) categories[key] = { isHidden: false, links: categories[key] };
    }
    return categories;
}

async function readLinksKv(store) {
    const raw = await blobGetText(store, KEY.links(DEFAULT_USER));
    const { data } = safeJsonParse(raw, null);
    if (!data || typeof data !== 'object') return { categories: {} };
    data.categories = normalizeCategories(data.categories || {});
    return data;
}

function filterPublic(categories) {
    const out = {};
    for (const name in categories) {
        const cat = categories[name];
        if (cat && cat.isHidden) continue;
        const publicLinks = (cat && Array.isArray(cat.links) ? cat.links : []).filter((l) => !l.isPrivate);
        if (publicLinks.length > 0) out[name] = { ...(cat || {}), links: publicLinks };
    }
    return out;
}

function filterGuest(categories) {
    const out = {};
    for (const name in categories) {
        const cat = categories[name];
        if (!cat) continue;
        const links = (Array.isArray(cat.links) ? cat.links : []).filter((l) => !l.isPrivate);
        if (links.length > 0) out[name] = { ...cat, links };
    }
    return out;
}

/* ==========================================================================
 * 10. 备份（Blob 无 metadata，时间戳写进键名；键名字典序 == 时间序）
 * ========================================================================== */

const MIN_BACKUP_INTERVAL_MS = 10 * 60 * 1000;
const MAX_BACKUPS = 10;

function backupStamp(ts) {
    return new Date(ts + 8 * 3600 * 1000).toISOString().replace(/[:.]/g, '-');
}

function stampFromBackupKey(key) {
    const m = /nav-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.json$/.exec(String(key));
    if (!m) return 0;
    const ms = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${m[7]}Z`);
    return Number.isNaN(ms) ? 0 : ms;
}

async function pruneBackups(store, user, keep) {
    const keys = (await blobListKeys(store, KEY.backupPrefix(user))).sort();
    const extra = keys.length - (keep || MAX_BACKUPS);
    for (let i = 0; i < extra; i++) await blobDelete(store, keys[i]);
}

async function handleSmartBackup(store, user, currentData) {
    try {
        const keys = (await blobListKeys(store, KEY.backupPrefix(user))).sort();
        let shouldBackup = true;
        if (keys.length > 0) {
            const lastMs = stampFromBackupKey(keys[keys.length - 1]);
            if (lastMs && Date.now() - lastMs < MIN_BACKUP_INTERVAL_MS) shouldBackup = false;
        }
        if (shouldBackup) {
            await store.set(KEY.backup(user, backupStamp(Date.now())), currentData);
        }
        await pruneBackups(store, user, MAX_BACKUPS);
    } catch (e) {
        console.error('Smart backup failed:', e && e.message);
    }
}

/* ==========================================================================
 * 11. 业务接口
 * ========================================================================== */

async function handleLogin(context, env) {
    const request = context.request;
    const cors = corsHeaders(request, env);
    const store = navStore();
    const rateLimitKey = KEY.limit('login', clientIpOf(context, request));
    try {
        const { attempts, expiredAt } = await readRateLimit(store, rateLimitKey);
        if (attempts >= MAX_ATTEMPTS) return lockedResponse(expiredAt, cors);

        let password;
        try {
            const body = await request.json();
            password = body && body.password;
        } catch (e) {
            password = undefined;
        }
        const passwordOk = typeof password === 'string' && (await timingSafeStringEqual(password, envGet(env, 'ADMIN_PASSWORD')));
        if (!passwordOk) return await recordFailedAttempt(store, rateLimitKey, attempts, cors);
        await clearRateLimit(store, rateLimitKey);

        const currentTime = Math.floor(Date.now() / 1000);
        const kid = await currentKeyGen(env);
        const accessToken = await createJWT({ iat: currentTime, exp: currentTime + 7200, role: 'admin', type: 'access', kid }, envGet(env, 'JWT_SECRET'));
        const refreshToken = await createJWT({ iat: currentTime, exp: currentTime + 2592000, role: 'admin', type: 'refresh', kid }, envGet(env, 'JWT_SECRET'));
        const response = jsonResponse({ valid: true, token: `Bearer ${accessToken}` }, 200, cors);
        response.headers.append('Set-Cookie', `refreshToken=${refreshToken}; HttpOnly; Secure; SameSite=Strict; Path=/api/refreshToken; Max-Age=2592000`);
        return response;
    } catch (e) {
        return jsonResponse({ valid: false, error: 'Auth failed' }, 403, cors);
    }
}

async function handleGuestLogin(context, env) {
    const request = context.request;
    const cors = corsHeaders(request, env);
    if (!GUEST_PASSWORD) return jsonResponse({ valid: false, error: 'GUEST_DISABLED' }, 403, cors);
    const store = navStore();
    const rateLimitKey = KEY.limit('guest', clientIpOf(context, request));
    try {
        const { attempts, expiredAt } = await readRateLimit(store, rateLimitKey);
        if (attempts >= MAX_ATTEMPTS) return lockedResponse(expiredAt, cors);

        let password;
        try {
            const body = await request.json();
            password = body && body.password;
        } catch (e) {
            password = undefined;
        }
        const passwordOk = typeof password === 'string' && (await timingSafeStringEqual(password, GUEST_PASSWORD));
        if (!passwordOk) return await recordFailedAttempt(store, rateLimitKey, attempts, cors);
        await clearRateLimit(store, rateLimitKey);

        const now = Math.floor(Date.now() / 1000);
        const guestToken = await createJWT({ iat: now, exp: now + 2592000, role: 'guest', type: 'guest' }, envGet(env, 'JWT_SECRET'));
        return jsonResponse({ valid: true, token: `Bearer ${guestToken}` }, 200, cors);
    } catch (e) {
        return jsonResponse({ valid: false, error: 'Auth failed' }, 403, cors);
    }
}

async function handleValidateGuest(request, env) {
    const gv = await validateGuestToken(request.headers.get('Authorization'), env);
    return jsonResponse(gv.isValid ? { valid: true } : { valid: false }, gv.isValid ? 200 : 401, corsHeaders(request, env));
}

async function handleRefreshToken(request, env) {
    const cors = corsHeaders(request, env);
    try {
        const cookies = parseCookie(request.headers.get('Cookie'));
        const refreshToken = cookies.refreshToken;
        if (!refreshToken) return jsonResponse({ error: 'Refresh token missing' }, 401, cors);
        const payload = await validateJWT(refreshToken, envGet(env, 'JWT_SECRET'));
        const currentTime = Math.floor(Date.now() / 1000);
        if (!payload || payload.exp < currentTime) return jsonResponse({ error: 'Refresh token expired' }, 401, cors);
        if (payload.type !== 'refresh') return jsonResponse({ error: 'Invalid token type' }, 400, cors);
        const kid = await currentKeyGen(env);
        if (!payload.kid || payload.kid !== kid) return jsonResponse({ error: 'Refresh token revoked' }, 401, cors);
        const newAccessToken = await createJWT({ iat: currentTime, exp: currentTime + 7200, role: 'admin', type: 'access', kid }, envGet(env, 'JWT_SECRET'));
        const newRefreshToken = await createJWT({ iat: currentTime, exp: currentTime + 2592000, role: 'admin', type: 'refresh', kid }, envGet(env, 'JWT_SECRET'));
        const response = jsonResponse({ accessToken: `Bearer ${newAccessToken}` }, 200, cors);
        response.headers.append('Set-Cookie', `refreshToken=${newRefreshToken}; HttpOnly; Secure; SameSite=Strict; Path=/api/refreshToken; Max-Age=2592000`);
        return response;
    } catch (e) {
        return jsonResponse({ error: 'Internal server error' }, 500, cors);
    }
}

async function handleValidateToken(request, env) {
    const validation = await validateServerToken(request.headers.get('Authorization'), env);
    return jsonResponse(validation.isValid ? { valid: true } : validation.response, validation.status || 200, corsHeaders(request, env));
}

async function handleGetLinks(request, env) {
    const store = navStore();
    const authHeader = request.headers.get('Authorization');
    let scope = 'anon';
    if (authHeader) {
        const v = await validateServerToken(authHeader, env);
        if (v.isValid) scope = 'authed';
        else {
            const gv = await validateGuestToken(authHeader, env);
            if (gv.isValid) scope = 'guest';
        }
    }
    const data = await readLinksKv(store);
    if (data && data.categories) {
        for (const name of Object.keys(data.categories)) {
            for (const l of data.categories[name].links || []) {
                if (l.category === undefined || l.category === null) l.category = name;
            }
        }
    }
    let body;
    if (scope === 'authed') body = data;
    else if (scope === 'guest') body = { categories: filterGuest(data.categories) };
    else body = { categories: filterPublic(data.categories) };
    return jsonResponse(body, 200, { ...corsHeaders(request, env), 'X-Data-Scope': scope });
}

async function handleSaveData(context) {
    const request = context.request;
    const env = context.env || {};
    const cors = corsHeaders(request, env);
    const validation = await validateServerToken(request.headers.get('Authorization'), env);
    if (!validation.isValid) return jsonResponse(validation.response, validation.status, cors);
    const body = await readJsonBody(request);
    if (!body.ok) return jsonResponse({ error: body.reason }, body.reason === 'TOO_LARGE' ? 413 : 400, cors);
    const categories = body.data.categories;
    const check = validateCategories(categories);
    if (!check.ok) return jsonResponse({ error: 'INVALID_DATA', detail: check.reason }, 422, cors);
    try {
        const store = navStore();
        const currentData = await blobGetText(store, KEY.links(DEFAULT_USER));
        if (currentData) background(context, handleSmartBackup(store, DEFAULT_USER, currentData));
        await blobPutJson(store, KEY.links(DEFAULT_USER), { categories: sanitizeCategories(categories) });
        return jsonResponse({ success: true }, 200, cors);
    } catch (e) {
        return jsonResponse({ error: 'Bad Request' }, 400, cors);
    }
}

async function handleBackupData(context) {
    const request = context.request;
    const env = context.env || {};
    const cors = corsHeaders(request, env);
    const validation = await validateServerToken(request.headers.get('Authorization'), env);
    if (!validation.isValid) return jsonResponse(validation.response, validation.status, cors);
    const store = navStore();
    const sourceData = await blobGetText(store, KEY.links(DEFAULT_USER));
    if (!sourceData) return jsonResponse({ success: false, error: 'User data not found' }, 404, cors);
    try {
        await store.set(KEY.backup(DEFAULT_USER, backupStamp(Date.now())), sourceData);
        await pruneBackups(store, DEFAULT_USER, MAX_BACKUPS);
        return jsonResponse({ success: true }, 200, cors);
    } catch (e) {
        return jsonResponse({ success: false, error: 'BACKUP_FAILED' }, 500, cors);
    }
}

async function handleExportData(request, env) {
    const cors = corsHeaders(request, env);
    const validation = await validateServerToken(request.headers.get('Authorization'), env);
    if (!validation.isValid) return jsonResponse(validation.response, validation.status, cors);
    const data = await blobGetText(navStore(), KEY.links(DEFAULT_USER));
    return new Response(data || '{}', {
        status: 200,
        headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
    });
}

async function handleImportData(context) {
    const request = context.request;
    const env = context.env || {};
    const cors = corsHeaders(request, env);
    const validation = await validateServerToken(request.headers.get('Authorization'), env);
    if (!validation.isValid) return jsonResponse(validation.response, validation.status, cors);
    const bodyObj = await readJsonBody(request);
    if (!bodyObj.ok) return jsonResponse({ error: bodyObj.reason }, bodyObj.reason === 'TOO_LARGE' ? 413 : 400, cors);
    const incoming = bodyObj.data && typeof bodyObj.data === 'object' ? bodyObj.data : {};
    const categories = incoming.categories && typeof incoming.categories === 'object' ? incoming.categories : {};
    const check = validateCategories(categories);
    if (!check.ok) return jsonResponse({ error: 'INVALID_DATA', detail: check.reason }, 422, cors);
    const cleanData = { categories: sanitizeCategories(categories) };
    try {
        const store = navStore();
        const currentData = await blobGetText(store, KEY.links(DEFAULT_USER));
        if (currentData) background(context, handleSmartBackup(store, DEFAULT_USER, currentData));
        await blobPutJson(store, KEY.links(DEFAULT_USER), cleanData);
        return jsonResponse({ success: true }, 200, cors);
    } catch (e) {
        return jsonResponse({ error: 'Bad Request' }, 400, cors);
    }
}

async function handleLogout(request, env) {
    const cors = corsHeaders(request, env);
    const validation = await validateServerToken(request.headers.get('Authorization'), env);
    if (!validation.isValid) return jsonResponse(validation.response, validation.status, cors);
    await bumpKeyGen(env);
    const response = jsonResponse({ success: true }, 200, cors);
    response.headers.append('Set-Cookie', 'refreshToken=; HttpOnly; Secure; SameSite=Strict; Path=/api/refreshToken; Max-Age=0');
    return response;
}

/* ==========================================================================
 * 12. 路由入口
 * ========================================================================== */

export async function onRequest(context) {
    const request = context.request;
    const url = new URL(request.url);
    const env = context.env || {};

    try {
        assertEnv(env);
    } catch (e) {
        console.error('CONFIG_ERROR:', e.message);
        return jsonResponse(
            { error: 'Server is not configured', messages: (e.code === 'CONFIG_ERROR' && Array.isArray(e.messages)) ? e.messages : [] },
            500,
            corsHeaders(request, env)
        );
    }
    resolveConfig(env);

    try {
        const p = url.pathname;
        const isPost = request.method === 'POST';

        if (request.method === 'OPTIONS') {
            return new Response(null, {
                headers: {
                    ...corsHeaders(request, env),
                    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
                    'Access-Control-Max-Age': '86400'
                }
            });
        }

        if (p === '/api/icon') return await handleIconProxy(request);
        if (p === '/api/theme-proxy') return await handleThemeProxy(request);
        if (p === '/api/getTheme') return await handleGetTheme(request, env);
        if (p === '/api/saveTheme' && isPost) return await handleSaveTheme(request, env);
        if (p === '/api/getSiteIcon') return await handleGetSiteIcon(request, env);
        if (p === '/api/saveSiteIcon' && isPost) return await handleSaveSiteIcon(request, env);

        if (p === '/api/login' && isPost) return await handleLogin(context, env);
        if (p === '/api/guestLogin' && isPost) return await handleGuestLogin(context, env);
        if (p === '/api/validateGuest') return await handleValidateGuest(request, env);
        if (p === '/api/refreshToken' && isPost) return await handleRefreshToken(request, env);
        if (p === '/api/validateToken') return await handleValidateToken(request, env);
        if (p === '/api/getLinks') return await handleGetLinks(request, env);
        if (p === '/api/saveData' && isPost) return await handleSaveData(context);
        if (p === '/api/backupData' && isPost) return await handleBackupData(context);
        if (p === '/api/exportData' && isPost) return await handleExportData(request, env);
        if (p === '/api/importData' && isPost) return await handleImportData(context);
        if (p === '/api/logout' && isPost) return await handleLogout(request, env);

        return new Response('Not Found', { status: 404, headers: corsHeaders(request, env) });
    } catch (e) {
        console.error('UNHANDLED', (e && e.stack) ? e.stack : e, url.pathname, request.method);
        return jsonResponse({ error: 'INTERNAL' }, 500);
    }
}

export default onRequest;
