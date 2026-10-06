#!/usr/bin/env node
// Visto Agent Work hook for Claude Code. One script, dispatches on
// hook_event_name. Never blocks a session: any failure exits 0 silently.
import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, hostname as osHostname, homedir as osHomedir } from "node:os";
import { execSync, spawn } from "node:child_process";

const HEARTBEAT_EVERY_MS = 2 * 60_000;
const POLL_WAIT_SECONDS = 25;
const HTTP_TIMEOUT_MS = 5000;

const POLL_FAILURE_LIMIT = 5;
const POLL_RETRY_DELAY_MS = 2000;

/** Default gap between device-token polls when the server did not say (RFC 8628 `interval`). */
const DEFAULT_SIGNIN_POLL_INTERVAL_S = 5;
/** After the person clicks Deny, wait this long before offering sign-in again. */
const DENIED_BACKOFF_MS = 24 * 60 * 60_000;
/** The only user-code shape the browser link is ever built from. */
const USER_CODE_RE = /^[A-Z2-9]{4}-[A-Z2-9]{4}$/;

const defaultDeps = {
  fetch: (url, init, timeoutMs) => globalThis.fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs ?? HTTP_TIMEOUT_MS) }),
  exec: (cmd, cwd) => execSync(cmd, { cwd, stdio: ["ignore", "pipe", "ignore"], timeout: 2000 }).toString(),
  hostname: () => osHostname(),
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  readFile: (path) => readFileSync(path, "utf8"),
  writeFile: (path, data, mode) => writeFileSync(path, data, mode !== undefined ? { mode } : undefined),
  mkdirp: (path, mode) => mkdirSync(path, mode !== undefined ? { recursive: true, mode } : { recursive: true }),
  chmod: (path, mode) => chmodSync(path, mode),
  unlink: (path) => unlinkSync(path),
  homedir: () => osHomedir(),
  // Fire-and-forget: errors are swallowed and we never await beyond spawning,
  // so a headless box (no browser, no `open`/`xdg-open`) never blocks the hook.
  openUrl: (url) => {
    try {
      const platform = process.platform;
      if (platform === "darwin") spawn("open", [url], { stdio: "ignore", detached: true }).unref();
      else if (platform === "win32") spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true }).unref();
      else spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref();
    } catch { /* ignore */ }
  },
};

function statePath(ev) {
  return join(ev.scratchpad_dir || tmpdir(), `visto-${ev.session_id}.json`);
}
function readState(ev) {
  try { return JSON.parse(readFileSync(statePath(ev), "utf8")); } catch { return null; }
}
function writeState(ev, s) {
  try { writeFileSync(statePath(ev), JSON.stringify(s)); } catch { /* ignore */ }
}

function basename(p) {
  return (p || "").split("/").filter(Boolean).pop() || "unknown";
}

// --- Sign-in flow: ~/.config/visto/{credentials,pending,backoff}.json ------
//
// The directory is 0700 and every file in it 0600, re-applied with chmod on
// each write: writeFile's `mode` only takes effect when a file is created, so
// without the chmod a file first written loosely would stay loose forever.

function configDir(deps) {
  return join(deps.homedir(), ".config", "visto");
}
function credentialsPath(deps) {
  return join(configDir(deps), "credentials.json");
}
function pendingPath(deps) {
  return join(configDir(deps), "pending.json");
}
function backoffPath(deps) {
  return join(configDir(deps), "backoff.json");
}
function readJsonFile(deps, path) {
  try { return JSON.parse(deps.readFile(path)); } catch { return null; }
}
function writeJsonFile(deps, path, value) {
  try {
    const dir = configDir(deps);
    deps.mkdirp(dir, 0o700);
    deps.chmod(dir, 0o700);
    deps.writeFile(path, JSON.stringify(value), 0o600);
    deps.chmod(path, 0o600);
  } catch { /* ignore — a failed write just means sign-in is retried next event */ }
}
function deleteFile(deps, path) {
  try { deps.unlink(path); } catch { /* already gone */ }
}

