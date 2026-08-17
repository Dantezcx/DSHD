// ============================================================
// DSH Docker 移植版 — 客户端管理服务
// 把 DSH 客户端 v1.1.7 (Electron) 的独有能力移植为 Web 服务：
//   - 同步引擎：Git 同步 / WebDAV 同步 / 云端恢复 / tar.gz 备份包
//   - 插件市场：GitHub 搜索 / README / 一键安装 / AI 翻译
//   - 状态监控：服务状态 / token / 费用 / 余额
//   - 规则继承：外部 AI 规则扫描 / AI 精简导入
//   - 归档管理：会话归档 / 取消归档
//   - 双端 UI：桌面管理页 / 移动端 UI
// ============================================================
import http from 'node:http';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createDecipheriv } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const WEB_PORT = Number(process.env.DSH_WEB_PORT || 8123);
const MGMT_PORT = Number(process.env.DSH_MGMT_PORT || 8124);
const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;
const WORKSPACE_JSON = path.join(DSH_HOME, 'storages', 'workspace.json');
const LIXIN_DIR = path.join(DSH_HOME, 'profiles', 'web', 'node_modules', '@linxin666');
const WEB_DIR = path.join(__dirname, '..', 'web');

// ---- 凭据读取：透明解密（格式与 dsh-credentials-local 补丁一致）----
const CRED_KEY = path.join(DSH_HOME, '.credentials-key');
function readStoredKey() {
  const cred = path.join(DSH_HOME, '.credentials.yaml');
  if (!fs.existsSync(cred)) return null;
  const m = String(fs.readFileSync(cred, 'utf8')).match(/^DEEPSEEK_API_KEY:\s*(\S+)/m);
  if (!m) return null;
  const val = m[1];
  if (!val.startsWith('enc:v1:')) return val;
  try {
    if (!fs.existsSync(CRED_KEY)) return null;
    const raw = Buffer.from(val.slice(7), 'base64');
    const decipher = createDecipheriv('aes-256-gcm', fs.readFileSync(CRED_KEY), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  } catch (e) { return null; }
}

// ---- 移动端对话桥：服务端代理 dsh 主服务 RPC（同源，避免跨域/直连）----
async function dshRpc(method, payload) {
  const r = await fetch(WEB_URL + '/api/' + method, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'mgmt-' + Date.now(), method, payload }),
    signal: AbortSignal.timeout(30000),
  });
  const j = await r.json().catch(() => ({}));
  if (!j || !j.result) throw new Error('dsh 主服务无响应');
  if (!j.result.ok) throw new Error((j.result.error && (j.result.error.message || j.result.error.code)) || 'RPC 失败: ' + method);
  return j.result.value;
}
function mobTextOf(entry) {
  const data = entry.data || {};
  if (typeof data.text === 'string' && data.text) return data.text;
  const parts = data.content || (data.message && data.message.content) || [];
  const out = [];
  for (const p of parts) if (p && p.type === 'text' && typeof p.text === 'string') out.push(p.text);
  return out.join('\n').slice(0, 4000);
}
function mobHistoryToMessages(events) {
  const msgs = [];
  for (const entry of events || []) {
    const e = entry.event || entry;
    if (e.type === 'user/message') {
      msgs.push({ role: 'user', text: mobTextOf(e) || '[消息]', ts: e.time });
    } else if (e.type === 'assistant/message') {
      msgs.push({ role: 'assistant', text: mobTextOf(e), ts: e.time });
    }
  }
  return msgs;
}

// ==================== 配置持久化 ====================
const CONFIG_FILE = path.join(DSH_HOME, 'client-config.json');
let config = { sync: {} };
try { config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) }; } catch (e) {}
function saveConfig() {
  try { fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true }); fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2)); } catch (e) {}
}
const log = (msg) => {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.appendFileSync(path.join(DSH_HOME, 'client-mgmt.log'), line); } catch (e) {}
  console.log(line.trim());
};

// ==================== 同步引擎（移植自 main.js）====================
const SYNC_GITIGNORE = [
  'node_modules/', 'profiles/*/node_modules/',
  '*.log', '.git/', '.DS_Store', 'profiles/*/pnpm-lock.yaml', 'profiles/*/pnpm-workspace.yaml',
].join('\n');

function syncSelectedPaths() {
  const c = (config.sync && config.sync.content) || {};
  const paths = [];
  if (c.sessions) paths.push('sessions');
  if (c.api) paths.push('.credentials.yaml');
  if (c.settings) paths.push('settings.yaml', 'pet.json', '.anonymous-user-id', 'storages', 'profiles/web/cordis.patch.yml', 'profiles/web/cordis.yml', 'profiles/web/package.json');
  return paths;
}

function execGit(args, cwd) {
  return new Promise((resolve, reject) => {
    const c = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    c.stdout.on('data', (d) => out += d.toString());
    c.stderr.on('data', (d) => out += d.toString());
    c.on('error', reject);
    c.on('exit', (code) => code === 0 ? resolve(out) : reject(new Error('git ' + args[0] + ' exit ' + code + ': ' + out.slice(-300))));
  });
}

