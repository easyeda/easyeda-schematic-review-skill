import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

/**
 * EasyEDA Pro / JLCEDA Pro built-in CLI transport (v4.1.70+).
 *
 * Both the mainland (`lceda-pro`) and international (`easyeda-pro`) desktop
 * editions expose the same CLI: `open --path <project.eprj3>` creates a
 * session, `invoke --session <id> --ext-uuid eda --code <async fn body>` runs
 * code with the editor's built-in extension identity, and `session close
 * --destroy` tears it down. Project data is ALWAYS read through the editor
 * APIs (`eda.dmt_*` / `eda.sch_*` / `eda.sys_*`) — this module never parses
 * or writes the `.eprj3` file format itself.
 *
 * The installed client is the source of truth for command names and options;
 * every call goes through the common JSON envelope `{ok, value, logs}`.
 */

export const CLI_MIN_VERSION = [4, 1, 70];
export const CLI_EDITIONS = ['lceda-pro', 'easyeda-pro'];

export function parseCliVersion(text) {
  const m = String(text || '').match(/\b(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function versionAtLeast(v, min) {
  if (!v) return false;
  for (let i = 0; i < min.length; i++) {
    if (v[i] !== min[i]) return v[i] > min[i];
  }
  return true;
}

/** Well-known install locations (PATH probing happens first). */
export function defaultCliCandidates() {
  const out = [];
  if (process.platform === 'win32') {
    for (const name of CLI_EDITIONS) {
      out.push(`C:/Program Files/${name}/${name}.exe`);
      if (process.env.LOCALAPPDATA) out.push(`${process.env.LOCALAPPDATA}/Programs/${name}/${name}.exe`);
    }
  } else if (process.platform === 'darwin') {
    for (const name of CLI_EDITIONS) out.push(`/Applications/${name}.app/Contents/MacOS/${name}`);
  }
  return out.map(p => p.replace(/\\/g, '/'));
}

/**
 * Run the CLI and unwrap the JSON envelope. Throws on non-JSON output or
 * `ok:false`; returns `value` on success (for `invoke` that is the JS return
 * value, so callers must still inspect its contents).
 */
export function runCliJson(executable, args, { spawnFn = spawnSync, timeoutMs = 120000 } = {}) {
  const res = spawnFn(executable, args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 128 * 1024 * 1024,
  });
  if (res?.error) throw new Error(`CLI 调用失败（${executable} ${args[0] || ''}）: ${res.error.message}`);
  const stdout = String(res?.stdout || '').trim();
  let json;
  try {
    json = JSON.parse(stdout);
  } catch {
    const stderr = String(res?.stderr || '').trim().slice(0, 300);
    throw new Error(`CLI 输出不是 JSON（${executable} ${args[0] || ''}）: ${stderr || stdout.slice(0, 300) || '空输出'}`);
  }
  if (json?.ok === false) {
    const err = new Error(json.error?.message || JSON.stringify(json.error || json));
    err.code = json.error?.code || 'CLI_ERROR';
    throw err;
  }
  return json?.value;
}

/**
 * Locate a usable CLI. Order: explicit path → SCHEMATIC_REVIEW_CLI →
 * PATH names (both editions) → well-known install dirs. Returns
 * `{executable, command, version}` or null when nothing works.
 * An explicitly given path that fails is an error, not a silent fallback.
 */
export function detectCli({ explicit = null, env = process.env.SCHEMATIC_REVIEW_CLI, spawnFn = spawnSync, logger = null } = {}) {
  const probe = (candidate) => {
    try {
      const res = spawnFn(candidate, ['--help'], { encoding: 'utf8', timeout: 20000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
      if (res?.error || res?.status !== 0) return null;
      const help = String(res.stdout || '');
      const version = parseCliVersion(help);
      if (!version) return null;
      return { executable: candidate, command: candidate.split(/[\\/]/).pop().replace(/\.exe$/i, ''), version, versionText: version.join('.') };
    } catch {
      return null;
    }
  };
  const failExplicit = (reason) => {
    const err = new Error(`指定的 EasyEDA CLI 不可用（${explicit}）: ${reason}`);
    err.code = 'CLI_NOT_FOUND';
    throw err;
  };
  if (explicit) {
    if (!fs.existsSync(explicit)) failExplicit('文件不存在');
    const found = probe(explicit);
    if (!found) failExplicit('`--help` 执行失败，请确认是 EasyEDA Pro / 嘉立创EDA专业版 v4.1.70+ 的客户端');
    return found;
  }
  const names = env ? [env] : CLI_EDITIONS;
  for (const name of names) {
    const found = probe(name);
    if (found) return found;
  }
  for (const candidate of defaultCliCandidates()) {
    if (!fs.existsSync(candidate)) continue;
    const found = probe(candidate);
    if (found) return found;
  }
  if (logger) logger.warn?.('EasyEDA CLI not found');
  return null;
}

export function cliUnavailableMessage(projectPath) {
  return [
    '未找到 EasyEDA CLI（lceda-pro / easyeda-pro）。',
    'CLI 模式需要 EasyEDA Pro / 嘉立创EDA专业版桌面客户端 v4.1.70+，',
    '并把可执行文件放到 PATH 或用 --cli <路径> 指定。',
    projectPath ? `目标工程: ${projectPath}` : null,
    '（桥接模式仍可用：--source live；离线网表模式：--source file --netlist design.enet）',
  ].filter(Boolean).join('\n');
}

export function cliVersionTooOldMessage(found) {
  return `EasyEDA CLI 版本过低（${found.versionText || found.executable}），CLI 模式需要 ≥ ${CLI_MIN_VERSION.join('.')}；请升级客户端后在 --help 头部确认版本。`;
}

/** Open a project through the CLI. Returns the session descriptor. */
export function cliOpenProject(executable, projectPath, { headless = true, spawnFn = spawnSync, timeoutMs = 180000 } = {}) {
  const args = ['open', '--path', String(projectPath).replace(/\\/g, '/'), '--headless', headless ? 'true' : 'false'];
  const value = runCliJson(executable, args, { spawnFn, timeoutMs });
  const sessionId = value?.sessionId || value?.session_id;
  if (!sessionId) throw new Error('CLI open 未返回 sessionId（请确认客户端版本 ≥ 4.1.70）');
  return { sessionId, path: value.path || projectPath, headless, renderId: value.renderId || null };
}

/** Execute code in a CLI session. The code is an async function body. */
export function cliInvoke(executable, sessionId, code, { timeoutMs = 120000, spawnFn = spawnSync } = {}) {
  const args = ['invoke', '--session', sessionId, '--ext-uuid', 'eda', '--code', code, '--timeout', String(timeoutMs)];
  return runCliJson(executable, args, { spawnFn, timeoutMs: timeoutMs + 30000 });
}

/** Close a session we created. Best effort — never masks the real error. */
export function cliCloseSession(executable, sessionId, { spawnFn = spawnSync } = {}) {
  try {
    return runCliJson(executable, ['session', 'close', '--session', sessionId, '--destroy'], { spawnFn, timeoutMs: 60000 });
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

/**
 * Detect the CLI, open the given project, and return an executor compatible
 * with bridge.execute(): `execute(code, {timeoutMs})`. Call `close()` when
 * done — it destroys the session/window we opened.
 */
export function openCliTransport({ projectPath, executable = null, headless = true, spawnFn = spawnSync, logger = null } = {}) {
  if (!projectPath) throw new Error('CLI 模式需要工程路径（.eprj3）');
  const found = detectCli({ explicit: executable, spawnFn, logger });
  if (!found) {
    const err = new Error(cliUnavailableMessage(projectPath));
    err.code = 'CLI_NOT_FOUND';
    throw err;
  }
  if (!versionAtLeast(found.version, CLI_MIN_VERSION)) {
    const err = new Error(cliVersionTooOldMessage(found));
    err.code = 'CLI_TOO_OLD';
    throw err;
  }
  logger?.info?.('cli open project', { executable: found.executable, version: found.versionText, projectPath });
  const session = cliOpenProject(found.executable, projectPath, { headless, spawnFn });
  logger?.info?.('cli session opened', { sessionId: session.sessionId, headless });
  return {
    transport: 'cli',
    executable: found.executable,
    cliVersion: found.versionText,
    sessionId: session.sessionId,
    projectPath,
    execute: (code, { timeoutMs = 120000 } = {}) => cliInvoke(found.executable, session.sessionId, code, { timeoutMs, spawnFn }),
    close: () => cliCloseSession(found.executable, session.sessionId, { spawnFn }),
  };
}