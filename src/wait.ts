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

/** The one line `wait` prints, here and over HTTP: how many unread messages and from whom, never the bodies. */
export function formatUnread(unread: { count: number; senders: string[] }): string {
  return `${unread.count} unread ${unread.count === 1 ? "message" : "messages"} from ${unread.senders.join(", ")}`;
}

/** How long the server holds a /wait request with no mail before answering 204. */
export const DEFAULT_WAIT_HOLD_MS = 4 * 60 * 1000;
// curl gives up a little after the server would have answered, so a dead connection cannot hang the loop.
const CURL_MAX_TIME_S = DEFAULT_WAIT_HOLD_MS / 1000 + 60;

// Plain POSIX sh and curl, nothing to install. The credential reaches curl on stdin (`-H @-`), so it is never in an
// argument list. $1 is the /wait URL, $2 the agent name.
// A 204 (no mail yet) or a failed request asks again; 401 and 404 end it, since asking again cannot help.
const curlLoop = (credential: string, header: string, refused: string) => `${credential}
while :; do
r=$(printf ${header} "$t" | curl -sS -m ${CURL_MAX_TIME_S} -H @- -g -G --data-urlencode "agent=$2" -w "%{http_code}" "$1")
b=\${r%???}; c=\${r#"$b"}
case $c in
200) printf "%s" "$b"; exit 0;;
401) echo "memory-cp wait: the server refused the ${refused} (401)" >&2; exit 1;;
404) echo "memory-cp wait: 404: no agent named $2, or the server URL is wrong" >&2; exit 1;;
204) ;;
*) sleep 5;;
esac
done`;

// The token comes from the environment or ~/.memory-cp/http-token.
const TOKEN_LOOP = curlLoop(
  `t="\${MEMORY_CP_HTTP_TOKEN:-$(cat ~/.memory-cp/http-token 2>/dev/null)}"
[ -n "$t" ] || { echo "memory-cp wait: set MEMORY_CP_HTTP_TOKEN or write the token to ~/.memory-cp/http-token" >&2; exit 1; }`,
  `"Authorization: Bearer %s\\n"`,
  "token",
);

/** Where an agent signed in with GitHub keeps its key for the wait command: one file per agent name, mode 0600. */
export const AGENT_KEY_DIR = "~/.memory-cp/agent-keys";

// With sign-in on, a token is used as above if there is one; an agent without one waits with its own key, from
// MEMORY_CP_AGENT_KEY or its file. Names are letters, digits, '-' and '_' only, so $2 is a plain file name.
// No single quote anywhere: the loop is passed inside one.
const KEY_LOOP = curlLoop(
  `t="\${MEMORY_CP_HTTP_TOKEN:-$(cat ~/.memory-cp/http-token 2>/dev/null)}"; h="Authorization: Bearer"
[ -n "$t" ] || { t="\${MEMORY_CP_AGENT_KEY:-$(cat ${AGENT_KEY_DIR}/"$2" 2>/dev/null)}"; h="X-Memory-Cp-Agent-Key:"; }
[ -n "$t" ] || { echo "memory-cp wait: write the agent key to ${AGENT_KEY_DIR}/$2 (mode 0600) or set MEMORY_CP_AGENT_KEY" >&2; exit 1; }`,
  `"$h %s\\n"`,
  "token or key",
);

/**
 * The shell command that exits once `name` has unread mail on the server at `publicUrl`, over HTTP. With
 * `agentKey` (sign-in on) it falls back to the agent's own key when no token is set.
 */
export function httpWaitCommand(publicUrl: string, name: string, agentKey = false): string {
  const url = `${publicUrl.replace(/\/+$/, "")}/wait`;
  return `sh -c '${agentKey ? KEY_LOOP : TOKEN_LOOP}' sh ${shellQuote(url)} ${shellQuote(name)}`;
}

/** How an agent signed in with GitHub, which has no token of its own to give the command, lets it wait. */
export const AGENT_KEY_HINT = `If you signed in through the browser and have no memory-cp token, the command uses your agent key instead: before you start it, save the key register returned to ${AGENT_KEY_DIR}/<your-name> (mode 0600) with a file-writing tool, not in a shell command, so the key stays out of the command line. Only a key register generated (64 characters) works for this.`;

/** What a connecting session is told about being woken by messages. */
export function instructions(env: NodeJS.ProcessEnv = process.env, remote = false, publicUrl?: string, agentKeyWait = false): string {
  // A remote agent cannot run `wait`, which reads the database file on the server's machine; it can ask /wait if
  // the server knows the URL clients reach it at.
  if (remote && !publicUrl) {
    return "memory-cp does not push messages; an agent has to ask for them. Call read_inbox to check for mail.";
  }
  const command = remote
    ? httpWaitCommand(publicUrl!, NAME_PLACEHOLDER, agentKeyWait)
    : waitCommand(env.MEMORY_CP_AGENT || NAME_PLACEHOLDER, env);
  return [
    "memory-cp does not push messages; an agent has to ask for them.",
    `To be woken when a message arrives, register and then run this as a background command (in Claude Code, a Bash call with run_in_background): ${command}`,
    ...(agentKeyWait ? [AGENT_KEY_HINT] : []),
    "It exits as soon as you have unread mail and prints how many and from whom, without reading them.",
    "When it fires, call read_inbox first and only then start the command again; starting it before reading fires at once on the same message.",
  ].join("\n");
}