async function gitSync() {
  const g = (config.sync && config.sync.git) || {};
  const remote = (g.remote || '').trim();
  if (!remote) return { ok: false, msg: '未配置 Git 远程地址' };
  if (!fs.existsSync(path.join(DSH_HOME, '.git'))) {
    await execGit(['init'], DSH_HOME);
    try { await execGit(['branch', '-M', 'main'], DSH_HOME); } catch (e) {}
    const gi = path.join(DSH_HOME, '.gitignore');
    if (!fs.existsSync(gi)) fs.writeFileSync(gi, SYNC_GITIGNORE);
  }
  try { await execGit(['config', 'user.name', 'dsh-sync'], DSH_HOME); } catch (e) {}
  try { await execGit(['config', 'user.email', 'dsh-sync@local'], DSH_HOME); } catch (e) {}
  try { await execGit(['remote', 'remove', 'origin'], DSH_HOME); } catch (e) {}
  await execGit(['remote', 'add', 'origin', remote], DSH_HOME);
  const paths = syncSelectedPaths();
  try { await execGit(['add', '--', ...paths], DSH_HOME); } catch (e) {}
  const st = await execGit(['status', '--porcelain'], DSH_HOME);
  if (st.trim()) {
    await execGit(['commit', '-m', 'dsh sync ' + new Date().toISOString()], DSH_HOME);
  }
  try { await execGit(['pull', '--rebase', 'origin', 'main'], DSH_HOME); }
  catch (e) { log('git pull conflict, keep local: ' + e.message); }
  await execGit(['push', 'origin', 'HEAD:main'], DSH_HOME);
  return { ok: true, msg: 'Git 同步完成' };
}

// ---- WebDAV ----
function davFetch(method, url, { body, headers, timeout = 20000 } = {}) {
  return fetch(url, { method, body, headers, signal: AbortSignal.timeout(timeout) });
}
function davAuth(user, pass) {
  return 'Basic ' + Buffer.from(user + ':' + pass).toString('base64');
}
async function davMkcol(url, auth) {
  try { await davFetch('MKCOL', url, { headers: { Authorization: auth } }); } catch (e) {}
}
async function davList(url, auth) {
  const res = await davFetch('PROPFIND', url, { headers: { Authorization: auth, Depth: '1' } });
  if (!res.ok) throw new Error('PROPFIND ' + res.status);
  const xml = await res.text();
  const origin = new URL(url).origin;
  const items = [];
  const hrefRe = /<[A-Za-z0-9_-]+:href>([^<]+)<\/[A-Za-z0-9_-]+:href>/g;
  const lmRe = /<[A-Za-z0-9_-]+:getlastmodified>([^<]+)<\/[A-Za-z0-9_-]+:getlastmodified>/g;
  const szRe = /<[A-Za-z0-9_-]+:getcontentlength>([^<]+)<\/[A-Za-z0-9_-]+:getcontentlength>/g;
  let m;
  while ((m = hrefRe.exec(xml))) items.push({ href: m[1], lastModified: null, size: null });
  const lms = [];
  while ((m = lmRe.exec(xml))) lms.push(Date.parse(m[1]));
  const sizes = [];
  while ((m = szRe.exec(xml))) sizes.push(parseInt(m[1], 10) || null);
  const out = [];
  items.forEach((it, i) => {
    const h = it.href;
    const full = /^https?:\/\//i.test(h) ? h : origin + h;
    out.push({ path: decodeURIComponent(h), url: full, lastModified: lms[i] || null, size: sizes[i] || null });
  });
  return out;
}
async function davListRecursive(url, auth) {
  const out = [];
  const stack = [url];
  while (stack.length) {
    const cur = stack.pop();
    const curNorm = cur.replace(/\/+$/, '');
    let items = [];
    try { items = await davList(cur, auth); } catch (e) {}
    for (const it of items) {
      const urlNorm = it.url.replace(/\/+$/, '');
      if (urlNorm === curNorm) continue;
      if (it.path.endsWith('/')) stack.push(it.url);
      else out.push(it);
    }
  }
  return out;
}
function relFromDavPath(p) {
  return decodeURIComponent(p).replace(/\/+$/, '').replace(/^\/+/, '').replace(/^dsh-sync\/?/, '');
}
async function davGet(url, auth) {
  const res = await davFetch('GET', url, { headers: { Authorization: auth } });
  if (!res.ok) throw new Error('GET ' + res.status);
  return Buffer.from(await res.arrayBuffer());
}
async function davPut(url, buf, auth) {
  const headers = { Authorization: auth, 'Content-Type': 'application/octet-stream' };
  let res = await davFetch('PUT', url, { body: buf, headers });
  if (res.status === 409) {
    try { await davFetch('DELETE', url, { headers: { Authorization: auth } }); } catch (e) {}
    res = await davFetch('PUT', url, { body: buf, headers });
  }
  if (!res.ok && res.status !== 201 && res.status !== 204) throw new Error('PUT ' + res.status);
}
function collectSyncFiles() {
  const c = (config.sync && config.sync.content) || {};
  const files = [];
  const rel = (p) => path.relative(DSH_HOME, p).split(path.sep).join('/');
  const addDir = (dir) => {
    const d = path.join(DSH_HOME, dir);
    if (!fs.existsSync(d)) return;
    const walk = (cur) => {
      for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
        const p = path.join(cur, e.name);
        if (e.isDirectory()) walk(p);
        else if (!e.name.endsWith('.lock')) files.push({ local: p, rel: rel(p) });
      }
    };
    walk(d);
  };
  if (c.sessions) addDir('sessions');
  if (c.settings) addDir('storages');
  if (c.api && fs.existsSync(path.join(DSH_HOME, '.credentials.yaml'))) files.push({ local: path.join(DSH_HOME, '.credentials.yaml'), rel: '.credentials.yaml' });
  if (c.settings) {
    for (const f of ['settings.yaml', 'pet.json', '.anonymous-user-id', 'profiles/web/cordis.patch.yml', 'profiles/web/cordis.yml', 'profiles/web/package.json']) {
      const p = path.join(DSH_HOME, f);
      if (fs.existsSync(p)) files.push({ local: p, rel: f.split(path.sep).join('/') });
    }
  }
  return files;
}
async function webdavSync() {
  const w = (config.sync && config.sync.webdav) || {};
  const base = (w.url || '').trim().replace(/\/+$/, '');
  if (!base || !w.user || !w.pass) return { ok: false, msg: 'WebDAV 配置不完整（地址/用户名/密码）' };
  const auth = davAuth(w.user, w.pass);
  const root = base + '/dsh-sync';
  const errors = [];
  const ensureDir = async (relDir) => {
    const parts = relDir.split('/').filter(Boolean);
    let cur = root;
    for (const p of parts) {
      cur += '/' + p;
      try { await davMkcol(cur, auth); }
      catch (e) { errors.push('建目录 ' + p + ': ' + e.message); return; }
    }
  };
  const files = collectSyncFiles();
  for (const f of files) {
    try {
      await ensureDir(f.rel.includes('/') ? f.rel.slice(0, f.rel.lastIndexOf('/')) : '');
      const buf = fs.readFileSync(f.local);
      const url = root + '/' + f.rel;
      const remoteLast = await davList(root + '/' + f.rel.slice(0, f.rel.lastIndexOf('/')), auth).catch(() => []);
      const item = remoteLast.find((x) => decodeURIComponent(x.path).endsWith('/' + f.rel));
      if (!item || !item.lastModified || fs.statSync(f.local).mtimeMs > item.lastModified) {
        await davPut(url, buf, auth);
      }
    } catch (e) {
      errors.push(f.rel + ': ' + e.message);
    }
  }
  try {
    const remote = await davList(root + '/sessions', auth).catch(() => []);
    for (const item of remote) {
      const rel = relFromDavPath(item.path);
      if (!rel || item.path.endsWith('/')) continue;
      const local = path.join(DSH_HOME, rel.split('/').join(path.sep));
      if (!fs.existsSync(local) || (item.lastModified && item.lastModified > fs.statSync(local).mtimeMs)) {
        try {
          const buf = await davGet(item.url, auth);
          fs.mkdirSync(path.dirname(local), { recursive: true });
          fs.writeFileSync(local, buf);
        } catch (e) { errors.push('pull ' + rel + ': ' + e.message); }
      }
    }
  } catch (e) { errors.push('pull: ' + e.message); }
  if (errors.length) {
    const sample = errors.slice(0, 3).join(' ; ');
    return { ok: false, msg: '同步失败（' + errors.length + ' 个文件）：' + sample + (errors.length > 3 ? ' …' : '') };
  }
  return { ok: true, msg: 'WebDAV 同步完成' };
}

