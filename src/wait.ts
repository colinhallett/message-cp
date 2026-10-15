import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The CLI that sits next to the running server: `dist/cli.js` for a built checkout. */
const cliPath = fileURLToPath(new URL("./cli.js", import.meta.url));

export const NAME_PLACEHOLDER = "<your-name>";

const shellQuote = (s: string) => (/^[A-Za-z0-9_\/.:@%+=,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** The shell command that exits once `name` has unread mail, reading the same database as this server. */
export function waitCommand(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const db = env.MEMORY_CP_DB ? `MEMORY_CP_DB=${shellQuote(resolve(env.MEMORY_CP_DB))} ` : "";
  return `${db}node ${shellQuote(cliPath)} wait ${shellQuote(name)}`;
}

/** What a connecting session is told about being woken by messages. */
export function instructions(env: NodeJS.ProcessEnv = process.env): string {
  const command = waitCommand(env.MEMORY_CP_AGENT || NAME_PLACEHOLDER, env);
  return [
    "memory-cp does not push messages; an agent has to ask for them.",
    `To be woken when a message arrives, register and then run this as a background command (in Claude Code, a Bash call with run_in_background): ${command}`,
    "It exits as soon as you have unread mail and prints how many and from whom, without reading them.",
    "When it fires, call read_inbox first and only then start the command again; starting it before reading fires at once on the same message.",
  ].join("\n");
}
