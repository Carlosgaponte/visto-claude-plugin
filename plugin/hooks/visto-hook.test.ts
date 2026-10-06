import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
// @ts-ignore — plain ESM module without types
import { handle } from "./visto-hook.mjs";

const fx = (n: string) => JSON.parse(readFileSync(join(__dirname, "fixtures", `${n}.json`), "utf8"));

function deps(responses: Array<{ status?: number; body?: unknown }> = []) {
  const fetch = vi.fn(async (..._args: any[]) => {
    const r = responses.shift() ?? { status: 200, body: {} };
    return { ok: (r.status ?? 200) < 300, status: r.status ?? 200, json: async () => r.body ?? {}, text: async () => JSON.stringify(r.body ?? {}) };
  });
  const exec = vi.fn((cmd: string) =>
    cmd.includes("rev-parse") ? "/Users/dev/projects/v2adesk\n" :
    cmd.includes("remote") ? "git@github.com:Carlosgaponte/v2adesk.git\n" :
    cmd.includes("branch") ? "main\n" : ""
  );
  let t = 1_000_000;

  // In-memory fake of the ~/.config/visto files — never touches the real
  // home directory. `files` and `modes` let a test inspect what got written.
  const files = new Map<string, string>();
  const modes = new Map<string, number | undefined>();
  const readFile = vi.fn((path: string) => {
    if (!files.has(path)) { const e: any = new Error(`ENOENT: ${path}`); e.code = "ENOENT"; throw e; }
    return files.get(path) as string;
  });
  const writeFile = vi.fn((path: string, data: string, mode?: number) => {
    files.set(path, data);
    modes.set(path, mode);
  });
  const mkdirp = vi.fn((_path: string, _mode?: number) => {});
  // Records the last chmod per path into the same `modes` map, so a test sees the final permissions.
  const chmod = vi.fn((path: string, mode: number) => { modes.set(path, mode); });
  const unlink = vi.fn((path: string) => {
    if (!files.has(path)) { const e: any = new Error(`ENOENT: ${path}`); e.code = "ENOENT"; throw e; }
    files.delete(path);
    modes.delete(path);
  });
  const openUrl = vi.fn((_url: string) => {});

  return {
    fetch, exec, hostname: () => "carlos-mbp", now: () => t, tick: (ms: number) => { t += ms; }, sleep: async () => {},
    readFile, writeFile, mkdirp, chmod, unlink, homedir: () => "/home/carlos", openUrl,
    files, modes,
  };
}

let scratch: string;
let env: Record<string, string>;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "visto-"));
  env = { VISTO_API_TOKEN: "v2adesk_pat_x", VISTO_BASE_URL: "https://visto.test" };
});
const withScratch = (e: any) => ({ ...e, scratchpad_dir: scratch });

const CREDENTIALS_PATH = "/home/carlos/.config/visto/credentials.json";
const PENDING_PATH = "/home/carlos/.config/visto/pending.json";
const BACKOFF_PATH = "/home/carlos/.config/visto/backoff.json";
const CONFIG_DIR = "/home/carlos/.config/visto";
const pendingJson = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ device_code: "dc1", user_code: "ABCD-EFGH", interval_s: 5, expires_at_ms: 1_000_000 + 900_000, ...extra });

describe("guards", () => {
  it("is a silent no-op when disabled, even with no token", async () => {
    const d = deps();
    expect(await handle(withScratch(fx("session-start")), { VISTO_DISABLE: "1" }, d)).toEqual({ exitCode: 0 });
    expect(d.fetch).not.toHaveBeenCalled();
  });
  it("never throws on network failure", async () => {
    const d = deps(); d.fetch.mockRejectedValue(new Error("ECONNREFUSED"));
    expect(await handle(withScratch(fx("session-start")), env, d)).toEqual({ exitCode: 0 });
  });
});