async function syncNow() {
  const s = config.sync || {};
  let result;
  try {
    if (s.method === 'git') result = await gitSync();
    else if (s.method === 'webdav') result = await webdavSync();
    else return { ok: false, msg: '未启用同步' };
  } catch (e) {
    result = { ok: false, msg: e.message };
  }
  s.lastSync = new Date().toISOString();
  s.lastStatus = result.msg;
  saveConfig();
  log('sync result: ' + result.msg);
  return result;
}

// ---- 云端恢复 ----
async function webdavRestore() {
  const w = (config.sync && config.sync.webdav) || {};
  const base = (w.url || '').trim().replace(/\/+$/, '');
  if (!base || !w.user || !w.pass) return { ok: false, msg: 'WebDAV 配置不完整' };
  const auth = davAuth(w.user, w.pass);
  const root = base + '/dsh-sync';
  const items = await davListRecursive(root, auth);
  if (!items.length) return { ok: true, msg: '云端没有备份文件（先执行一次同步）' };
  let restored = 0;
  const errors = [];
  for (const it of items) {
    const rel = relFromDavPath(it.path);
    if (!rel) continue;
    const local = path.join(DSH_HOME, rel.split('/').join(path.sep));
    try {
      const buf = await davGet(it.url, auth);
      fs.mkdirSync(path.dirname(local), { recursive: true });
      fs.writeFileSync(local, buf);
      restored++;
    } catch (e) { errors.push(rel + ': ' + e.message); }
  }
  if (errors.length) return { ok: false, msg: '恢复 ' + restored + ' 个，失败 ' + errors.length + '：' + errors.slice(0, 2).join(' ; ') + (errors.length > 2 ? ' …' : '') };
  return { ok: true, msg: '已从云端恢复 ' + restored + ' 个文件' };
}
async function gitRestore() {
  await execGit(['fetch', 'origin', 'main'], DSH_HOME);
  await execGit(['reset', '--hard', 'origin/main'], DSH_HOME);
  return { ok: true, msg: '已恢复到云端（origin/main）最新版本' };
}
async function restoreNow() {
  const s = config.sync || {};
  let result;
  try {
    if (s.method === 'git') result = await gitRestore();
    else if (s.method === 'webdav') result = await webdavRestore();
    else return { ok: false, msg: '未启用同步' };
  } catch (e) {
    result = { ok: false, msg: e.message };
  }
  s.lastRestore = new Date().toISOString();
  s.lastStatus = result.msg;
  saveConfig();
  log('restore result: ' + result.msg);
  return result;
}

