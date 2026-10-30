# Contributing

Thanks for looking. message-cp is built by its owner's [Tessl](https://tessl.io) factory, so it takes contributions as issues rather than pull requests.

- **Bugs and ideas.** Open a GitHub issue. For a bug, say what you ran, what you expected and what happened, with the `message-cp` version (`npm ls -g message-cp`, or the commit of your clone).
- **Pull requests.** Only collaborators can open them. If you have a change in mind, describe it in an issue; the owner turns accepted ones into work for the factory.
- **Security problems.** Do not open an issue. Follow [SECURITY.md](SECURITY.md).

## Building and testing

Needs Node 22.14 or later.

```sh
npm ci --ignore-scripts
npm run build
npm test
```

[README.md](README.md#quick-start) explains `--ignore-scripts`. [DIRECTION.md](DIRECTION.md) says what the project is for and what it deliberately leaves out, and [AGENTS.md](AGENTS.md) holds the rules every change follows.

## Releasing

Only the owner releases; the factory never bumps the version, pushes a tag or publishes. `.github/workflows/release.yml` publishes `message-cp` to npm when a tag `v*` is pushed, through [npm trusted publishing](https://docs.npmjs.com/trusted-publishers), so no npm token is stored anywhere. It refuses, before building, a tag that is not `v` plus `version` from `package.json` or that points at a commit not on `main`. It then runs `npm ci --ignore-scripts`, `npm run build` and `npm test`, and publishes with provenance only if they pass. Before publishing it asks npm (`npm view message-cp@<version> version`) whether that exact version is already there, and skips `npm publish` if it is, so a re-run of a release whose publish succeeded carries on to the registry. The owner can also start it by hand for a tag that already exists (see step 4 below); such a run first refuses to go on if anyone but `colinhallett` started it or if the tag does not exist, then checks out that tag, never `main`, and applies the same checks to it. It never runs `npm publish`, because the provenance npm records would name `main`'s commit rather than the tag's: if npm does not have the version, it fails before building, and the version has to be published by the Release run of its own tag or by tagging a new version. A repository ruleset restricts creating, moving and deleting `v*` tags.

After `npm publish` succeeds, or is skipped, the same job waits until npm serves that version, checking every 10 seconds for 10 minutes (`WAIT_SECONDS` in `release.yml`, with a hard limit of 12 minutes on the step), because npm can take a minute or more to serve a version it has just accepted and the registry refuses a listing whose npm version it cannot fetch. If npm still does not serve it by then, the job fails and says so. After that wait, the job updates message-cp's listing on the [official MCP Registry](https://registry.modelcontextprotocol.io) from `server.json`. It downloads the `mcp-publisher` release named by `MCP_PUBLISHER_VERSION` in `release.yml`, checks its Sigstore signature with `cosign`, logs in with the job's GitHub OIDC token (`mcp-publisher login github-oidc`), so no registry token is stored either, and runs `mcp-publisher publish`. The registry accepts the listing only if the npm package it names has `mcpName` set to `io.github.colinhallett/message-cp`. Version 0.1.0 on npm has no `mcpName`, so the first listing is published by the next version's tag.

To release a version:

1. Bump `version` in `package.json` on `main`, and both `version` fields in `server.json` (the listing's and its npm package's) to the same value, through a pull request like any other change. `npm test` fails while they differ.
2. Tag the merged commit on `main` and push the tag: `git tag v<version> <commit>` then `git push origin v<version>`.
3. Watch the Release run in the repository's Actions tab. If it refuses the tag, delete it on GitHub and locally (`git push origin :refs/tags/v<version>` then `git tag -d v<version>`), fix what it names, and tag again. If the tag passed that check and a step up to `npm publish` failed, fix the cause on `main`, bump `version` and tag the new version, or re-run the job if the failure was not in the code.
4. If `npm publish` succeeded and a step after it failed, first look for the version on the registry (`https://registry.modelcontextprotocol.io/v0.1/servers/io.github.colinhallett%2Fmessage-cp/versions`): the registry never takes the same version twice, so if it is listed there is nothing to do. Otherwise, if the failure was not in the code, start Release again for the tag with the workflow as it is on `main`: run `gh workflow run release.yml --ref main -f tag=v<version>`, or open Release in the Actions tab, choose "Run workflow", leave "Use workflow from" on `main` and enter the tag. It checks out the tag, finds the version on npm, skips `npm publish`, waits for npm to serve it and publishes the listing. Do this rather than re-running the failed job, which runs the workflow as it was at the tag, so a fix made to `release.yml` since then would not apply. Only if that run cannot publish the listing either, publish the listing by hand from a checkout of the tag: download and verify the `mcp-publisher` release named in `release.yml` as its "Download and verify mcp-publisher" step does, then, in the directory it extracted `mcp-publisher` into, run `./mcp-publisher login github` (it asks you to enter a code at github.com/login/device) and `./mcp-publisher publish`. If the registry refused `server.json` itself, fix it on `main`, bump `version` and tag the new version.

Once only, before the first release through the workflow: npm can only trust a workflow for a package that already exists, so publish the first version by hand from a clean checkout of `main` (`npm ci --ignore-scripts`, `npm run build`, `npm test`, then `npm publish`). Then, on [npmjs.com](https://www.npmjs.com/package/message-cp), open the package's settings, add a trusted publisher for GitHub Actions with the repository `colinhallett/message-cp` and the workflow file name `release.yml`, and leave the environment empty. Every later version goes through the workflow. A tag for a version already on npm, such as the one published by hand, skips the publish step and goes on to the registry steps.