/** Stored credentials, but only for the Visto this hook is pointed at; another base URL's token counts as signed out. */
function readCredentials(env, deps) {
  const creds = readJsonFile(deps, credentialsPath(deps));
  if (!creds || !creds.token || creds.base_url !== baseUrlOf(env)) return null;
  return creds;
}
function writeCredentials(deps, token, baseUrl) { writeJsonFile(deps, credentialsPath(deps), { token, base_url: baseUrl }); }
function deleteCredentials(deps) { deleteFile(deps, credentialsPath(deps)); }

/** A pending sign-in, or null when there is none — a malformed file counts as none, so it can't wedge sign-in. */
function readPending(deps) {
  const p = readJsonFile(deps, pendingPath(deps));
  return p && typeof p.device_code === "string" && typeof p.expires_at_ms === "number" ? p : null;
}
function writePending(deps, pending) { writeJsonFile(deps, pendingPath(deps), pending); }
function deletePending(deps) { deleteFile(deps, pendingPath(deps)); }

function inBackoff(deps) {
  const b = readJsonFile(deps, backoffPath(deps));
  return Boolean(b && typeof b.until_ms === "number" && b.until_ms > deps.now());
}
function writeBackoff(deps) { writeJsonFile(deps, backoffPath(deps), { until_ms: deps.now() + DENIED_BACKOFF_MS }); }

/**
 * The approval link, built here from the base URL the person configured —
 * never a URL taken from the server response — and only for a well-formed code.
 */
function approvalUrl(env, userCode) {
  if (typeof userCode !== "string" || !USER_CODE_RE.test(userCode)) return null;
  return `${baseUrlOf(env)}/en/connect-claude?code=${userCode}`;
}
function approvalMessage(userCode, url) {
  return `Visto: approve this computer in your browser — code ${userCode} (${url})`;
}

/**
 * @param {any} ev
 * @param {any} deps
 * @returns {{ repo: string, in_repo: boolean }}
 */
function folderOf(ev, deps) {
  let top = "";
  try { top = deps.exec("git rev-parse --show-toplevel", ev.cwd).trim(); } catch { /* not a repo */ }
  if (!top) return { repo: basename(ev.cwd), in_repo: false };
  try {
    const remote = deps.exec("git remote get-url origin", ev.cwd).trim();
    if (remote) return { repo: remote, in_repo: true };
  } catch { /* no remote */ }
  return { repo: basename(top), in_repo: true };
}
function branchOf(ev, deps) {
  try { return deps.exec("git branch --show-current", ev.cwd).trim() || undefined; } catch { return undefined; }
}

function baseUrlOf(env) {
  return (env.VISTO_BASE_URL || "https://v2adesk.com").replace(/\/+$/, "");
}

function api(env, deps, token) {
  const base = baseUrlOf(env);
  return async (path, body, method = body === undefined ? "GET" : "POST", timeoutMs = HTTP_TIMEOUT_MS) => {
    const res = await deps.fetch(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }, timeoutMs);
    if (!res.ok) { const e = new Error(`HTTP ${res.status}`); e.status = res.status; throw e; }
    return res.json();
  };
}

// The device-authorization start/poll routes are public — no Visto account
// is connected yet, so there is no bearer token to send.
function anonApi(env, deps) {
  const base = baseUrlOf(env);
  return async (path, body, timeoutMs = HTTP_TIMEOUT_MS) => {
    const res = await deps.fetch(`${base}${path}`, {
      method: "POST",
      headers: body !== undefined ? { "Content-Type": "application/json" } : {},
      body: body === undefined ? undefined : JSON.stringify(body),
    }, timeoutMs);
    if (!res.ok) { const e = new Error(`HTTP ${res.status}`); e.status = res.status; throw e; }
    return res.json();
  };
}