// ---- 备份包 (tar.gz) ----
function execTar(args) {
  return new Promise((resolve, reject) => {
    const c = spawn('tar', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    c.stdout.on('data', (d) => out += d.toString());
    c.stderr.on('data', (d) => out += d.toString());
    c.on('error', reject);
    c.on('exit', (code) => code === 0 ? resolve(out) : reject(new Error('tar exit ' + code + ': ' + out.slice(-200))));
  });
}
function davBackupRoot() {
  const w = (config.sync && config.sync.webdav) || {};
  const base = (w.url || '').trim().replace(/\/+$/, '');
  if (!base || !w.user || !w.pass) return null;
  return { base, auth: davAuth(w.user, w.pass) };
}
async function cleanupBackups(dir, auth, keep) {
  try {
    const items = await davList(dir, auth);
    const backups = items.filter((x) => x.path.endsWith('.tar.gz'))
      .sort((a, b) => (b.lastModified || 0) - (a.lastModified || 0));
    for (const old of backups.slice(keep)) {
      try { await davFetch('DELETE', old.url, { headers: { Authorization: auth } }); } catch (e) {}
    }
  } catch (e) {}
}
function tsStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}
async function backupCreate() {
  if ((config.sync || {}).method === 'git') return syncNow();
  const dv = davBackupRoot();
  if (!dv) return { ok: false, msg: 'WebDAV 未配置（请先在同步设置中填写地址/账号）' };
  const name = 'dsh-backup-' + tsStamp() + '.tar.gz';
  const tmp = path.join(os.tmpdir(), name);
  try {
    const paths = syncSelectedPaths();
    await execTar(['-czf', tmp, '-C', DSH_HOME, ...paths]);
    await davMkcol(dv.base, dv.auth);
    await davPut(dv.base + '/' + name, fs.readFileSync(tmp), dv.auth);
    fs.unlinkSync(tmp);
    await cleanupBackups(dv.base, dv.auth, 10);
    const s = config.sync || {};
    s.lastSync = new Date().toISOString();
    s.lastStatus = '备份已上传: ' + name;
    saveConfig();
    log('backup created: ' + name);
    return { ok: true, msg: '备份已上传: ' + name };
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (e2) {}
    return { ok: false, msg: '备份失败: ' + e.message };
  }
}
async function backupList() {
  const dv = davBackupRoot();
  if (!dv) return { ok: false, items: [], msg: 'WebDAV 未配置' };
  try {
    const items = await davList(dv.base, dv.auth).catch(() => []);
    const list = items
      .filter((x) => x.path.endsWith('.tar.gz'))
      .map((x) => {
        const base = decodeURIComponent(x.path).split('/').pop();
        return { name: base, date: (x.lastModified ? new Date(x.lastModified).toLocaleString('zh-CN', { hour12: false }) : '—'), size: (x.size || 0) };
      })
      .sort((a, b) => b.name.localeCompare(a.name));
    return { ok: true, items: list };
  } catch (e) {
    return { ok: false, items: [], msg: '列出备份失败: ' + e.message };
  }
}
async function backupRestore(name) {
  if ((config.sync || {}).method === 'git') return gitRestore();
  const dv = davBackupRoot();
  if (!dv) return { ok: false, msg: 'WebDAV 未配置' };
  const tmp = path.join(os.tmpdir(), name);
  try {
    const buf = await davGet(dv.base + '/' + name, dv.auth);
    fs.writeFileSync(tmp, buf);
    await execTar(['-xzf', tmp, '-C', DSH_HOME]);
    fs.unlinkSync(tmp);
    const s = config.sync || {};
    s.lastRestore = new Date().toISOString();
    s.lastStatus = '已从备份恢复: ' + name;
    saveConfig();
    log('restored from backup: ' + name);
    return { ok: true, msg: '已恢复备份: ' + name };
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (e2) {}
    return { ok: false, msg: '恢复失败: ' + e.message };
  }
}

// ---- 同步测试 ----
function execGitTimeout(args, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const c = spawn('git', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    c.stdout.on('data', (d) => out += d.toString());
    c.stderr.on('data', (d) => out += d.toString());
    const t = setTimeout(() => { try { c.kill(); } catch (e) {} reject(new Error('连接超时（15 秒）')); }, timeoutMs);
    c.on('error', (e) => { clearTimeout(t); reject(e); });
    c.on('exit', (code) => { clearTimeout(t); code === 0 ? resolve(out) : reject(new Error('git 连接失败 exit ' + code + ': ' + out.slice(-120))); });
  });
}
async function syncTest(p) {
  try {
    if (p && p.method === 'git') {
      const remote = (p.remote || '').trim();
      if (!remote) return { ok: false, msg: '未填写 Git 远程地址' };
      await execGitTimeout(['ls-remote', remote], 15000);
      return { ok: true, msg: 'Git 连接成功（远程可访问）' };
    }
    const url = ((p && p.webdav && p.webdav.url) || '').trim().replace(/\/+$/, '');
    const user = (p && p.webdav && p.webdav.user) || '';
    const pass = (p && p.webdav && p.webdav.pass) || '';
    if (!url || !user || !pass) return { ok: false, msg: 'WebDAV 配置不完整（地址/用户名/密码）' };
    const auth = davAuth(user, pass);
    const res = await davFetch('PROPFIND', url + '/', { headers: { Authorization: auth, Depth: '0' }, timeout: 15000 });
    if (res.ok) return { ok: true, msg: 'WebDAV 连接成功（HTTP ' + res.status + '）' };
    return { ok: false, msg: 'WebDAV 连接失败（HTTP ' + res.status + '，检查地址/认证/目录权限）' };
  } catch (e) {
    return { ok: false, msg: '连接失败: ' + e.message };
  }
}

