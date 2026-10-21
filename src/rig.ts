// Thin wrappers around the `rig` CLI and the daemon address. All OpenRig writes go through the CLI
// so its validation and transport rules apply; only the event stream is read directly.
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export type RigResult = { ok: boolean; out: string; err: string };

export function rig(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<RigResult> {
  return new Promise((resolve) => {
    execFile("rig", args, { timeout: 30000, env, maxBuffer: 16 << 20 }, (e, out, err) =>
      resolve({ ok: !e, out: String(out ?? ""), err: String(err || e?.message || "") }));
  });
}

export async function rigJson<T = any>(args: string[]): Promise<T | undefined> {
  const r = await rig([...args, "--json"]);
  try { return JSON.parse(r.out) as T; } catch { return undefined; }
}

export function daemonUrl(): string {
  if (process.env.OPENRIG_URL) return process.env.OPENRIG_URL.replace(/\/$/, "");
  try {
    const home = process.env.OPENRIG_HOME || join(homedir(), ".openrig");
    const d = JSON.parse(readFileSync(join(home, "daemon.json"), "utf8"));
    return `http://${d.host || "127.0.0.1"}:${d.port || 7433}`;
  } catch { return "http://127.0.0.1:7433"; }
}

/** rig name or id -> rig id. Looks at running rigs first, then stopped ones. */
export async function rigIdFor(nameOrId: string): Promise<string | undefined> {
  for (const extra of [[], ["--filter", "status=stopped"]]) {
    // plain `rig ps --json` is an array; with --filter it is {entries: [...]}
    const j = await rigJson<any>(["ps", ...extra]);
    const list: any[] = Array.isArray(j) ? j : j?.entries ?? [];
    const hit = list.find((e) => e.name === nameOrId || e.rigName === nameOrId || e.rigId === nameOrId);
    if (hit) return hit.rigId;
  }
  return undefined;
}

export type Seat = { session: string; logicalId: string; runtime: string; state: string };

export async function seatsOf(rigName: string): Promise<Seat[]> {
  const j = await rigJson<any>(["ps", "--nodes", "--rig", rigName]);
  const list: any[] = Array.isArray(j) ? j : j?.entries ?? j?.nodes ?? [];
  return list.map((n) => ({
    session: n.canonicalSessionName ?? n.sessionName ?? n.logicalId,
    logicalId: n.logicalId,
    runtime: n.runtime ?? "",
    state: n.agentActivity?.state ?? (n.sessionStatus === "running" ? "unknown" : "offline"),
  }));
}

/** Write a body to a temp file: `rig queue` bodies must go through --body-file (backticks break --body). */
export function bodyFile(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-openrig-"));
  const p = join(dir, "body.md");
  writeFileSync(p, text);
  return p;
}
