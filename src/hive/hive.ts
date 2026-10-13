import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ToolError, registerAgent } from "../agents.js";
import { dbPath, type Db } from "../db.js";
import { MCP_SERVER_NAME, claudeCli, type AgentCli } from "./agent-cli.js";
import type { AgentConfig, HiveConfig } from "./config.js";
import { abandonOrphanedRuns, claimMessages, ensureRunsTable, finishRun, promptFor } from "./runs.js";

const MAX_OUTPUT = 1_000_000;
const KILL_GRACE_MS = 5000;
const DRAIN_MS = 1000;

export interface HiveOptions {
  clis?: Record<string, AgentCli>;
  /** The command that starts this server over stdio. */
  serverCommand?: { command: string; args: string[] };
  dbFile?: string;
  log?: (line: string) => void;
}

interface Outcome {
  exitStatus: string;
  sessionId?: string;
  error?: string;
}

/** Starts the polling loop. `stop()` stops claiming new work and resolves once running runs have ended. */
export function startHive(db: Db, config: HiveConfig, options: HiveOptions = {}) {
  const clis: Record<string, AgentCli> = { claude: claudeCli, ...options.clis };
  const serverCommand = options.serverCommand ?? {
    command: process.execPath,
    args: [fileURLToPath(new URL("../index.js", import.meta.url))],
  };
  const dbFile = options.dbFile ?? dbPath();
  const log = options.log ?? ((line: string) => console.error(`memory-cp hive: ${line}`));
  ensureRunsTable(db);
  // A hive that died mid-run leaves rows with no end; their messages were already read and are not retried.
  const orphans = abandonOrphanedRuns(db);
  if (orphans > 0) log(`${orphans} run(s) from an earlier hive never finished; marked abandoned`);

  // Agents must exist to receive messages. One whose key does not match is left out, not fatal.
  const agents = config.agents.filter((a) => {
    // Checked before any claim, so an unknown CLI cannot consume messages.
    if (!clis[a.cli]) {
      log(`agent ${a.name} skipped: unknown agent CLI '${a.cli}'`);
      return false;
    }
    try {
      registerAgent(db, a.name, undefined, a.key);
      return true;
    } catch (err) {
      if (!(err instanceof ToolError)) throw err;
      log(`agent ${a.name} skipped: ${err.message}`);
      return false;
    }
  });

  const running = new Map<string, Promise<void>>();
  let stopped = false;

  const execute = async (agent: AgentConfig, runId: number, claim: NonNullable<ReturnType<typeof claimMessages>>) => {
    const dir = mkdtempSync(join(tmpdir(), "memory-cp-hive-"));
    try {
      // The key lives only in this owner-only file, never in argv, the prompt or the logs.
      const mcpConfigPath = join(dir, "mcp.json");
      writeFileSync(
        mcpConfigPath,
        JSON.stringify({
          mcpServers: {
            [MCP_SERVER_NAME]: {
              ...serverCommand,
              env: { MEMORY_CP_AGENT: agent.name, MEMORY_CP_AGENT_KEY: agent.key, MEMORY_CP_DB: dbFile },
            },
          },
        }),
        { mode: 0o600 },
      );
      chmodSync(mcpConfigPath, 0o600);
      const cli = clis[agent.cli];
      if (!cli) return { exitStatus: "error", error: `unknown agent CLI '${agent.cli}'` } satisfies Outcome;
      const cmd = cli.build({
        agent: agent.name,
        cwd: agent.cwd,
        prompt: promptFor(claim.messages),
        mcpConfigPath,
        model: agent.model,
        allowedTools: agent.allowedTools,
        rolePrompt: agent.rolePrompt,
        resumeSessionId: claim.resumeSessionId,
      });
      return await runProcess(cli, cmd, agent);
    } catch (err) {
      return { exitStatus: "error", error: String(err instanceof Error ? err.message : err) } satisfies Outcome;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  const runProcess = (cli: AgentCli, cmd: { command: string; args: string[]; stdin: string }, agent: AgentConfig) =>
    new Promise<Outcome>((resolve) => {
      // The child must not inherit an identity or key meant for another process.
      const env = { ...process.env };
      delete env.MEMORY_CP_AGENT;
      delete env.MEMORY_CP_AGENT_KEY;
      const child = spawn(cmd.command, cmd.args, { cwd: agent.cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;
      const done = (o: Outcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(o);
      };
      // The agent's own children (its memory-cp server) share its process group; kill them all.
      const killGroup = (sig: NodeJS.Signals) => {
        try {
          process.kill(-child.pid!, sig);
        } catch {
          child.kill(sig);
        }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        killGroup("SIGTERM");
        setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS).unref();
      }, agent.timeoutSeconds * 1000);
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (d: string) => (stdout = (stdout + d).slice(-MAX_OUTPUT)));
      child.stderr.on("data", (d: string) => (stderr = (stderr + d).slice(-2000)));
      child.on("error", (err) => done({ exitStatus: "error", error: err.message }));
      child.stdin.on("error", () => {});
      child.stdin.end(cmd.stdin);
      const finish = (code: number | null, signal: NodeJS.Signals | null) => {
        const sessionId = cli.parseSessionId(stdout);
        if (timedOut) return done({ exitStatus: "timeout", sessionId, error: `no exit within ${agent.timeoutSeconds}s` });
        if (code === 0) return done({ exitStatus: "ok", sessionId });
        done({ exitStatus: signal ? `signal ${signal}` : `exit ${code}`, sessionId, error: stderr.trim() || undefined });
      };
      // A grandchild holding the pipes open must not keep the agent blocked: once the CLI exits, kill
      // what it left behind and give the pipes a moment to drain.
      child.on("exit", (code, signal) => {
        killGroup("SIGKILL");
        setTimeout(() => finish(code, signal), DRAIN_MS).unref();
      });
      child.on("close", finish);
    });

  const tick = () => {
    if (stopped) return;
    for (const agent of agents) {
      // One run per agent: what arrives meanwhile waits for the next claim, in order.
      if (running.has(agent.name)) continue;
      let claim;
      try {
        claim = claimMessages(db, agent.name);
      } catch (err) {
        log(`agent ${agent.name}: could not check inbox: ${err instanceof Error ? err.message : err}`);
        continue;
      }
      if (!claim) continue;
      const { runId } = claim;
      log(`agent ${agent.name}: run ${runId} started for messages ${claim.messages.map((m) => m.id).join(",")}`);
      const p = execute(agent, runId, claim).then((outcome) => {
        try {
          finishRun(db, runId, outcome.exitStatus, outcome.sessionId, outcome.error);
        } catch (err) {
          log(`agent ${agent.name}: could not record run ${runId}: ${err instanceof Error ? err.message : err}`);
        }
        log(`agent ${agent.name}: run ${runId} ended: ${outcome.exitStatus}${outcome.error ? ` (${outcome.error.slice(0, 200)})` : ""}`);
        running.delete(agent.name);
      });
      running.set(agent.name, p);
    }
  };

  const timer = setInterval(tick, config.pollMs);
  tick();
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await Promise.all(running.values());
    },
  };
}