// ==================== 状态监控 ====================
const PRICING = {
  chat:   { in: 2, inHit: 0.5, out: 8 },
  reasoner: { in: 4, inHit: 1, out: 16 },
};
function pricingFor(model) {
  const m = String(model || '').toLowerCase();
  return m.includes('reasoner') ? PRICING.reasoner : PRICING.chat;
}
function calcCost(s) {
  const p = pricingFor(s.model);
  const inTok = Number(s.inTokens) || 0;
  const hit = Number(s.cacheHits) || 0;
  const out = Number(s.outTokens) || 0;
  return ((inTok - hit) * p.in + hit * p.inHit + out * p.out) / 1e6;
}
function fmtMoney(v) {
  if (v == null || isNaN(v)) return '—';
  if (v === 0) return '¥0.00';
  return '¥' + (v < 0.01 ? v.toFixed(4) : v.toFixed(2));
}
function fmtNum(v) {
  if (v == null || isNaN(v)) return '—';
  return v >= 1000 ? (v / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(Math.round(v));
}
let balance = null, balanceAt = 0;
async function getBalance() {
  if (balance != null && Date.now() - balanceAt < 30000) return balance;
  balanceAt = Date.now();
  try {
    const cred = path.join(DSH_HOME, '.credentials.yaml');
    if (!fs.existsSync(cred)) { balance = null; return balance; }
  const key = readStoredKey();
    if (!key) { balance = null; return balance; }
    const res = await fetch('https://api.deepseek.com/user/balance', {
      headers: { Authorization: 'Bearer ' + key },
      signal: AbortSignal.timeout(10000),
    });
    const j = await res.json();
    balance = j.balance_infos && j.balance_infos[0] ? Number(j.balance_infos[0].total_balance) : null;
  } catch (e) { balance = null; }
  return balance;
}
function portOpen(port, timeout = 500) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port }, () => { s.destroy(); resolve(true); });
    s.on('error', () => { s.destroy(); resolve(false); });
    s.setTimeout(timeout, () => { s.destroy(); resolve(false); });
  });
}
async function getStatus() {
  const online = await portOpen(WEB_PORT);
  let workspace = '', sessions = 0;
  try {
    const ws = JSON.parse(fs.readFileSync(WORKSPACE_JSON, 'utf8'));
    const first = Object.values((ws.tables && ws.tables.workspaces) || {})[0];
    if (first) { workspace = first.path || ''; sessions = (first.sessionIds || []).length; }
  } catch (e) {}
  const bal = await getBalance();
  let plugins = 0;
  try { plugins = fs.existsSync(LIXIN_DIR) ? fs.readdirSync(LIXIN_DIR).length : 0; } catch (e) {}
  return {
    online, port: WEB_PORT, workspace, sessions, mode: 'web',
    model: '未配置', plugins,
    balance: bal != null ? '¥' + bal : '—',
    sync: config.sync || {},
  };
}

