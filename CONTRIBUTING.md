# Contributing

Thanks for looking. message-cp is built by its owner's [Tessl](https://tessl.io) factory, so it takes contributions as issues rather than pull requests.

- **Bugs and ideas.** Open a GitHub issue. For a bug, say what you ran, what you expected and what happened, with the `message-cp` version (`npm ls -g message-cp`, or the commit of your clone).
- **Pull requests.** Only collaborators can open them. If you have a change in mind, describe it in an issue; the owner turns accepted ones into work for the factory.
- **Security problems.** Do not open an issue. Follow [SECURITY.md](SECURITY.md).

## Building and testing

Needs Node 22.12 or later.

```sh
npm ci --ignore-scripts
npm run build
npm test
```

[README.md](README.md#quick-start) explains `--ignore-scripts`. [DIRECTION.md](DIRECTION.md) says what the project is for and what it deliberately leaves out, and [AGENTS.md](AGENTS.md) holds the rules every change follows.
