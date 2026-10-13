import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerAgent } from "../src/agents.js";
import { openDb, type Db } from "../src/db.js";
import { claudeCli, type AgentCli } from "../src/hive/agent-cli.js";
import { parseConfig, type AgentConfig } from "../src/hive/config.js";
import { startHive } from "../src/hive/hive.js";
import { sendMessage } from "../src/messages.js";

const root = resolve(import.meta.dirname, "..");
const serverEntry = join(root, "node_modules/.bin/tsx");
let dir: string;
let dbFile: string;
let db: Db;
let logPath: string;
let hives: ReturnType<typeof startHive>[] = [];
let argvSeen: string[][] = [];
let configModes: number[] = [];

/** An AgentCli that runs the stand-in script; the server it talks to is the real src/index.ts. */
const standIn = (mode: string): AgentCli => ({
  build(spec) {
    argvSeen.push([spec.mcpConfigPath, mode, logPath]);
    configModes.push(statSync(spec.mcpConfigPath).mode & 0o777);
    return {
      command: process.execPath,
      args: [join(root, "test/fixtures/stand-in-agent.mjs"), spec.mcpConfigPath, mode, logPath],
      stdin: spec.prompt,
    };
  },
  parseSessionId: (out) => /"session_id":"([^"]+)"/.exec(out)?.[1],
});

const agentConfig = (name: string, extra: Partial<AgentConfig> = {}): AgentConfig => ({
  name,
  cli: "stand-in",
  key: `key-${name}`,
  cwd: dir,
  allowedTools: [],
  timeoutSeconds: 30,
  ...extra,
});

function start(agents: AgentConfig[], cli: AgentCli) {
  const hive = startHive(db, { pollMs: 50, agents }, {
    clis: { "stand-in": cli },
    serverCommand: { command: serverEntry, args: [join(root, "src/index.ts")] },
    dbFile,
    log: () => {},
  });
  hives.push(hive);
  return hive;
}

async function until(cond: () => boolean, ms = 20000) {
  const t = Date.now();
  while (!cond()) {
    if (Date.now() - t > ms) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 25));
  }
}

const runs = (agent?: string) =>
  db
    .prepare("SELECT * FROM hive_runs WHERE (? IS NULL OR agent = ?) ORDER BY id")
    .all(agent ?? null, agent ?? null) as {
    id: number; agent: string; message_ids: string; started_at: number; ended_at: number | null;
    exit_status: string | null; session_id: string | null; error: string | null;
  }[];
const finished = (n: number, agent?: string) => () => runs(agent).filter((r) => r.ended_at !== null).length >= n;
const unread = (agent: string) =>
  (db.prepare("SELECT COUNT(*) AS n FROM messages m JOIN agents a ON a.id = m.recipient_id WHERE a.name = ? AND m.read_at IS NULL").get(agent) as { n: number }).n;
const inbox = (agent: string) =>
  (db.prepare("SELECT m.sender, m.body FROM messages m JOIN agents a ON a.id = m.recipient_id WHERE a.name = ? ORDER BY m.id").all(agent)) as { sender: string; body: string }[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memory-cp-hive-test-"));
  dbFile = join(dir, "db.sqlite");
  logPath = join(dir, "log.jsonl");
  writeFileSync(logPath, "");
  db = openDb(dbFile);
  registerAgent(db, "boss", undefined, "boss-key");
  argvSeen = [];
  configModes = [];
});

afterEach(async () => {
  await Promise.all(hives.splice(0).map((h) => h.stop()));
  db.close();
});