describe("sign-in flow (no token)", () => {
  const noToken = { VISTO_BASE_URL: "https://visto.test" };

  it("SessionStart with no token and no pending starts the device flow: writes pending, opens the browser, reports the code", async () => {
    const d = deps([{ body: { device_code: "dc1", user_code: "ABCD-EFGH", verification_uri: "https://visto.test/en/connect-claude", verification_uri_complete: "https://visto.test/en/connect-claude?code=ABCD-EFGH", interval: 5, expires_in: 900 } }]);
    const out = await handle(withScratch(fx("session-start")), noToken, d);

    const [url, init] = d.fetch.mock.calls[0] as any;
    expect(url).toBe("https://visto.test/api/agent-work/device");
    expect(JSON.parse(init.body)).toEqual({ machine: "carlos-mbp" });
    expect(init.headers.Authorization).toBeUndefined();

    expect(d.openUrl).toHaveBeenCalledWith("https://visto.test/en/connect-claude?code=ABCD-EFGH");
    expect(out.exitCode).toBe(0);
    expect(out.stdout.systemMessage).toContain("ABCD-EFGH");
    expect(out.stdout.systemMessage).toContain("https://visto.test/en/connect-claude?code=ABCD-EFGH");

    const pending = JSON.parse(d.files.get(PENDING_PATH)!);
    expect(pending).toEqual({ device_code: "dc1", user_code: "ABCD-EFGH", interval_s: 5, expires_at_ms: 1_000_000 + 900_000 });
    expect(d.files.has(CREDENTIALS_PATH)).toBe(false);
  });

  it("SessionStart with an unexpired pending polls instead of starting a new flow, and re-shows the code and link without opening a tab", async () => {
    const d = deps([{ body: { status: "pending" } }]);
    d.files.set(PENDING_PATH, pendingJson());
    const out = await handle(withScratch(fx("session-start")), noToken, d);
    expect((d.fetch.mock.calls[0] as any)[0]).toBe("https://visto.test/api/agent-work/device/token");
    expect(out.exitCode).toBe(0);
    expect(out.stdout.systemMessage).toContain("ABCD-EFGH");
    expect(out.stdout.systemMessage).toContain("https://visto.test/en/connect-claude?code=ABCD-EFGH");
    expect(d.openUrl).not.toHaveBeenCalled();
    expect(d.files.has(CREDENTIALS_PATH)).toBe(false);
    expect(d.files.has(PENDING_PATH)).toBe(true); // still pending, kept for the next event
  });

  it("SessionStart within the poll interval re-shows the message without polling", async () => {
    const d = deps();
    d.files.set(PENDING_PATH, pendingJson({ last_poll_ms: 1_000_000 - 1000 }));
    const out = await handle(withScratch(fx("session-start")), noToken, d);
    expect(d.fetch).not.toHaveBeenCalled();
    expect(out.stdout.systemMessage).toContain("https://visto.test/en/connect-claude?code=ABCD-EFGH");
    expect(d.openUrl).not.toHaveBeenCalled();
  });

  it("UserPromptSubmit with a pending device code polls once; still pending writes no credentials", async () => {
    const d = deps([{ body: { status: "pending" } }]);
    d.files.set(PENDING_PATH, pendingJson());
    const out = await handle(withScratch(fx("user-prompt")), noToken, d);
    expect(out).toEqual({ exitCode: 0 });
    expect(d.fetch).toHaveBeenCalledTimes(1);
    expect(d.files.has(CREDENTIALS_PATH)).toBe(false);
    expect(d.files.has(PENDING_PATH)).toBe(true);
  });

  it("UserPromptSubmit polls approved: writes credentials (mode 0o600), removes pending, then registers and creates the card with the new token", async () => {
    const d = deps([
      { body: { status: "approved", token: "v2adesk_pat_fresh", user: { name: "Carlos", email: "carlos@v2a.test" } } },
      { body: { session: { id: "sess_0123456789abcdef" }, dev_project: { id: "p1" }, card: null } },
      { body: { id: "c1" } },
    ]);
    d.files.set(PENDING_PATH, pendingJson());
    const out = await handle(withScratch(fx("user-prompt")), noToken, d);

    expect(d.files.has(PENDING_PATH)).toBe(false);
    const creds = JSON.parse(d.files.get(CREDENTIALS_PATH)!);
    expect(creds).toEqual({ token: "v2adesk_pat_fresh", base_url: "https://visto.test" });
    expect(d.modes.get(CREDENTIALS_PATH)).toBe(0o600);

    // Same event continues with the new token: registers the session and creates the card.
    expect((d.fetch.mock.calls[1] as any)[0]).toBe("https://visto.test/api/agent-work/sessions");
    expect((d.fetch.mock.calls[1] as any)[1].headers.Authorization).toBe("Bearer v2adesk_pat_fresh");
    expect((d.fetch.mock.calls[2] as any)[0]).toBe("https://visto.test/api/agent-work/cards");
    expect(out.exitCode).toBe(0);
  });

  it.each(["denied", "expired"])("poll result %s removes pending", async (status) => {
    const d = deps([{ body: { status } }]);
    d.files.set(PENDING_PATH, pendingJson());
    const out = await handle(withScratch(fx("post-tool-use")), noToken, d);
    expect(out).toEqual({ exitCode: 0 });
    expect(d.files.has(PENDING_PATH)).toBe(false);
    expect(d.files.has(CREDENTIALS_PATH)).toBe(false);
  });

  it("a 4xx from the poll endpoint also clears pending", async () => {
    const d = deps([{ status: 400, body: { error: "bad request" } }]);
    d.files.set(PENDING_PATH, pendingJson());
    const out = await handle(withScratch(fx("post-tool-use")), noToken, d);
    expect(out).toEqual({ exitCode: 0 });
    expect(d.files.has(PENDING_PATH)).toBe(false);
  });

  it.each([429, 500, 503])("an HTTP %s from the poll endpoint keeps pending to try later", async (status) => {
    const d = deps([{ status, body: { error: "later" } }]);
    d.files.set(PENDING_PATH, pendingJson());
    const out = await handle(withScratch(fx("post-tool-use")), noToken, d);
    expect(out).toEqual({ exitCode: 0 });
    expect(d.files.has(PENDING_PATH)).toBe(true);
  });

  it("a network failure while polling keeps pending for the next event", async () => {
    const d = deps(); d.fetch.mockRejectedValue(new Error("ECONNREFUSED"));
    d.files.set(PENDING_PATH, pendingJson());
    const out = await handle(withScratch(fx("post-tool-use")), noToken, d);
    expect(out).toEqual({ exitCode: 0 });
    expect(d.files.has(PENDING_PATH)).toBe(true);
  });

  it("stores last_poll_ms and skips polling until the default 5 s interval has passed", async () => {
    const d = deps([{ body: { status: "pending" } }, { body: { status: "pending" } }]);
    d.files.set(PENDING_PATH, pendingJson({ interval_s: undefined }));
    await handle(withScratch(fx("post-tool-use")), noToken, d);
    expect(d.fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(d.files.get(PENDING_PATH)!).last_poll_ms).toBe(1_000_000);

    d.tick(4000);
    await handle(withScratch(fx("post-tool-use")), noToken, d);
    expect(d.fetch).toHaveBeenCalledTimes(1); // too soon

    d.tick(1000);
    await handle(withScratch(fx("post-tool-use")), noToken, d);
    expect(d.fetch).toHaveBeenCalledTimes(2);
  });

  it("honours the server-provided interval from the start response", async () => {
    const d = deps([
      { body: { device_code: "dc1", user_code: "ABCD-EFGH", interval: 10, expires_in: 900 } },
      { body: { status: "pending" } },
      { body: { status: "pending" } },
    ]);
    await handle(withScratch(fx("session-start")), noToken, d);
    expect(JSON.parse(d.files.get(PENDING_PATH)!).interval_s).toBe(10);

    await handle(withScratch(fx("post-tool-use")), noToken, d); // first poll
    d.tick(6000);
    await handle(withScratch(fx("post-tool-use")), noToken, d); // 6 s < 10 s: skipped
    expect(d.fetch).toHaveBeenCalledTimes(2);
    d.tick(4000);
    await handle(withScratch(fx("post-tool-use")), noToken, d);
    expect(d.fetch).toHaveBeenCalledTimes(3);
  });

  it("creates ~/.config/visto as 0700 (chmod too, in case it existed) and writes pending.json as 0600", async () => {
    const d = deps([{ body: { device_code: "dc1", user_code: "ABCD-EFGH", interval: 5, expires_in: 900 } }]);
    await handle(withScratch(fx("session-start")), noToken, d);
    expect(d.mkdirp).toHaveBeenCalledWith(CONFIG_DIR, 0o700);
    expect(d.chmod).toHaveBeenCalledWith(CONFIG_DIR, 0o700);
    expect(d.modes.get(PENDING_PATH)).toBe(0o600);
    expect(d.chmod).toHaveBeenCalledWith(PENDING_PATH, 0o600);
  });

  it("rewriting an existing loose credentials.json tightens it to 0600 with chmod", async () => {
    const d = deps([{ body: { status: "approved", token: "v2adesk_pat_fresh", user: { name: "C", email: "c@x" } } }]);
    d.files.set(PENDING_PATH, pendingJson());
    d.files.set(CREDENTIALS_PATH, JSON.stringify({ token: "old", base_url: "https://elsewhere.test" }));
    d.modes.set(CREDENTIALS_PATH, 0o644);
    // writeFile's mode is ignored for an existing file on a real filesystem; simulate that.
    d.writeFile.mockImplementation((path: string, data: string, mode?: number) => {
      const existed = d.files.has(path);
      d.files.set(path, data);
      if (!existed) d.modes.set(path, mode);
    });
    await handle(withScratch(fx("post-tool-use")), noToken, d);
    expect(JSON.parse(d.files.get(CREDENTIALS_PATH)!).token).toBe("v2adesk_pat_fresh");
    expect(d.modes.get(CREDENTIALS_PATH)).toBe(0o600);
  });

  it("opens a link built on the client from the base URL — never a URL from the server", async () => {
    const d = deps([{ body: { device_code: "dc1", user_code: "ABCD-EFGH", verification_uri_complete: "https://evil.example/phish", interval: 5, expires_in: 900 } }]);
    const out = await handle(withScratch(fx("session-start")), noToken, d);
    expect(d.openUrl).toHaveBeenCalledWith("https://visto.test/en/connect-claude?code=ABCD-EFGH");
    expect(out.stdout.systemMessage).not.toContain("evil.example");
  });

  it.each(["abcd-efgh", "ABCD-EFG1", "ABCD-EFGH&x=1", "ABCDEFGH", undefined])(
    "a malformed user code (%s) opens nothing and writes no pending, but still shows a message",
    async (user_code) => {
      const d = deps([{ body: { device_code: "dc1", user_code, interval: 5, expires_in: 900 } }]);
      const out = await handle(withScratch(fx("session-start")), noToken, d);
      expect(d.openUrl).not.toHaveBeenCalled();
      expect(d.files.has(PENDING_PATH)).toBe(false);
      expect(out.stdout.systemMessage).toMatch(/^Visto:/);
    }
  );

  it("credentials for a different base URL are treated as signed out", async () => {
    const d = deps([{ body: { device_code: "dc1", user_code: "ABCD-EFGH", interval: 5, expires_in: 900 } }]);
    d.files.set(CREDENTIALS_PATH, JSON.stringify({ token: "v2adesk_pat_other", base_url: "https://other.test" }));
    const out = await handle(withScratch(fx("session-start")), noToken, d);
    const [url, init] = d.fetch.mock.calls[0] as any;
    expect(url).toBe("https://visto.test/api/agent-work/device"); // sign-in, not registration
    expect(init.headers.Authorization).toBeUndefined();
    expect(out.stdout.systemMessage).toContain("ABCD-EFGH");
  });

  it("a denied poll writes a 24 h backoff; no new sign-in starts until it passes", async () => {
    const d = deps([
      { body: { status: "denied" } },
      { body: { device_code: "dc2", user_code: "JKLM-NPQR", interval: 5, expires_in: 900 } },
    ]);
    d.files.set(PENDING_PATH, pendingJson());
    await handle(withScratch(fx("post-tool-use")), noToken, d);
    expect(d.files.has(PENDING_PATH)).toBe(false);
    expect(JSON.parse(d.files.get(BACKOFF_PATH)!).until_ms).toBe(1_000_000 + 24 * 60 * 60_000);
    expect(d.modes.get(BACKOFF_PATH)).toBe(0o600);

    d.tick(60_000);
    expect(await handle(withScratch(fx("session-start")), noToken, d)).toEqual({ exitCode: 0 });
    expect(d.fetch).toHaveBeenCalledTimes(1);
    expect(d.openUrl).not.toHaveBeenCalled();

    d.tick(24 * 60 * 60_000);
    const out = await handle(withScratch(fx("session-start")), noToken, d);
    expect(d.fetch).toHaveBeenCalledTimes(2);
    expect(out.stdout.systemMessage).toContain("JKLM-NPQR");
  });

  it("a malformed pending.json is ignored: SessionStart starts a fresh sign-in", async () => {
    const d = deps([{ body: { device_code: "dc1", user_code: "ABCD-EFGH", interval: 5, expires_in: 900 } }]);
    d.files.set(PENDING_PATH, "{}");
    const out = await handle(withScratch(fx("session-start")), noToken, d);
    expect((d.fetch.mock.calls[0] as any)[0]).toBe("https://visto.test/api/agent-work/device");
    expect(out.stdout.systemMessage).toContain("ABCD-EFGH");
  });

  it("an expired poll writes no backoff", async () => {
    const d = deps([{ body: { status: "expired" } }]);
    d.files.set(PENDING_PATH, pendingJson());
    await handle(withScratch(fx("post-tool-use")), noToken, d);
    expect(d.files.has(BACKOFF_PATH)).toBe(false);
  });

  it("SessionEnd with no token makes no network calls", async () => {
    const d = deps();
    const out = await handle(withScratch(fx("session-end")), noToken, d);
    expect(out).toEqual({ exitCode: 0 });
    expect(d.fetch).not.toHaveBeenCalled();
  });

  it("the env token takes precedence: device endpoints are never called", async () => {
    const d = deps([{ body: { session: { id: "sess_0123456789abcdef" }, dev_project: { id: "p1" }, card: null } }]);
    const out = await handle(withScratch(fx("session-start")), env, d);
    expect(out.stdout.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect((d.fetch.mock.calls[0] as any)[0]).toBe("https://visto.test/api/agent-work/sessions");
    expect(d.openUrl).not.toHaveBeenCalled();
  });

  it("uses the credentials-file token when the env var is absent", async () => {
    const d = deps([{ body: { session: { id: "sess_0123456789abcdef" }, dev_project: { id: "p1" }, card: null } }]);
    d.files.set(CREDENTIALS_PATH, JSON.stringify({ token: "v2adesk_pat_stored", base_url: "https://visto.test" }));
    const out = await handle(withScratch(fx("session-start")), noToken, d);
    expect((d.fetch.mock.calls[0] as any)[1].headers.Authorization).toBe("Bearer v2adesk_pat_stored");
    expect(out.stdout.hookSpecificOutput.hookEventName).toBe("SessionStart");
  });

  it("a stored token the server rejects with 401 is deleted so the next SessionStart re-runs sign-in", async () => {
    const d = deps([{ status: 401, body: { error: "invalid token" } }]);
    d.files.set(CREDENTIALS_PATH, JSON.stringify({ token: "v2adesk_pat_stale", base_url: "https://visto.test" }));
    const out = await handle(withScratch(fx("session-start")), noToken, d);
    expect(out).toEqual({ exitCode: 0 });
    expect(d.files.has(CREDENTIALS_PATH)).toBe(false);
  });
});

describe("SessionStart", () => {
  it("registers with repo/branch/machine and hands the session id to the model as context", async () => {
    const d = deps([{ body: { session: { id: "sess_0123456789abcdef", dev_project_id: "p1" }, dev_project: { id: "p1", slug: "v2adesk", name: "V2A Desk" }, card: null } }]);
    const out = await handle(withScratch(fx("session-start")), env, d);
    const [url, init] = d.fetch.mock.calls[0] as any;
    expect(url).toBe("https://visto.test/api/agent-work/sessions");
    expect(init.headers.Authorization).toBe("Bearer v2adesk_pat_x");
    expect(JSON.parse(init.body)).toEqual({ session_id: "sess_0123456789abcdef", repo: "git@github.com:Carlosgaponte/v2adesk.git", in_repo: true, branch: "main", machine: "carlos-mbp", cwd: "/Users/dev/projects/v2adesk" });
    expect(out.stdout.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(out.stdout.hookSpecificOutput.additionalContext).toContain("VISTO_SESSION_ID=sess_0123456789abcdef");
    expect(out.stdout.hookSpecificOutput.additionalContext).toContain("V2A Desk");
    const state = JSON.parse(readFileSync(join(scratch, "visto-sess_0123456789abcdef.json"), "utf8"));
    expect(state).toMatchObject({ dev_project_id: "p1", card_id: null, first_prompt_done: false });
  });
});

describe("folderOf / in_repo flag", () => {
  it("reports the git remote and in_repo true when a remote exists", async () => {
    const d = deps([{ body: { session: { id: "sess_0123456789abcdef" }, dev_project: { id: "p1", slug: "v2adesk", name: "V2A Desk" }, card: null } }]);
    await handle(withScratch(fx("session-start")), env, d);
    const body = JSON.parse((d.fetch.mock.calls[0] as any)[1].body);
    expect(body.repo).toBe("git@github.com:Carlosgaponte/v2adesk.git");
    expect(body.in_repo).toBe(true);
  });

  it("falls back to the top-level folder name when in a repo without a remote, started in a sub-folder", async () => {
    const d = deps([{ body: { session: { id: "sess_0123456789abcdef" }, dev_project: { id: "p1" }, card: null } }]);
    d.exec.mockImplementation((cmd: string) => (cmd.includes("rev-parse") ? "/Users/dev/projects/v2adesk\n" : ""));
    await handle(withScratch({ ...fx("session-start"), cwd: "/Users/dev/projects/v2adesk/sub/dir" }), env, d);
    const body = JSON.parse((d.fetch.mock.calls[0] as any)[1].body);
    expect(body.repo).toBe("v2adesk");
    expect(body.in_repo).toBe(true);
  });

  it("falls back to the cwd basename and in_repo false outside a repo", async () => {
    const d = deps([{ body: { session: { id: "sess_0123456789abcdef" }, dev_project: { id: "p1" }, card: null } }]);
    d.exec.mockImplementation(() => "");
    await handle(withScratch({ ...fx("session-start"), cwd: "/Users/dev/scratch-folder" }), env, d);
    const body = JSON.parse((d.fetch.mock.calls[0] as any)[1].body);
    expect(body.repo).toBe("scratch-folder");
    expect(body.in_repo).toBe(false);
  });

  it("sends in_repo from ensureRegistered too, when SessionStart never ran", async () => {
    const d = deps([{ body: { session: { id: "sess_0123456789abcdef" }, dev_project: { id: "p1" }, card: null } }, { body: { id: "c1" } }]);
    await handle(withScratch(fx("user-prompt")), env, d);
    const body = JSON.parse((d.fetch.mock.calls[0] as any)[1].body);
    expect(body.repo).toBe("git@github.com:Carlosgaponte/v2adesk.git");
    expect(body.in_repo).toBe(true);
  });
});

describe("UserPromptSubmit", () => {
  it("first prompt creates a Requested card titled with the first line", async () => {
    writeFileSync(join(scratch, "visto-sess_0123456789abcdef.json"), JSON.stringify({ dev_project_id: "p1", card_id: null, first_prompt_done: false, last_heartbeat_ms: 0 }));
    const d = deps([{ body: { id: "c1" } }]);
    await handle(withScratch(fx("user-prompt")), env, d);
    const [url, init] = d.fetch.mock.calls[0] as any;
    expect(url).toBe("https://visto.test/api/agent-work/cards");
    expect(JSON.parse(init.body)).toEqual({ dev_project_id: "p1", title: "Fix the login redirect loop", column: "requested", session_id: "sess_0123456789abcdef", created_via: "hook" });
    const state = JSON.parse(readFileSync(join(scratch, "visto-sess_0123456789abcdef.json"), "utf8"));
    expect(state).toMatchObject({ card_id: "c1", first_prompt_done: true });
  });
  it("later prompts heartbeat instead", async () => {
    writeFileSync(join(scratch, "visto-sess_0123456789abcdef.json"), JSON.stringify({ dev_project_id: "p1", card_id: "c1", first_prompt_done: true, last_heartbeat_ms: 0 }));
    const d = deps([{ body: { ok: true } }]);
    await handle(withScratch(fx("user-prompt")), env, d);
    expect((d.fetch.mock.calls[0] as any)[0]).toBe("https://visto.test/api/agent-work/sessions/sess_0123456789abcdef/heartbeat");
  });
  it("registers on the fly if SessionStart never ran", async () => {
    const d = deps([{ body: { session: { id: "sess_0123456789abcdef" }, dev_project: { id: "p1" }, card: null } }, { body: { id: "c1" } }]);
    await handle(withScratch(fx("user-prompt")), env, d);
    expect((d.fetch.mock.calls[0] as any)[0]).toBe("https://visto.test/api/agent-work/sessions");
    expect((d.fetch.mock.calls[1] as any)[0]).toBe("https://visto.test/api/agent-work/cards");
  });
});

describe("PermissionRequest", () => {
  const state = () => writeFileSync(join(scratch, "visto-sess_0123456789abcdef.json"), JSON.stringify({ dev_project_id: "p1", card_id: "c1", first_prompt_done: true, last_heartbeat_ms: 0 }));
  it("creates an approval with the verbatim command and returns allow when the board answers", async () => {
    state();
    const d = deps([{ body: { id: "d1", status: "open" } }, { body: { id: "d1", status: "open" } }, { body: { id: "d1", status: "answered", answer: "allow" } }]);
    const out = await handle(withScratch(fx("permission-request")), { ...env, VISTO_APPROVAL_WAIT_SECONDS: "60" }, d);
    const [url, init] = d.fetch.mock.calls[0] as any;
    expect(url).toBe("https://visto.test/api/agent-work/cards/c1/decisions");
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ kind: "approval", source: "hook_permission", expires_in_seconds: 60 });
    expect(body.question).toContain("Bash");
    expect(body.question).toContain("rm -rf dist && npm run build");
    expect((d.fetch.mock.calls[1] as any)[0]).toBe("https://visto.test/api/agent-work/decisions/d1?wait=25");
    expect(out.stdout).toEqual({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: "allow", decisionReason: "Approved on the Visto board" } });
  });
  it("returns deny when denied", async () => {
    state();
    const d = deps([{ body: { id: "d1" } }, { body: { id: "d1", status: "answered", answer: "deny" } }]);
    const out = await handle(withScratch(fx("permission-request")), env, d);
    expect(out.stdout.hookSpecificOutput.decision).toBe("deny");
  });
  it("steps aside (no stdout) when the wait runs out", async () => {
    state();
    const d = deps([{ body: { id: "d1" } }]);
    d.fetch.mockImplementation(async (url: any) => { if (String(url).includes("?wait=")) d.tick(26_000); return { ok: true, status: 200, json: async () => ({ id: "d1", status: "open" }), text: async () => "" }; });
    const out = await handle(withScratch(fx("permission-request")), { ...env, VISTO_APPROVAL_WAIT_SECONDS: "60" }, d);
    expect(out).toEqual({ exitCode: 0 });
  });
  it("gives the long poll a timeout that outlives the server-side wait while the create call keeps the short one", async () => {
    state();
    const d = deps([{ body: { id: "d1", status: "open" } }, { body: { id: "d1", status: "answered", answer: "allow" } }]);
    await handle(withScratch(fx("permission-request")), { ...env, VISTO_APPROVAL_WAIT_SECONDS: "60" }, d);
    const timeoutOf = (call: any[]) => (typeof call[2] === "number" ? call[2] : call[1]?.timeoutMs);
    expect(timeoutOf(d.fetch.mock.calls[0] as any)).toBe(5000);
    expect(timeoutOf(d.fetch.mock.calls[1] as any)).toBeGreaterThanOrEqual(30_000);
  });
  it("retries the poll after a dropped connection instead of abandoning the window", async () => {
    state();
    const d = deps([{ body: { id: "d1", status: "open" } }]);
    let poll = 0;
    const base = d.fetch.getMockImplementation()!;
    d.fetch.mockImplementation(async (...args: any[]) => {
      if (String(args[0]).includes("?wait=")) {
        poll += 1;
        if (poll === 1) throw new Error("timeout");
        return { ok: true, status: 200, json: async () => ({ id: "d1", status: "answered", answer: "allow" }), text: async () => "" };
      }
      return base(...args);
    });
    const out = await handle(withScratch(fx("permission-request")), { ...env, VISTO_APPROVAL_WAIT_SECONDS: "60" }, d);
    expect(poll).toBe(2);
    expect(out.stdout.hookSpecificOutput.decision).toBe("allow");
  });
  it("logs one stderr line when the decision cannot be created", async () => {
    state();
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const d = deps([{ status: 409, body: { error: "open" } }]);
    expect(await handle(withScratch(fx("permission-request")), env, d)).toEqual({ exitCode: 0 });
    expect(write).toHaveBeenCalledWith(expect.stringContaining("[visto] PermissionRequest: could not create decision: HTTP 409"));
    write.mockRestore();
  });
  it("steps aside when there is no card or a 409 conflict", async () => {
    writeFileSync(join(scratch, "visto-sess_0123456789abcdef.json"), JSON.stringify({ dev_project_id: "p1", card_id: null, first_prompt_done: false, last_heartbeat_ms: 0 }));
    const d = deps();
    expect(await handle(withScratch(fx("permission-request")), env, d)).toEqual({ exitCode: 0 });
    expect(d.fetch).not.toHaveBeenCalled();
    state();
    const d2 = deps([{ status: 409, body: { error: "open" } }]);
    expect(await handle(withScratch(fx("permission-request")), env, d2)).toEqual({ exitCode: 0 });
  });
});

