/** What a run needs from whichever agent CLI executes it. */
export interface RunSpec {
  agent: string;
  /** The agent's working directory. */
  cwd: string;
  prompt: string;
  /** Path of a mode 0600 MCP config that starts this server as the agent. */
  mcpConfigPath: string;
  model?: string;
  allowedTools: string[];
  rolePrompt?: string;
  /** The agent's previous session, if it has one. */
  resumeSessionId?: string;
}

export interface Command {
  command: string;
  args: string[];
  /** Written to the process's stdin, so message text never appears in `ps`. */
  stdin: string;
}

/** The one place that knows a CLI's flags. A second CLI is a second implementation. */
export interface AgentCli {
  build(spec: RunSpec): Command;
  /** The session id to resume next time, found in the CLI's stdout. */
  parseSessionId(stdout: string): string | undefined;
}

/** Server name in the MCP config, so its tools are `mcp__memory-cp__*`. */
export const MCP_SERVER_NAME = "memory-cp";

/**
 * Claude Code, non-interactive. It ignores settings files in this mode, so every permission comes
 * from flags. `dontAsk` refuses whatever is not allowed, and no prompt is ever shown.
 */
export const claudeCli: AgentCli = {
  build(spec) {
    const args = [
      "-p",
      "--output-format", "json",
      "--permission-mode", "dontAsk",
      "--permission-prompts", "none",
      "--strict-mcp-config",
      // No user, project or local settings: a settings file in the agent's directory cannot grant tools or add hooks.
      "--setting-sources", "",
      "--mcp-config", spec.mcpConfigPath,
      "--allowedTools", [`mcp__${MCP_SERVER_NAME}`, ...spec.allowedTools].join(","),
    ];
    if (spec.model) args.push("--model", spec.model);
    if (spec.rolePrompt) args.push("--append-system-prompt", spec.rolePrompt);
    if (spec.resumeSessionId) args.push("--resume", spec.resumeSessionId);
    return { command: "claude", args, stdin: spec.prompt };
  },
  parseSessionId(stdout) {
    try {
      const result = JSON.parse(stdout) as { session_id?: unknown };
      return typeof result.session_id === "string" ? result.session_id : undefined;
    } catch {
      return undefined;
    }
  },
};