describe("run loop", () => {
  it("runs the agent on a message; its reply lands in the sender's inbox; the run is recorded", async () => {
    start([agentConfig("worker-1")], standIn("reply"));
    sendMessage(db, "boss", "worker-1", "please summarise");
    await until(finished(1));
    const [run] = runs();
    expect(run).toMatchObject({ agent: "worker-1", exit_status: "ok", error: null });
    expect(JSON.parse(run.message_ids)).toHaveLength(1);
    expect(run.session_id).toMatch(/^sess-/);
    expect(run.ended_at!).toBeGreaterThanOrEqual(run.started_at);
    expect(inbox("boss")).toEqual([{ sender: "worker-1", body: "done: please summarise" }]);
  }, 30000);

  it("marks messages read when the run starts, not when it ends", async () => {
    start([agentConfig("worker-1", { timeoutSeconds: 1 })], standIn("hang"));
    sendMessage(db, "boss", "worker-1", "go");
    await until(() => runs().length === 1);
    expect(unread("worker-1")).toBe(0);
    expect(runs()[0].ended_at).toBeNull();
  });

  it("does not hand a message out again after a restart", async () => {
    const first = start([agentConfig("worker-1")], standIn("fail"));
    sendMessage(db, "boss", "worker-1", "once");
    await until(finished(1));
    await first.stop();
    start([agentConfig("worker-1")], standIn("fail"));
    await new Promise((r) => setTimeout(r, 400));
    expect(runs()).toHaveLength(1);
  });

  it("runs one at a time per agent and queues later messages for the next run, in order", async () => {
    // The stand-in's reply mode takes a moment to start, so these arrive during or before the first run.
    start([agentConfig("worker-1")], standIn("reply"));
    sendMessage(db, "boss", "worker-1", "one");
    await until(() => runs().length >= 1);
    sendMessage(db, "boss", "worker-1", "two");
    sendMessage(db, "boss", "worker-1", "three");
    await until(() => inbox("boss").length >= 2 && finished(runs().length)() && unread("worker-1") === 0 && runs().length >= 2);
    const rs = runs();
    for (let i = 1; i < rs.length; i++) expect(rs[i].started_at).toBeGreaterThanOrEqual(rs[i - 1].ended_at!);
    const ids = rs.flatMap((r) => JSON.parse(r.message_ids) as number[]);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(3);
  }, 40000);

  it("resumes the previous session id", async () => {
    const seen: (string | undefined)[] = [];
    const cli = standIn("reply");
    start([agentConfig("worker-1")], { ...cli, build: (s) => (seen.push(s.resumeSessionId), cli.build(s)) });
    sendMessage(db, "boss", "worker-1", "a");
    await until(finished(1));
    sendMessage(db, "boss", "worker-1", "b");
    await until(finished(2));
    expect(seen[0]).toBeUndefined();
    expect(seen[1]).toBe(runs()[0].session_id);
  }, 40000);

  it("isolates failures: a failing agent is recorded and others still run", async () => {
    registerAgent(db, "bad", undefined, "key-bad");
    const cli: AgentCli = { ...standIn("reply"), build: (s) => (s.agent === "bad" ? standIn("fail").build(s) : standIn("reply").build(s)) };
    start([agentConfig("bad"), agentConfig("good")], cli);
    sendMessage(db, "boss", "bad", "x");
    sendMessage(db, "boss", "good", "y");
    await until(finished(2));
    expect(runs("bad")[0]).toMatchObject({ exit_status: "exit 3", error: "stand-in failed" });
    expect(runs("good")[0].exit_status).toBe("ok");
    sendMessage(db, "boss", "bad", "again");
    await until(finished(2, "bad"));
  }, 40000);

  it("records a missing command as an error and keeps going", async () => {
    const cli: AgentCli = { build: (s) => ({ command: "/nonexistent/agent-cli", args: [], stdin: s.prompt }), parseSessionId: () => undefined };
    start([agentConfig("worker-1")], cli);
    sendMessage(db, "boss", "worker-1", "x");
    await until(finished(1));
    expect(runs()[0].exit_status).toBe("error");
    sendMessage(db, "boss", "worker-1", "y");
    await until(finished(2));
  });

  it("kills a run that exceeds its timeout and records it", async () => {
    start([agentConfig("worker-1", { timeoutSeconds: 0.5 })], standIn("hang"));
    sendMessage(db, "boss", "worker-1", "x");
    await until(finished(1));
    expect(runs()[0].exit_status).toBe("timeout");
  });

  it("passes the key only through a 0600 file, never in argv or the prompt", async () => {
    const cli = standIn("reply");
    let spec: Parameters<AgentCli["build"]>[0] | undefined;
    start([agentConfig("worker-1", { key: "s3cret-key" })], { ...cli, build: (s) => ((spec = s), cli.build(s)) });
    sendMessage(db, "boss", "worker-1", "x");
    await until(finished(1));
    expect(configModes).toEqual([0o600]);
    const built = claudeCli.build(spec!);
    expect(JSON.stringify(built.args)).not.toContain("s3cret-key");
    expect(spec!.prompt).not.toContain("s3cret-key");
    expect(JSON.stringify(spec)).not.toContain("s3cret-key");
  });

  it("leaves messages unread for an agent whose CLI is unknown", async () => {
    registerAgent(db, "worker-1", undefined, "key-worker-1");
    start([agentConfig("worker-1", { cli: "missing" })], standIn("reply"));
    sendMessage(db, "boss", "worker-1", "x");
    await new Promise((r) => setTimeout(r, 300));
    expect(runs()).toHaveLength(0);
    expect(unread("worker-1")).toBe(1);
  });

  it("marks runs left unfinished by an earlier hive as abandoned", async () => {
    const first = start([agentConfig("worker-1")], standIn("hang"));
    await first.stop();
    db.prepare("INSERT INTO hive_runs (agent, message_ids, started_at) VALUES ('worker-1', '[1]', 1)").run();
    start([agentConfig("worker-1")], standIn("reply"));
    expect(runs()[0]).toMatchObject({ exit_status: "abandoned", error: expect.stringContaining("stopped") });
  });

  it("starts afresh when resuming the last session failed", async () => {
    const seen: (string | undefined)[] = [];
    let mode = "reply";
    const cli: AgentCli = { ...standIn("reply"), build: (s) => (seen.push(s.resumeSessionId), standIn(mode).build(s)) };
    start([agentConfig("worker-1")], cli);
    sendMessage(db, "boss", "worker-1", "a");
    await until(finished(1));
    mode = "fail";
    sendMessage(db, "boss", "worker-1", "b");
    await until(finished(2));
    mode = "reply";
    sendMessage(db, "boss", "worker-1", "c");
    await until(finished(3));
    expect(seen[1]).toBe(runs()[0].session_id);
    expect(seen[2]).toBeUndefined();
  }, 40000);

  it("is not blocked by a child that outlives the agent CLI and holds its pipes", async () => {
    const cli: AgentCli = {
      build: (s) => ({ command: "sh", args: ["-c", "sleep 30 & echo done"], stdin: s.prompt }),
      parseSessionId: () => undefined,
    };
    start([agentConfig("worker-1")], cli);
    sendMessage(db, "boss", "worker-1", "x");
    await until(finished(1), 8000);
    expect(runs()[0].exit_status).toBe("ok");
  });

  it("ignores agents not in the config", async () => {
    registerAgent(db, "other", undefined, "k");
    start([agentConfig("worker-1")], standIn("reply"));
    sendMessage(db, "boss", "other", "x");
    await new Promise((r) => setTimeout(r, 300));
    expect(runs()).toHaveLength(0);
    expect(unread("other")).toBe(1);
  });
});