// ==================== 插件市场（代理 GitHub）====================
const GIT_MIRRORS = [
  'https://ghproxy.net/https://github.com/',
  'https://ghfast.top/https://github.com/',
  'https://gh-proxy.com/https://github.com/',
];
async function searchPlugins({ q, sort, page } = {}) {
  try {
    const params = new URLSearchParams({ q: q || 'topic:dsh-plugin', sort: sort || 'stars', order: 'desc', per_page: '20', page: String(page || 1) });
    const url = 'https://api.github.com/search/repositories?' + params.toString();
    const res = await fetch(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'dsh-docker' }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) return { ok: false, msg: 'GitHub API ' + res.status, items: [] };
    const j = await res.json();
    const items = (j.items || []).map((r) => ({
      fullName: r.full_name, desc: r.description || '', stars: r.stargazers_count || 0,
      updated: r.updated_at || '', lang: r.language || '', htmlUrl: r.html_url,
    }));
    return { ok: true, items, total: j.total_count || 0 };
  } catch (err) { return { ok: false, msg: err.message, items: [], total: 0 }; }
}
async function getReadme(fullName) {
  try {
    if (!fullName) return null;
    const res = await fetch('https://api.github.com/repos/' + fullName + '/readme', { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'dsh-docker' }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) return null;
    const j = await res.json();
    if (!j.content) return null;
    return Buffer.from(j.content, 'base64').toString('utf8');
  } catch (err) { return null; }
}
async function gitCloneMirror(repo, dest) {
  const url = 'https://github.com/' + repo + '.git';
  for (const m of GIT_MIRRORS) {
    try {
      await execGitTimeout(['clone', '--depth', '1', m + url, dest], 90000);
      return true;
    } catch (e) {}
  }
  try { await execGitTimeout(['clone', '--depth', '1', url, dest], 120000); return true; } catch (e) {}
  return false;
}
async function installPlugin(info) {
  const pkg = (info && info.pkg) || '';
  const repo = (info && info.repo) || '';
  try {
    if (pkg) {
      try {
        await execCmdLive('dsh', ['plugin', '--profile', 'web', 'add', pkg], 20000);
        await restartDSH();
        return { ok: true, msg: '已通过 npm 安装: ' + pkg };
      } catch (npmErr) { log('npm install failed: ' + npmErr.message); }
    }
    if (repo) {
      const name = String(repo.split('/').pop() || '').toLowerCase();
      const tmp = path.join(os.tmpdir(), 'mp-install-' + name);
      fs.rmSync(tmp, { recursive: true, force: true });
      if (await gitCloneMirror(repo, tmp)) {
        if (fs.existsSync(path.join(tmp, 'SKILL.md'))) {
          const dest = path.join(DSH_HOME, 'skills', name);
          fs.rmSync(dest, { recursive: true, force: true });
          fs.cpSync(tmp, dest, { recursive: true });
          await restartDSH();
          return { ok: true, msg: '已安装 Skill: ' + name + '（~/.dsh/skills/' + name + '）' };
        }
        if (fs.existsSync(path.join(tmp, 'package.json'))) {
          const profile = path.join(DSH_HOME, 'profiles', 'web');
          await execCmdLive('pnpm', ['add', 'file:' + tmp], 20000, { cwd: profile });
          const patch = path.join(profile, 'cordis.patch.yml');
          const cur = fs.existsSync(patch) ? fs.readFileSync(patch, 'utf8') : '';
          if (!cur.includes("name: '" + name + "'") && !cur.includes('name: "' + name + '"')) {
            const entry = '\n- insert:\n    - id: ' + name + '\n      name: \'' + name + '\'\n';
            fs.writeFileSync(patch, cur.trimEnd() + entry);
          }
          await restartDSH();
          return { ok: true, msg: '已安装插件: ' + name + '（已挂载 cordis）' };
        }
        return { ok: false, msg: '仓库类型无法识别（无 SKILL.md / package.json）' };
      }
      return { ok: false, msg: '克隆失败：所有 GitHub 镜像不可达，请检查网络' };
    }
    return { ok: false, msg: '缺少安装信息' };
  } catch (err) {
    return { ok: false, msg: '安装失败: ' + err.message };
  }
}
function execCmdLive(cmd, args, timeoutMs, opts = {}) {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args, Object.assign({ stdio: ['ignore', 'pipe', 'pipe'] }, opts));
    let out = '';
    c.stdout.on('data', (d) => out += d.toString());
    c.stderr.on('data', (d) => out += d.toString());
    const t = setTimeout(() => { try { c.kill(); } catch (e) {} reject(new Error(cmd + ' 超时')); }, timeoutMs);
    c.on('error', (e) => { clearTimeout(t); reject(e); });
    c.on('exit', (code) => { clearTimeout(t); code === 0 ? resolve(out) : reject(new Error(cmd + ' exit ' + code + ': ' + out.slice(-200))); });
  });
}
// 重启 dsh 主服务
async function restartDSH() {
  let extra = [];
  try {
    for (const dir of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(dir)) continue;
      let cl = '';
      try { cl = fs.readFileSync('/proc/' + dir + '/cmdline', 'utf8'); } catch (e) { continue; }
      if (cl.includes('dsh') && cl.includes('--profile') && cl.includes('web')) {
        const parts = cl.split('\0').filter(Boolean);
        const wi = parts.indexOf('web');
        if (wi > 0) {
          for (let i2 = wi + 1; i2 < parts.length; i2++) {
            if (parts[i2] === '--port') { i2++; continue; }
            extra.push(parts[i2]);
          }
        }
        try { process.kill(Number(dir), 'SIGTERM'); } catch (e) {}
        break;
      }
    }
  } catch (e) {}
  const bin = process.env.DSH_BIN || 'dsh';
  const c = spawn(bin, ['--profile', 'web', '--port', String(WEB_PORT)].concat(extra), { detached: true, stdio: 'ignore' });
  c.unref();
  await new Promise((r) => setTimeout(r, 5000));
  return { ok: true, msg: '已重启 dsh 服务' };
}

// ---- AI 翻译（插件说明）----
async function translateText(text) {
  try {
    const cred = path.join(DSH_HOME, '.credentials.yaml');
  const key = readStoredKey();
    if (!key) return '未配置 API Key（请在 dsh 设置中配置）';
    const res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: '你是插件说明助手。用户会给你一个 DeepSeek Harness（DSH）插件的名称和英文介绍。请用简体中文简洁说明：这个插件是做什么的、能实现什么功能。50~150 字，用 2~4 个要点，不要逐句翻译原文。' },
          { role: 'user', content: String(text).slice(0, 2000) },
        ],
        max_tokens: 500,
        stream: false,
      }),
      signal: AbortSignal.timeout(30000),
    });
    const j = await res.json();
    const content = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    if (!content) return 'AI 无返回';
    return content.trim();
  } catch (err) {
    return 'AI 解释失败: ' + err.message;
  }
}

