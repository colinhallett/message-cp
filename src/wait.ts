import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Unread } from "./messages.js";
import { setting } from "./settings.js";

/** The CLI that sits next to the running server: `dist/cli.js` for a built checkout. */
const cliPath = fileURLToPath(new URL("./cli.js", import.meta.url));

export const NAME_PLACEHOLDER = "<your-name>";

export const shellQuote = (s: string) => (/^[A-Za-z0-9_\/.:@%+=,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** The shell command that exits once `name` has unread mail, reading the same database as this server. */
export function waitCommand(name: string, env: NodeJS.ProcessEnv = process.env): string {
  // Carries this server's database path, so a different MESSAGE_CP_DB in the caller's shell cannot point the command elsewhere.
  const path = setting("DB", env);
  const db = path ? `MESSAGE_CP_DB=${shellQuote(resolve(path))} ` : "";
  return `${db}node ${shellQuote(cliPath)} wait ${shellQuote(name)}`;
}

/**
 * The one line `wait` prints, here and over HTTP: how many unread messages and from whom, then how many unread posts
 * in joined channels and in which, then how many unread mentions and in which channels, never the bodies. With no
 * unread posts or mentions it is the messages part alone, as it was before channels, so scripts that parse it keep
 * working.
 */
export function formatUnread(unread: Unread): string {
  const parts: string[] = [];
  if (unread.count > 0) {
    parts.push(`${unread.count} unread ${unread.count === 1 ? "message" : "messages"} from ${unread.senders.join(", ")}`);
  }
  if (unread.posts > 0) {
    parts.push(`${unread.posts} unread ${unread.posts === 1 ? "post" : "posts"} in ${unread.channels.map((c) => `#${c}`).join(", ")}`);
  }
  if (unread.mentions > 0) {
    parts.push(
      `${unread.mentions} unread ${unread.mentions === 1 ? "mention" : "mentions"} in ${unread.mentionChannels.map((c) => `#${c}`).join(", ")}`,
    );
  }
  return parts.join("; ");
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

// The same loop for a session connected by approval, whose MCP client holds its token: the token is the agent's listen
// token, read only from ~/.message-cp/wait/<name>@<server>, never from MESSAGE_CP_HTTP_TOKEN or
// ~/.message-cp/http-token, so agents on one machine never share or overwrite one file. $3 is the <server> part.
const CURL_401 = "the server refused the token (401)";
if (!CURL_LOOP.includes(CURL_401)) throw new Error("CURL_LOOP's 401 line changed: update LISTEN_LOOP");
const LISTEN_LOOP = `f="$HOME/.message-cp/wait/$2@$3"
t=$(cat "$f" 2>/dev/null)
[ -n "$t" ] || { echo "message-cp wait: no listen token in $f; call the listen_token tool and save its token there as it says" >&2; exit 1; }
${CURL_LOOP.slice(CURL_LOOP.indexOf("while :; do")).replace(CURL_401, "the server refused the listen token (401): a newer one replaced it, its agent was removed or its approval revoked")}`;

/** The `/wait` URL on the server at `publicUrl`, built from the parsed URL. */
function waitUrl(publicUrl: string): URL {
  const url = new URL(publicUrl);
  // Set as the path, never resolved as a reference, so no path can change the host.
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/wait`;
  return url;
}

/**
 * The shell command that exits once `name` has unread mail on the server at `publicUrl`, over HTTP. `publicUrl` is one
 * `serve` checked with `publicUrl` in connect.ts; `/wait` is built from the parsed URL.
 */
export function httpWaitCommand(publicUrl: string, name: string): string {
  return `sh -c '${CURL_LOOP}' sh ${shellQuote(waitUrl(publicUrl).href)} ${shellQuote(name)}`;
}

/** The <server> part of a listen token's file name: the public URL's host and port, with anything but [A-Za-z0-9.-] as `_`. */
const listenServer = (publicUrl: string) => new URL(publicUrl).host.replace(/[^A-Za-z0-9.-]/g, "_");

/** The file, under `~`, that the listen command for `name` on the server at `publicUrl` reads its listen token from. */
export const listenTokenFile = (publicUrl: string, name: string) => `~/.message-cp/wait/${name}@${listenServer(publicUrl)}`;

/**
 * How an agent saves its listen token to `listenTokenFile`, privately: the directories 0700 and the file 0600. The token
 * is never in it; `<listen token>` is a placeholder the agent replaces.
 */
export const saveListenToken = (publicUrl: string, name: string) =>
  `Save listenToken, and nothing else, to ${listenTokenFile(publicUrl, name)}, privately: mkdir -p ~/.message-cp/wait && chmod 700 ~/.message-cp ~/.message-cp/wait, then (umask 077 && printf '%s\\n' '<listen token>' > ~/.message-cp/wait/${shellQuote(`${name}@${listenServer(publicUrl)}`)}), with the token in place of <listen token>. Never put it in a URL, a message or a log.`;

/**
 * The shell command that exits once `name` has unread mail on the server at `publicUrl`, for a session connected by
 * approval: like `httpWaitCommand`, but with the agent's listen token from `listenTokenFile`.
 */
export function listenWaitCommand(publicUrl: string, name: string): string {
  return `sh -c '${LISTEN_LOOP}' sh ${shellQuote(waitUrl(publicUrl).href)} ${shellQuote(name)} ${shellQuote(listenServer(publicUrl))}`;
}

/**
 * What a connecting session is told about being woken by messages. `agent` is the agent an HTTP session already is,
 * because its token is bound to it: its command names that agent, and it is not told to register. `approval` is set for
 * a session connected by approval, whose command reads a listen token (`listenWaitCommand`) that it is told how to get.
 */
export function instructions(env: NodeJS.ProcessEnv = process.env, remote = false, publicUrl?: string, agent?: string, approval = false): string {
  // A remote agent cannot run `wait`, which reads the database file on the server's machine; it can ask /wait if
  // the server knows the URL clients reach it at.
  if (remote && !publicUrl) {
    return "message-cp does not push messages; an agent has to ask for them. Call read_inbox to check for mail, and list_channels for unread posts. To wait for mail in one call instead, call wait_for_mail. It reads and marks nothing: when it returns a line, call read_inbox if the line names messages or mentions and read_channel for each channel it names posts in, and only then wait again, since a call made before reading returns at once on the same mail. When it returns { unread: null }, its timeout passed without finding mail: call it again.";
  }
  const command = !remote
    ? waitCommand(setting("AGENT", env) || NAME_PLACEHOLDER, env)
    : approval
      ? listenWaitCommand(publicUrl!, agent ?? NAME_PLACEHOLDER)
      : httpWaitCommand(publicUrl!, agent ?? NAME_PLACEHOLDER);
  // A session connected by approval has no token its shell can read: it gets a listen token for its agent first.
  const first = !approval
    ? remote && agent
      ? `as agent '${agent}', which this session already is,`
      : "register and then"
    : agent
      ? `as agent '${agent}', which this session already is, call listen_token, save the listen token it returns as it says, and then`
      : "register, save the listen token it returns as it says, and then";
  return [
    "message-cp does not push messages; an agent has to ask for them.",
    `To be woken when a message arrives, ${first} run this as a background command (in Claude Code, a Bash call with run_in_background): ${command}`,
    "It exits as soon as you have unread mail, unread posts in a channel you joined with join_channel, or an unread @mention of you, and prints how many, from whom and in which channels, without reading them.",
    "When it fires, call read_inbox if it names messages or mentions and read_channel for each channel it names posts in, and only then start the command again; starting it before reading fires at once on the same mail.",
    "A client that cannot run a background command can call wait_for_mail instead: it holds the call until the same mail arrives or its timeout passes, and returns the same line. Read what it names the same way before calling it again. When it returns { unread: null }, its timeout passed without finding mail: call it again.",
  ].join("\n");
}