describe("PostToolUse / Stop heartbeat throttle", () => {
  it("heartbeats at most once per 2 minutes", async () => {
    writeFileSync(join(scratch, "visto-sess_0123456789abcdef.json"), JSON.stringify({ dev_project_id: "p1", card_id: "c1", first_prompt_done: true, last_heartbeat_ms: 1_000_000 - 30_000 }));
    const d = deps();
    await handle(withScratch(fx("post-tool-use")), env, d);
    expect(d.fetch).not.toHaveBeenCalled();
    d.tick(130_000);
    await handle(withScratch(fx("post-tool-use")), env, d);
    expect((d.fetch.mock.calls[0] as any)[0]).toContain("/heartbeat");
  });
});

describe("SessionEnd", () => {
  it("posts end and removes the state file", async () => {
    writeFileSync(join(scratch, "visto-sess_0123456789abcdef.json"), JSON.stringify({ dev_project_id: "p1", card_id: "c1", first_prompt_done: true, last_heartbeat_ms: 0 }));
    const d = deps();
    await handle(withScratch(fx("session-end")), env, d);
    expect((d.fetch.mock.calls[0] as any)[0]).toBe("https://visto.test/api/agent-work/sessions/sess_0123456789abcdef/end");
    expect(existsSync(join(scratch, "visto-sess_0123456789abcdef.json"))).toBe(false);
  });
});
