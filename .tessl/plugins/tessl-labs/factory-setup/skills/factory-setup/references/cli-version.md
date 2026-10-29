# Check the Tessl CLI

Factory setup needs a CLI that has `tessl cli update`. Check what the shell
runs before you use any newer command.

## Obsolete CLI

The CLI is obsolete when any of these hold:

- `tessl --version` prints a version below 0.50.0.
- `tessl cli update --dry-run` fails with "cli update is not a valid command".
- Any `tessl` command prints "Error in environment configuration" and asks for
  `LANGFUSE_PROXY_TOKEN`, `TELEMETRY_USER`, or `TELEMETRY_PASSWORD`. Only an
  obsolete CLI reads those variables. The current CLI ignores them.

When it is obsolete, tell the user in plain words: "Your Tessl CLI is too old
to update itself. Install the current one." Give them the install command for
their system:

- macOS or Linux: `curl -fsSL https://get.tessl.io | sh`
- Homebrew: `brew install tesslio/tap/tessl`
- Windows: `winget install tessl.tessl`

Link the [installation guide](https://docs.tessl.io/introduction-to-tessl/installation)
for the full steps. Do not suggest `tessl update`: it updates plugins, not
the CLI. Then check which CLI the shell runs, below.

## A winget install

A winget build cannot update itself. `tessl cli update --dry-run` fails with
"Self-update is disabled for this installation". That is not an obsolete CLI.
Tell the user to run `winget upgrade tessl.tessl`, then check which CLI the
shell runs, below.

## Check which CLI the shell runs

After any install or update, ask the user to open a new terminal and run
`tessl --version`. Then list every `tessl` on the `PATH` (`which -a tessl`, or
`where tessl` on Windows) and compare with the version they just installed.

If an old npm install still comes first, it is usually under the npm global
prefix (`npm prefix -g`), for example `/usr/local/bin/tessl` or a path that
contains `node_modules`. The new CLI is the other entry in that list: the
native installer puts it in `~/.local/bin`, while Homebrew and winget use their
own directories. Tell the user that the old copy is running instead of the new
one, and give them both safe fixes:

- Remove the old npm package. Find its name with `npm ls -g --depth=0`, then
  run `npm uninstall -g @tessl/cli` or `npm uninstall -g tessl`.
- Or put the new CLI's directory before the npm directory in `PATH`, in the
  shell profile (`~/.zshrc` or `~/.bashrc`, or the user `Path` variable on
  Windows), and open a new terminal.

Wait until `tessl --version` shows the new version, then carry on with
preflight.

## Old configuration

The current CLI starts and runs `tessl init` with the files an old CLI left in
`~/.tessl`, such as `dotenv` and an expired `api-credentials.json`. Do not ask
the user to delete them, and never delete them yourself. If `tessl login` is
needed, the current CLI replaces the old credentials when the user logs in.
