import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setting } from "./settings.js";

/** The CLI that sits next to the running server: `dist/cli.js` for a built checkout. */
const cliPath = fileURLToPath(new URL("./cli.js", import.meta.url));

export const NAME_PLACEHOLDER = "<your-name>";

const shellQuote = (s: string) => (/^[A-Za-z0-9_\/.:@%+=,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** The shell command that exits once `name` has unread mail, reading the same database as this server. */
export function waitCommand(name: string, env: NodeJS.ProcessEnv = process.env): string {
  // Set explicitly, so a MESSAGE_CP_DB in the caller's shell cannot point the command at another database.
  const path = setting("DB", env);
  const db = path ? `MESSAGE_CP_DB=${shellQuote(resolve(path))} ` : "";
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

// Plain POSIX sh and curl, nothing to install. The token comes from MESSAGE_CP_HTTP_TOKEN (an empty variable counts
// as unset), else ~/.message-cp/http-token, and reaches curl on
// stdin (`-H @-`), so it is never in an argument list. $1 is the /wait URL, $2 the agent name.
// A 204 (no mail yet) or a failed request asks again; 401 and 404 end it, since asking again cannot help.
const CURL_LOOP = `t="\${MESSAGE_CP_HTTP_TOKEN:-$(cat ~/.message-cp/http-token 2>/dev/null)}"
[ -n "$t" ] || { echo "message-cp wait: set MESSAGE_CP_HTTP_TOKEN or write the token to ~/.message-cp/http-token" >&2; exit 1; }
while :; do
r=$(printf "Authorization: Bearer %s\\n" "$t" | curl -sS -m ${CURL_MAX_TIME_S} -H @- -g -G --data-urlencode "agent=$2" -w "%{http_code}" "$1")
b=\${r%???}; c=\${r#"$b"}
case $c in
200) printf "%s" "$b"; exit 0;;
401) echo "message-cp wait: the server refused the token (401)" >&2; exit 1;;
404) echo "message-cp wait: 404: no agent named $2, or the server URL is wrong" >&2; exit 1;;
204) ;;
*) sleep 5;;
esac
done`;

/** The shell command that exits once `name` has unread mail on the server at `publicUrl`, over HTTP. */
export function httpWaitCommand(publicUrl: string, name: string): string {
  const url = `${publicUrl.replace(/\/+$/, "")}/wait`;
  return `sh -c '${CURL_LOOP}' sh ${shellQuote(url)} ${shellQuote(name)}`;
}

/** What a connecting session is told about being woken by messages. */
export function instructions(env: NodeJS.ProcessEnv = process.env, remote = false, publicUrl?: string): string {
  // A remote agent cannot run `wait`, which reads the database file on the server's machine; it can ask /wait if
  // the server knows the URL clients reach it at.
  if (remote && !publicUrl) {
    return "message-cp does not push messages; an agent has to ask for them. Call read_inbox to check for mail.";
  }
  const command = remote
    ? httpWaitCommand(publicUrl!, NAME_PLACEHOLDER)
    : waitCommand(setting("AGENT", env) || NAME_PLACEHOLDER, env);
  return [
    "message-cp does not push messages; an agent has to ask for them.",
    `To be woken when a message arrives, register and then run this as a background command (in Claude Code, a Bash call with run_in_background): ${command}`,
    "It exits as soon as you have unread mail and prints how many and from whom, without reading them.",
    "When it fires, call read_inbox first and only then start the command again; starting it before reading fires at once on the same message.",
  ].join("\n");
}