// ==================== 规则继承 ====================
const RULE_CANDIDATES = [
  ['Claude Code', ['CLAUDE.md', '.claude/CLAUDE.md', '.claude/CLAUDE.local.md']],
  ['Cursor', ['.cursor/rules/*.mdc', '.cursorrules', '.cursor/rules/*.md']],
  ['Gemini', ['GEMINI.md', '.gemini/GEMINI.md']],
  ['Codex', ['CODEX.md', '.codex/CODEX.md']],
  ['Copilot', ['.github/copilot-instructions.md']],
  ['DSH', ['.dsh/AGENTS.md', 'AGENTS.md', '.dsh/REASONIX.md', 'REASONIX.md']],
];
function expandRules() {
  const home = os.homedir();
  const roots = [home, process.cwd(), DSH_HOME];
  const out = [];
  for (const [tool, pats] of RULE_CANDIDATES) {
    for (const p of pats) {
      const hasGlob = p.includes('*');
      if (!hasGlob) {
        for (const r of roots) {
          const f = path.join(r, p.split('/').join(path.sep));
          if (fs.existsSync(f) && fs.statSync(f).isFile()) out.push({ name: tool + ' — ' + f, path: f, size: fs.statSync(f).size });
        }
      } else {
        const dir = path.join(process.cwd(), p.slice(0, p.indexOf('*')).replace(/\//g, path.sep));
        if (fs.existsSync(dir)) {
          for (const f of fs.readdirSync(dir)) {
            const full = path.join(dir, f);
            if (fs.statSync(full).isFile()) out.push({ name: tool + ' — ' + full, path: full, size: fs.statSync(full).size });
          }
        }
      }
    }
  }
  return out;
}
async function rulesImport(sel) {
  try {
    const f = sel && sel.path;
    if (!f || !fs.existsSync(f)) return { ok: false, msg: '规则文件不存在' };
    const content = fs.readFileSync(f, 'utf8').slice(0, 12000);
    const cred = path.join(DSH_HOME, '.credentials.yaml');
  const key = readStoredKey();
    if (!key) return { ok: false, msg: '未配置 API Key' };
    const res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: '你是规则精简助手。把外部 AI 工具的规则文件精简改写为通用、适用于 DeepSeek Harness 的规则：剔除该工具专属特性（如 plan!/ponytail/autosolve 等），保留通用行为准则。输出为简洁的 Markdown 规则列表（要点式，200 字内）。' },
          { role: 'user', content: content },
        ],
        max_tokens: 600,
        stream: false,
      }),
      signal: AbortSignal.timeout(40000),
    });
    const j = await res.json();
    const text = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    if (!text) return { ok: false, msg: 'AI 无返回: ' + (j.error ? j.error.message : '') };
    const target = path.join(DSH_HOME, 'AGENTS.md');
    const head = '\n\n## 继承自 ' + (sel.name || '外部 AI 工具') + '\n' + text.trim() + '\n';
    fs.appendFileSync(target, head);
    return { ok: true, msg: '已写入 ~/.dsh/AGENTS.md（' + text.length + ' 字符）' };
  } catch (err) {
    return { ok: false, msg: '导入失败: ' + err.message };
  }
}

// ==================== 归档管理 ====================
async function archiveList() {
  try {
    const ws = JSON.parse(fs.readFileSync(WORKSPACE_JSON, 'utf8'));
    const archived = (ws.global && ws.global.archivedSessionIds) || [];
    const wsArr = Object.values((ws.tables && ws.tables.workspaces) || {});
    const items = archived.map((id) => {
      const file = path.join(DSH_HOME, 'sessions', id, 'session.jsonl.zstd');
      return { id, exists: fs.existsSync(file) };
    });
    return { ok: true, items, workspace: wsArr.length ? (wsArr[0].title || wsArr[0].path || '') : '' };
  } catch (e) { return { ok: false, msg: e.message }; }
}
async function archiveUnarchive(id) {
  try {
    const ws = JSON.parse(fs.readFileSync(WORKSPACE_JSON, 'utf8'));
    const arr = (ws.global && ws.global.archivedSessionIds) || [];
    const i = arr.indexOf(id);
    if (i < 0) return { ok: false, msg: '该会话不在归档列表' };
    arr.splice(i, 1);
    const wsArr = Object.values((ws.tables && ws.tables.workspaces) || {});
    if (wsArr.length) {
      wsArr[0].sessionIds = wsArr[0].sessionIds || [];
      if (!wsArr[0].sessionIds.includes(id)) wsArr[0].sessionIds.push(id);
    }
    fs.writeFileSync(WORKSPACE_JSON, JSON.stringify(ws, null, 2));
    return { ok: true, msg: '已取消归档，会话将重新显示' };
  } catch (e) { return { ok: false, msg: e.message }; }
}

// ==================== 自动同步调度 ====================
let autoSyncTimers = [];
function scheduleAutoSync() {
  const s = config.sync || {};
  for (const t of autoSyncTimers) { try { clearTimeout(t); clearInterval(t); } catch (e) {} }
  autoSyncTimers = [];
  if (!s.auto) return;
  const mins = Math.max(1, Number(s.intervalMin) || 30);
  const first = setTimeout(() => { syncNow(); }, 60000);
  const iv = setInterval(syncNow, mins * 60000);
  autoSyncTimers = [first, iv];
  log('auto sync: scheduled (first in 60s, then every ' + mins + ' min)');
}

// ==================== HTTP 服务 ====================
function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => data += c);
    req.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
