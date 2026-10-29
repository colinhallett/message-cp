# Browser links

Where each link comes from:

- **Project:** `webUrl` from `tessl project repair --json` when this folder is
  linked; otherwise the web app's `/go/projects/<project id>`.
- **Project Loops:** the project link with `/loops` added.
- **GitHub App:** `installUrl` from
  `tessl integrations show github-app-agent --json` when the app is not
  installed. When it is installed on the account that owns the repository,
  that entry's `manageUrl` in `integrations` (GitHub repository access for
  that installation) first, then `webUrl` from the same output. When no entry
  is on that account, `webUrl`, and ask the user to install the app on the
  owner's account.
- **Code Review:** `webUrl` from
  `tessl integrations show github-app-code-review --json`.
- **Linear:** `webUrl` from
  `tessl integrations show linear --workspace <workspace> --json`.
- **Environment:** `webUrl` from `tessl environment view <env> --json`.
- **Loop:** `webUrl` of its entry in
  `tessl schedule list --project-id <linked project id> --all --json`, or
  the link that `tessl schedule trigger <id>` prints.
- **Run:** `data.webUrl` from `tessl launch view <run id> --json`, or
  `webUrl` of its entry in `tessl launch list --json`.
