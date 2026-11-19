import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const REF_DIR = path.join(SKILL_DIR, 'references');
export const ASSET_DIR = path.join(SKILL_DIR, 'assets');

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function readJson(file, fallback = undefined) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (fallback !== undefined) return fallback;
    throw err;
  }
}

export function writeJson(file, value, { pretty = 2 } = {}) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, pretty) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

export function writeText(file, text) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

export function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/** A filesystem-safe key. Keeps ASCII letters, digits, dot, dash, underscore. */
export function sanitizeFileKey(input) {
  let s = String(input ?? 'item')
    .normalize('NFKC')
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/[^\w.-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '');
  if (!s) s = 'item';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(s)) s = `_${s}`;
  return s.slice(0, 100);
}

export function timestampId(date = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

export function uniqueRunDir(baseDir, runId) {
  let dir = path.join(baseDir, runId);
  let i = 2;
  while (fs.existsSync(dir)) dir = path.join(baseDir, `${runId}-${i++}`);
  return dir;
}

export function parseArgs(argv = process.argv.slice(2)) {
  const out = { _: [] };
  const aliases = {
    o: 'out', j: 'json-out', a: 'ai-dir', s: 'scope', m: 'mode',
    f: 'focus', l: 'lang', n: 'netlist', b: 'bom', d: 'drc', h: 'help', v: 'version',
  };
  const booleanKeys = new Set([
    'no-ai', 'no-pins', 'pins', 'no-screenshots', 'self-contained', 'strict-exit',
    'partial', 'fail-partial', 'resume', 'map-pages', 'start-bridge', 'help', 'version',
    'no-open', 'keep-temp',
  ]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('-')) { out._.push(arg); continue; }
    if (arg === '--') { out._.push(...argv.slice(i + 1)); break; }
    let key;
    let value;
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      key = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
      if (eq >= 0) value = arg.slice(eq + 1);
    } else {
      const short = arg.slice(1);
      key = aliases[short] || short;
      if (!aliases[short] && short.length > 1 && !booleanKeys.has(short)) key = short;
    }
    if (value === undefined) {
      const next = argv[i + 1];
      if (!booleanKeys.has(key) && next !== undefined && !next.startsWith('-')) {
        value = next; i++;
      } else {
        value = true;
      }
    }
    out[key] = value;
  }
  return out;
}

export function boolArg(v, fallback = false) {
  if (v === undefined || v === null) return fallback;
  if (typeof v === 'boolean') return v;
  return !['0', 'false', 'no', 'off'].includes(String(v).toLowerCase());
}

export function numArg(v, fallback) {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function estimateTokens(text) {
  const s = String(text ?? '');
  let ascii = 0;
  let cjk = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if ((code >= 0x2e80 && code <= 0x9fff) || (code >= 0xf900 && code <= 0xfaff) ||
        (code >= 0x3000 && code <= 0x303f) || (code >= 0xff00 && code <= 0xffef)) cjk++;
    else ascii++;
  }
  return Math.ceil(ascii / 4 + cjk / 1.5);
}

export function levenshtein(a, b) {
  a = String(a); b = String(b);
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  const cur = new Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
  }
  return prev[b.length];
}

export function csvParse(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ',') { row.push(cell); cell = ''; continue; }
    if (ch === '\r') { if (text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; continue; }
    if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue; }
    cell += ch;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim() !== ''));
}

export function decodeText(buf) {
  if (Buffer.isBuffer(buf) === false) buf = Buffer.from(buf);
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(buf.subarray(3));
  }
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buf);
  if (!utf8.includes('�')) return utf8;
  try { return new TextDecoder('gbk').decode(buf); } catch { return utf8; }
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

export function escapeXml(s) {
  return escapeHtml(s);
}

export function fmtDuration(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m${Math.round(s % 60)}s`;
}

export function createLogger(file) {
  const lines = [];
  const log = (level, msg, extra) => {
    const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${msg}${extra ? ' ' + JSON.stringify(extra) : ''}`;
    lines.push(line);
    if (process.env.SCHEMATIC_REVIEW_VERBOSE) console.error(line);
  };
  return {
    info: (m, e) => log('info', m, e),
    warn: (m, e) => log('warn', m, e),
    error: (m, e) => log('error', m, e),
    flush() { if (file) writeText(file, lines.join('\n') + '\n'); },
    lines,
  };
}

export function sha256File(file) {
  return sha256(fs.readFileSync(file));
}

export function fileEntry(root, file, type) {
  const abs = path.isAbsolute(file) ? file : path.join(root, file);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
  const buf = fs.readFileSync(abs);
  return {
    path: path.relative(root, abs).split(path.sep).join('/'),
    type,
    sha256: sha256(buf),
    bytes: buf.length,
  };
}

export function listFiles(root, relDir, type) {
  const dir = path.join(root, relDir);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).sort().map(f => fileEntry(root, path.join(relDir, f), type)).filter(Boolean);
}

export function skillVersion() {
  try {
    const text = fs.readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8');
    const m = text.match(/metadata:\s*[\s\S]*?version:\s*["']?([^"'\n]+)/);
    return m ? m[1].trim() : 'unknown';
  } catch { return 'unknown'; }
}

export function deepClone(v) { return JSON.parse(JSON.stringify(v)); }

export function sortBySeverity(a, b) {
  const order = { P0: 0, P1: 1, P2: 2, P3: 3 };
  const sa = order[a.severity] ?? 9;
  const sb = order[b.severity] ?? 9;
  if (sa !== sb) return sa - sb;
  const ca = { high: 0, medium: 1, low: 2 }[a.confidence] ?? 3;
  const cb = { high: 0, medium: 1, low: 2 }[b.confidence] ?? 3;
  if (ca !== cb) return ca - cb;
  return String(a.id).localeCompare(String(b.id));
}

export function stableHash(obj) {
  return crypto.createHash('sha1').update(JSON.stringify(obj)).digest('hex').slice(0, 12);
}