function serveFile(res, file, type) {
  try {
    const content = fs.readFileSync(file);
    res.writeHead(200, { 'Content-Type': type + '; charset=utf-8' });
    res.end(content);
  } catch (e) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:' + MGMT_PORT);
  const p = url.pathname;

  // ---- 静态页面 ----
  if (req.method === 'GET' && (p === '/' || p === '/desktop')) {
    return serveFile(res, path.join(WEB_DIR, 'desktop.html'), 'text/html');
  }
  if (req.method === 'GET' && (p === '/m' || p === '/mobile')) {
    return serveFile(res, path.join(WEB_DIR, 'mobile.html'), 'text/html');
  }
  // 代理：跳转到 dsh 主界面（由 nginx/外部反代完成 https）
  if (req.method === 'GET' && p === '/proxy') {
    return serveFile(res, path.join(WEB_DIR, 'desktop.html'), 'text/html');
  }

  // ---- API ----
  if (req.method === 'OPTIONS') return sendJSON(res, 200, {});
  if (!p.startsWith('/api/')) return sendJSON(res, 404, { ok: false, msg: 'Not Found' });

  const route = p.slice(5); // 去掉 /api/
  const body = req.method === 'POST' ? await readBody(req) : {};

  try {
    switch (route) {
      // 状态
      case 'status': return sendJSON(res, 200, await getStatus());
      // 同步
      case 'sync/get-config': return sendJSON(res, 200, config.sync || {});
      case 'sync/save-config': {
        config.sync = body;
        saveConfig();
        scheduleAutoSync();
        return sendJSON(res, 200, config.sync);
      }
      case 'sync/now': return sendJSON(res, 200, await syncNow());
      case 'sync/restore': return sendJSON(res, 200, await restoreNow());
      case 'sync/test': return sendJSON(res, 200, await syncTest(body));
      // 备份
      case 'backup/create': return sendJSON(res, 200, await backupCreate());
      case 'backup/list': return sendJSON(res, 200, await backupList());
      case 'backup/restore': return sendJSON(res, 200, await backupRestore(body.name));
      // 插件市场
      case 'plugins/search': return sendJSON(res, 200, await searchPlugins(body));
      case 'plugins/readme': return sendJSON(res, 200, { readme: await getReadme(body.fullName) });
      case 'plugins/install': return sendJSON(res, 200, await installPlugin(body));
      case 'plugins/translate': return sendJSON(res, 200, { text: await translateText(body.text) });
      // 规则继承
      case 'rules/scan': return sendJSON(res, 200, expandRules().map((x) => ({ name: x.name, path: x.path, size: x.size })));
      case 'rules/import': return sendJSON(res, 200, await rulesImport(body));
      // 归档
      case 'archive/list': return sendJSON(res, 200, await archiveList());
      case 'archive/unarchive': return sendJSON(res, 200, await archiveUnarchive(body.id));
      // 移动端：实时余额
      case 'mob/balance': return sendJSON(res, 200, { ok: true, balance: await getBalance() });
      // 移动端：会话列表（只显示主工作区中有标题的有效会话）
      case 'mob/sessions': {
        // 从 workspace.json 取主工作区的 sessionIds
        let wsIds = new Set();
        try {
          const ws = JSON.parse(fs.readFileSync(WORKSPACE_JSON, 'utf8'));
          const first = Object.values((ws.tables && ws.tables.workspaces) || {})[0];
          if (first && first.sessionIds) wsIds = new Set(first.sessionIds);
        } catch (e) {}
        const v = await dshRpc('session.list', {});
        const items = (v.items || [])
          // 只在主工作区 且 有真实标题（过滤临时/无标题会话）
          .filter(x => wsIds.has(x.sessionId) && x.projections && x.projections.values && x.projections.values.title)
          .map(x => ({
            id: x.sessionId,
            title: x.projections.values.title,
            updatedAt: x.updatedAt, cwd: x.cwd, running: x.running,
          }))
          .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        return sendJSON(res, 200, { ok: true, items });
      }
      // 移动端：历史消息
      case 'mob/history': {
        const v = await dshRpc('session.history', { sessionId: body.id, maxMessages: 60 });
        let running = false;
        try { const l = await dshRpc('session.list', {}); const f = (l.items || []).find(x => x.sessionId === body.id); running = !!(f && f.running); } catch (e) {}
        return sendJSON(res, 200, { ok: true, messages: mobHistoryToMessages(v.events), hasMore: v.hasMore, running });
      }
      // 移动端：发送消息
      case 'mob/send': {
        const text = String(body.text || '').slice(0, 4000);
        if (!text) return sendJSON(res, 400, { ok: false, msg: '消息为空' });
        const pv = await dshRpc('session.prompt', { sessionId: body.id, mode: 'queue', content: [{ type: 'text', text }], clientTimeZone: 'Asia/Shanghai' });
        return sendJSON(res, 200, { ok: true, ...(pv || {}) });
      }

      // 代理：访问 dsh 主服务（避免跨域）
      case 'proxy': {
        const target = WEB_URL + (body.path || '/');
        const r = await fetch(target, { signal: AbortSignal.timeout(30000) });
        const text = await r.text();
        res.writeHead(r.status, { 'Content-Type': r.headers.get('content-type') || 'text/html; charset=utf-8' });
        return res.end(text);
      }
      default: return sendJSON(res, 404, { ok: false, msg: '未知接口: ' + route });
    }
  } catch (e) {
    log('API error ' + route + ': ' + e.message);
    return sendJSON(res, 500, { ok: false, msg: e.message });
  }
});

server.listen(MGMT_PORT, '127.0.0.1', () => {
  log('========================================');
  log(' DSH Docker 移植版 管理服务已启动');
  log(` 管理页:      http://0.0.0.0:${MGMT_PORT}/`);
  log(` 移动端:      http://0.0.0.0:${MGMT_PORT}/m`);
  log(` DSH 主界面:  http://0.0.0.0:${WEB_PORT}`);
  log(` 数据目录:    ${DSH_HOME}`);
  log('========================================');
  scheduleAutoSync();
});