/** SessionStart with no token and no (unexpired) pending device code: kick off RFC-8628-style sign-in. */
async function startSignIn(ev, env, deps) {
  // Someone clicked Deny recently: don't nag them with a new browser tab every session.
  if (inBackoff(deps)) return { exitCode: 0 };

  const call = anonApi(env, deps);
  const out = await call("/api/agent-work/device", { machine: deps.hostname() });
  const url = approvalUrl(env, out.user_code);
  if (!url || typeof out.device_code !== "string") {
    return { exitCode: 0, stdout: { systemMessage: "Visto: sign-in could not start (unexpected reply from the server). It will try again next session." } };
  }
  const interval = Number(out.interval);
  writePending(deps, {
    device_code: out.device_code,
    user_code: out.user_code,
    interval_s: Number.isFinite(interval) && interval >= 1 && interval <= 60 ? interval : DEFAULT_SIGNIN_POLL_INTERVAL_S,
    expires_at_ms: deps.now() + out.expires_in * 1000,
  });
  deps.openUrl(url);
  return { exitCode: 0, stdout: { systemMessage: approvalMessage(out.user_code, url) } };
}

/**
 * Polls the device-token endpoint once for a pending sign-in.
 * Returns the freshly minted token on approval (after writing the
 * credentials file and clearing pending.json), or null otherwise:
 * - called again before the server's interval (default 5 s) has passed since
 *   the last poll: skipped, no request made.
 * - "pending": nothing to do yet, pending.json is kept.
 * - "denied": pending.json is cleared and a 24-hour backoff is written, so no
 *   new sign-in starts until it passes.
 * - "expired", or an HTTP 4xx other than 429: pending.json is cleared so the
 *   next SessionStart starts over.
 * - 429, 5xx, or a network failure: pending.json is kept, retried later.
 */
async function pollOnce(env, deps, pending) {
  const intervalMs = (Number(pending.interval_s) || DEFAULT_SIGNIN_POLL_INTERVAL_S) * 1000;
  if (typeof pending.last_poll_ms === "number" && deps.now() - pending.last_poll_ms < intervalMs) return null;
  writePending(deps, { ...pending, last_poll_ms: deps.now() });

  const call = anonApi(env, deps);
  let result;
  try {
    result = await call("/api/agent-work/device/token", { device_code: pending.device_code });
  } catch (err) {
    const status = err && typeof err.status === "number" ? err.status : null;
    if (status !== null && status >= 400 && status < 500 && status !== 429) deletePending(deps);
    return null;
  }
  if (result.status === "approved") {
    writeCredentials(deps, result.token, baseUrlOf(env));
    deletePending(deps);
    return result.token;
  }
  if (result.status === "denied") {
    deletePending(deps);
    writeBackoff(deps);
  } else if (result.status === "expired") {
    deletePending(deps);
  }
  return null;
}

async function ensureRegistered(ev, env, deps, call) {
  let state = readState(ev);
  if (state && state.dev_project_id) return state;
  const { repo, in_repo } = folderOf(ev, deps);
  const out = await call("/api/agent-work/sessions", {
    session_id: ev.session_id, repo, in_repo, branch: branchOf(ev, deps), machine: deps.hostname(), cwd: ev.cwd,
  });
  state = { dev_project_id: out.dev_project.id, dev_project_name: out.dev_project.name, card_id: out.card ? out.card.id : null, first_prompt_done: Boolean(out.card), last_heartbeat_ms: deps.now() };
  writeState(ev, state);
  return state;
}

async function heartbeat(ev, env, deps, call, state, extra = {}) {
  await call(`/api/agent-work/sessions/${ev.session_id}/heartbeat`, extra);
  writeState(ev, { ...state, last_heartbeat_ms: deps.now() });
}

function describeTool(ev) {
  const input = ev.tool_input || {};
  if (ev.tool_name === "Bash" && typeof input.command === "string") return `Bash\n\n${input.command}`;
  return `${ev.tool_name}\n\n${JSON.stringify(input, null, 2)}`;
}

