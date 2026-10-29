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

Only the owner releases; the factory never bumps the version, pushes a tag or publishes. `.github/workflows/release.yml` publishes `message-cp` to npm when a tag `v*` is pushed, through [npm trusted publishing](https://docs.npmjs.com/trusted-publishers), so no npm token is stored anywhere. It refuses, before building, a tag that is not `v` plus `version` from `package.json` or that points at a commit not on `main`. It then runs `npm ci --ignore-scripts`, `npm run build` and `npm test`, and publishes with provenance only if they pass. A ruleset lets only repository admins create, move or delete `v*` tags.

To release a version:

1. Bump `version` in `package.json` on `main`, through a pull request like any other change.
2. Tag the merged commit on `main` and push the tag: `git tag v<version> <commit>` then `git push origin v<version>`.
3. Watch the Release run in the repository's Actions tab. If it refuses the tag, delete the tag (`git push origin :refs/tags/v<version>`), fix what it names, and tag again.

Once only, before the first release through the workflow: npm can only trust a workflow for a package that already exists, so publish the first version by hand from a clean checkout of `main` (`npm ci --ignore-scripts`, `npm run build`, `npm test`, then `npm publish`). Then, on [npmjs.com](https://www.npmjs.com/package/message-cp), open the package's settings, add a trusted publisher for GitHub Actions with the repository `colinhallett/message-cp` and the workflow file name `release.yml`, and leave the environment empty. Every later version goes through the workflow. A tag for a version already on npm, such as the one published by hand, fails at the publish step.