describe("claude command line", () => {
  const spec = { agent: "a", cwd: "/w", prompt: "P", mcpConfigPath: "/tmp/m.json", allowedTools: ["Read", "Bash(git status)"] };

  it("uses only flags for permissions and never bypasses them", () => {
    const { args, stdin } = claudeCli.build({ ...spec, model: "sonnet", rolePrompt: "R", resumeSessionId: "s1" });
    expect(stdin).toBe("P");
    expect(args).toEqual(expect.arrayContaining(["-p", "--permission-mode", "dontAsk", "--permission-prompts", "none", "--strict-mcp-config", "--setting-sources", "", "--resume", "s1", "--model", "sonnet"]));
    expect(args[args.indexOf("--allowedTools") + 1]).toBe("mcp__memory-cp,Read,Bash(git status)");
    expect(args.join(" ")).not.toMatch(/bypass|skip-permissions/i);
    expect(args).not.toContain("P");
  });

  it("omits optional flags and extracts the session id", () => {
    const { args } = claudeCli.build(spec);
    expect(args).not.toContain("--resume");
    expect(args).not.toContain("--model");
    expect(claudeCli.parseSessionId('{"session_id":"abc"}')).toBe("abc");
    expect(claudeCli.parseSessionId("not json")).toBeUndefined();
  });
});

describe("config", () => {
  const base = { agents: [{ name: "w", key: "k", cwd: "sub", allowedTools: [], timeoutSeconds: 5 }] };

  it("fills defaults and resolves cwd against the config directory", () => {
    const c = parseConfig(JSON.stringify(base), "/etc/hive");
    expect(c.pollMs).toBe(1000);
    expect(c.agents[0]).toMatchObject({ cli: "claude", cwd: "/etc/hive/sub" });
  });

  it("rejects bad names, duplicates, unknown fields and a missing key", () => {
    const withAgent = (a: object) => JSON.stringify({ agents: [{ ...base.agents[0], ...a }] });
    expect(() => parseConfig(withAgent({ name: "all" }), "/")).toThrow();
    expect(() => parseConfig(withAgent({ name: "has space" }), "/")).toThrow();
    expect(() => parseConfig(withAgent({ extra: 1 }), "/")).toThrow();
    expect(() => parseConfig(withAgent({ key: "" }), "/")).toThrow();
    expect(() => parseConfig(JSON.stringify({ agents: [base.agents[0], { ...base.agents[0], name: "W" }] }), "/")).toThrow(/twice/);
  });
});