/**
 * Pure-ish entry point. Returns { exitCode, stdout? }.
 * @param {any} ev
 * @param {any} env
 * @param {any} [deps]
 * @returns {Promise<{ exitCode: number, stdout?: any }>}
 */
export async function handle(ev, env, deps = defaultDeps) {
  const ok = { exitCode: 0 };
  if (env.VISTO_DISABLE === "1" || !ev || !ev.session_id) return ok;

  // Token resolution order: env var, then the credentials file left by a
  // completed sign-in. `tokenSource` controls what a 401 does below — only a
  // *stored* token (the credentials file) is cleared on rejection; a token
  // the person set in the environment is theirs to fix.
  let token = env.VISTO_API_TOKEN || null;
  let tokenSource = token ? "env" : null;
  if (!token) {
    const creds = readCredentials(env, deps);
    if (creds) { token = creds.token; tokenSource = "file"; }
  }

  if (!token) {
    try {
      if (ev.hook_event_name === "SessionStart") {
        const pending = readPending(deps);
        if (!pending || pending.expires_at_ms <= deps.now()) return await startSignIn(ev, env, deps);
        token = await pollOnce(env, deps, pending);
        if (!token) {
          // Still waiting: remind the person of the code and link (no new tab).
          const still = readPending(deps);
          const url = still ? approvalUrl(env, still.user_code) : null;
          return url ? { exitCode: 0, stdout: { systemMessage: approvalMessage(still.user_code, url) } } : ok;
        }
        tokenSource = "file";
      } else if (ev.hook_event_name === "UserPromptSubmit" || ev.hook_event_name === "PostToolUse" || ev.hook_event_name === "Stop") {
        const pending = readPending(deps);
        if (!pending) return ok;
        token = await pollOnce(env, deps, pending);
        if (!token) return ok;
        tokenSource = "file";
      } else {
        // SessionEnd, PermissionRequest, SubagentStart/Stop: nothing useful
        // to do without a connected account, and no state file should exist
        // yet anyway since registration needs a token.
        return ok;
      }
    } catch (err) {
      process.stderr.write(`[visto] ${ev.hook_event_name}: ${err && err.message ? err.message : err}\n`);
      return ok;
    }
  }

  const call = api(env, deps, token);

  try {
    switch (ev.hook_event_name) {
      case "SessionStart": {
        const { repo, in_repo } = folderOf(ev, deps);
        const out = await call("/api/agent-work/sessions", {
          session_id: ev.session_id, repo, in_repo, branch: branchOf(ev, deps), machine: deps.hostname(), cwd: ev.cwd,
        });
        writeState(ev, { dev_project_id: out.dev_project.id, dev_project_name: out.dev_project.name, card_id: out.card ? out.card.id : null, first_prompt_done: Boolean(out.card), last_heartbeat_ms: deps.now() });
        const ctx = [
          `Visto Agent Work is active for this session. VISTO_SESSION_ID=${ev.session_id}.`,
          `Development project: ${out.dev_project.name || out.dev_project.slug} (id ${out.dev_project.id}).`,
          out.card ? `Existing card: "${out.card.title}" (id ${out.card.id}, column ${out.card.column}).` : `No card yet; the hook creates one in Requested on your first prompt.`,
          `Repo: ${repo}. Pass session_id and repo to every visto agent_* tool. Follow the visto-agent-work skill.`,
        ].join(" ");
        return { exitCode: 0, stdout: { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: ctx } } };
      }

      case "UserPromptSubmit": {
        const state = await ensureRegistered(ev, env, deps, call);
        if (!state.first_prompt_done) {
          const title = String(ev.prompt || "").split("\n").find((l) => l.trim())?.trim().slice(0, 120) || "New session";
          const card = await call("/api/agent-work/cards", { dev_project_id: state.dev_project_id, title, column: "requested", session_id: ev.session_id, created_via: "hook" });
          writeState(ev, { ...state, card_id: card.id, first_prompt_done: true, last_heartbeat_ms: deps.now() });
        } else {
          await heartbeat(ev, env, deps, call, state);
        }
        return ok;
      }

      case "PermissionRequest": {
        const state = readState(ev);
        if (!state || !state.card_id) return ok;
        const waitSeconds = Math.max(5, parseInt(env.VISTO_APPROVAL_WAIT_SECONDS || "60", 10) || 60);
        let decision;
        try {
          decision = await call(`/api/agent-work/cards/${state.card_id}/decisions`, { kind: "approval", source: "hook_permission", question: describeTool(ev), expires_in_seconds: waitSeconds });
        } catch (e) {
          // 409 (already waiting) or anything else: let the terminal prompt show
          process.stderr.write(`[visto] PermissionRequest: could not create decision: ${e && e.message ? e.message : e}\n`);
          return ok;
        }
        const deadline = deps.now() + waitSeconds * 1000;
        let failures = 0;
        while (deps.now() < deadline) {
          const remaining = Math.ceil((deadline - deps.now()) / 1000);
          const waitForThisPoll = Math.min(POLL_WAIT_SECONDS, remaining);
          let d;
          try {
            d = await call(`/api/agent-work/decisions/${decision.id}?wait=${waitForThisPoll}`, undefined, "GET", (waitForThisPoll + 5) * 1000);
          } catch {
            // A dropped or timed-out poll must not abandon the approval window.
            failures += 1;
            if (failures >= POLL_FAILURE_LIMIT) return ok;
            await deps.sleep(POLL_RETRY_DELAY_MS);
            continue;
          }
          failures = 0;
          if (d.status === "answered" && (d.answer === "allow" || d.answer === "deny")) {
            return { exitCode: 0, stdout: { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: d.answer, decisionReason: d.answer === "allow" ? "Approved on the Visto board" : "Denied on the Visto board" } } };
          }
          if (d.status !== "open") return ok;
        }
        return ok; // window passed: terminal prompt appears; sweep/heartbeat closes the request
      }

      case "PostToolUse":
      case "Stop": {
        const state = readState(ev);
        if (!state) return ok;
        if (deps.now() - (state.last_heartbeat_ms || 0) >= HEARTBEAT_EVERY_MS) await heartbeat(ev, env, deps, call, state);
        return ok;
      }

      case "SubagentStart":
      case "SubagentStop": {
        const state = readState(ev);
        if (!state) return ok;
        const count = Math.max(0, (state.subagents || 0) + (ev.hook_event_name === "SubagentStart" ? 1 : -1));
        writeState(ev, { ...state, subagents: count });
        await heartbeat(ev, env, deps, call, { ...state, subagents: count }, { subagent_count: count });
        if (state.card_id) {
          await call(`/api/agent-work/cards/${state.card_id}/notes`, { body: `${ev.hook_event_name === "SubagentStart" ? "Started" : "Finished"} subagent${ev.agent_type ? ` ${ev.agent_type}` : ""}` }).catch(() => {});
        }
        return ok;
      }

      case "SessionEnd": {
        await call(`/api/agent-work/sessions/${ev.session_id}/end`, {}).catch(() => {});
        try { if (existsSync(statePath(ev))) unlinkSync(statePath(ev)); } catch { /* ignore */ }
        return ok;
      }

      default:
        return ok;
    }
  } catch (err) {
    if (err && err.status === 401 && tokenSource === "file") {
      // The stored token no longer works (revoked, expired, account removed):
      // drop it silently so the next SessionStart re-runs sign-in.
      deleteCredentials(deps);
      return ok;
    }
    process.stderr.write(`[visto] ${ev.hook_event_name}: ${err && err.message ? err.message : err}\n`);
    return ok;
  }
}

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  let ev = null;
  try { ev = JSON.parse(raw); } catch { /* ignore */ }
  const out = await handle(ev, process.env, defaultDeps);
  if (out.stdout) process.stdout.write(JSON.stringify(out.stdout));
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
