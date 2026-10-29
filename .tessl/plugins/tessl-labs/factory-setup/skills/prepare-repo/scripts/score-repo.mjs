#!/usr/bin/env node
// Scores a repository against the agent readiness rubric without a subagent.
//
// Most rubric criteria are facts about files: a config exists, CI runs a tool,
// a lockfile is committed. This script checks those for every app and writes
// the assessment JSON that build-report.mjs reads. The few criteria that need
// a reader (does the README explain setup, is the agent context any good) are
// written with `needsJudgement: true` and the snippets to judge them from, so
// the agent fills them in from one short file instead of reading the repo.
//
// It reads only files Git tracks, changes nothing in the repository, and makes
// no network calls.
//
// Usage:
//   node score-repo.mjs --out DIR [--root DIR]
//     writes DIR/agent-readiness.json, the baseline draft.
//   node score-repo.mjs --out DIR --baseline FILE --changed FILE [--root DIR]
//     re-checks the branch against the baseline FILE (a finished
//     agent-readiness.json) and the branch's changed files, and writes
//     DIR/rejudged.json for rescore.mjs plus DIR/rejudge-needed.json listing
//     the judgement criteria whose sources the branch changed.

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RUBRIC } from './build-report.mjs';

const MAX_FILE_BYTES = 512 * 1024;
const MAX_APPS = 40;
const MAX_SOURCE_SCAN = 1500;
const SNIPPET_LINES = 60;

// Path segments that never hold an app: tests, fixtures, examples, vendored
// and generated trees. A manifest under one of these is not an app.
const NON_APP_SEGMENT =
  /^(node_modules|test|tests|__tests__|fixtures?|testdata|examples?|benchmarks?|bench|docs?|vendor|third_party|dist|build|\.tessl)$/i;

const MANIFESTS = new Set([
  'package.json',
  'pyproject.toml',
  'setup.py',
  'go.mod',
  'Cargo.toml',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'Gemfile',
  'composer.json',
]);

// ---------------------------------------------------------------- repo view

function git(root, args) {
  const r = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  return r.status === 0 ? r.stdout : null;
}

/** Everything the detectors read: tracked files and cached file text. */
export function openRepo(root) {
  const listed = git(root, ['ls-files', '-z']);
  if (listed === null) throw new Error(`${root} is not a Git repository`);
  const files = listed.split('\0').filter(Boolean);
  const set = new Set(files);
  const realRoot = realpathSync(root);
  const cache = new Map();
  const read = (path) => {
    if (cache.has(path)) return cache.get(path);
    let text = '';
    try {
      const real = realpathSync(join(realRoot, path));
      const rel = relative(realRoot, real);
      if (!rel.startsWith('..') && !isAbsolute(rel)) {
        const buf = readFileSync(real);
        if (buf.length <= MAX_FILE_BYTES && !buf.includes(0))
          text = buf.toString('utf8');
      }
    } catch {
      text = '';
    }
    cache.set(path, text);
    return text;
  };
  return { root, files, has: (p) => set.has(p), read };
}

const segments = (path) => path.split('/');
const base = (path) => segments(path).at(-1);
const dirOf = (path) => {
  const i = path.lastIndexOf('/');
  return i === -1 ? '.' : path.slice(0, i);
};
const under = (dir, path) => dir === '.' || path.startsWith(`${dir}/`);
const inApp = (dir, path) => (dir === '.' ? path : `${dir}/${path}`);

function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      re += '.*';
      i++;
      if (glob[i + 1] === '/') i++;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- apps

function workspacePatterns(repo) {
  const patterns = [];
  const pkg = parseJson(repo.read('package.json'));
  const ws = pkg?.workspaces;
  if (Array.isArray(ws)) patterns.push(...ws);
  else if (Array.isArray(ws?.packages)) patterns.push(...ws.packages);
  const pnpm = repo.read('pnpm-workspace.yaml');
  for (const m of pnpm.matchAll(/^\s*-\s*['"]?([^'"\n#]+)['"]?/gm))
    patterns.push(m[1].trim());
  const cargo = repo.read('Cargo.toml');
  const members = /\[workspace\][\s\S]*?members\s*=\s*\[([\s\S]*?)\]/.exec(
    cargo,
  );
  if (members)
    for (const m of members[1].matchAll(/"([^"]+)"/g)) patterns.push(m[1]);
  const gowork = repo.read('go.work');
  for (const m of gowork.matchAll(/^\s*(?:use\s+)?(\.\/[^\s)]+)/gm))
    patterns.push(m[1].replace(/^\.\//, ''));
  return patterns.map((p) => p.replace(/\/$/, '')).filter(Boolean);
}

/**
 * Whether the root manifest describes a package of its own, not only the
 * workspace glue around its members: a published npm package (hono, vite), a
 * Cargo crate beside its workspace, a Python project, or a Go module. A root
 * with no entry points is glue, and scoring it would judge the members twice.
 * `private` says nothing here: an unpublished root application still has an
 * entry point, and still needs scoring.
 */
function rootIsPackage(repo) {
  const pkg = parseJson(repo.read('package.json'));
  if (
    pkg &&
    ['main', 'module', 'exports', 'bin'].some((k) => pkg[k] !== undefined)
  )
    return true;
  if (/^\s*\[package\]/m.test(repo.read('Cargo.toml'))) return true;
  if (/^\s*\[project\]/m.test(repo.read('pyproject.toml'))) return true;
  return repo.has('go.mod');
}

/** The repository's apps: workspace members, or the root, or each manifest dir. */
export function discoverApps(repo) {
  const manifestDirs = [
    ...new Set(
      repo.files
        .filter((f) => MANIFESTS.has(base(f)))
        .map(dirOf)
        .filter(
          (d) => d === '.' || !segments(d).some((s) => NON_APP_SEGMENT.test(s)),
        ),
    ),
  ].sort();
  const patterns = workspacePatterns(repo);
  let apps;
  if (patterns.length > 0) {
    const include = patterns
      .filter((p) => !p.startsWith('!'))
      .map(globToRegExp);
    const exclude = patterns
      .filter((p) => p.startsWith('!'))
      .map((p) => globToRegExp(p.slice(1)));
    apps = manifestDirs.filter(
      (d) =>
        d !== '.' &&
        include.some((r) => r.test(d)) &&
        !exclude.some((r) => r.test(d)),
    );
    // A workspace whose root is itself the main package (hono and its
    // adapters, a crate and its helper crates) scores the root as an app too.
    if (manifestDirs.includes('.') && rootIsPackage(repo)) apps.unshift('.');
  } else if (manifestDirs.includes('.')) {
    apps = ['.'];
  } else {
    // No root manifest: each top-most manifest directory is an app.
    apps = manifestDirs.filter(
      (d) => !manifestDirs.some((o) => o !== d && under(o, d)),
    );
  }
  if (apps.length === 0) apps = ['.'];
  return { apps: apps.slice(0, MAX_APPS), truncated: apps.length > MAX_APPS };
}

// ---------------------------------------------------------------- app facts

const CI_FILE =
  /^(\.github\/workflows\/[^/]+\.ya?ml|\.gitlab-ci\.yml|\.circleci\/config\.yml|azure-pipelines\.yml|Jenkinsfile|bitbucket-pipelines\.yml|\.buildkite\/.+\.ya?ml|\.drone\.yml|\.travis\.yml)$/;
const HOOK_FILE =
  /^(\.pre-commit-config\.yaml|\.husky\/[^_/][^/]*|lefthook\.ya?ml|\.lefthook\.ya?ml|\.githooks\/.+|\.simple-git-hooks\.(json|js|cjs))$/;

const SOURCE_FILE = /\.(c|m)?[jt]sx?$|\.(py|go|rs|rb|java|kt|cs|php|swift)$/;
const TEST_FILE =
  /(^|\/)(__tests__|tests?|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]+\.py$|_test\.(py|go)$|\.tst\.ts$/;

function scriptsOf(pkg) {
  return pkg && typeof pkg.scripts === 'object' ? pkg.scripts : {};
}

/** Script names a command text runs: npm run x, yarn x, pnpm x, bun run x. */
function scriptRefs(text) {
  const refs = new Set();
  for (const m of text.matchAll(
    /\b(?:npm|pnpm|bun)\s+(?:run(?:-script)?\s+)?([\w:.-]+)|\byarn\s+(?:run\s+)?([\w:.-]+)/g,
  ))
    refs.add(m[1] ?? m[2]);
  for (const m of text.matchAll(/\bnpm\s+(test|t|start)\b/g))
    refs.add(m[1] === 't' ? 'test' : m[1]);
  return refs;
}

/** CI text plus every package script CI reaches, followed transitively. */
function effectiveText(seedText, scripts, repo) {
  let text = seedText;
  const seen = new Set();
  let frontier = [...scriptRefs(seedText)];
  while (frontier.length) {
    const next = [];
    for (const name of frontier) {
      if (seen.has(name) || !(name in scripts)) continue;
      seen.add(name);
      const body = String(scripts[name]);
      text += `\n${body}`;
      next.push(...scriptRefs(body));
    }
    frontier = next;
  }
  if (/\bmake\b/.test(seedText)) text += `\n${repo.read('Makefile')}`;
  if (/\btox\b/.test(seedText)) text += `\n${repo.read('tox.ini')}`;
  if (/\bnox\b/.test(seedText)) text += `\n${repo.read('noxfile.py')}`;
  if (/\bjust\b/.test(seedText)) text += `\n${repo.read('justfile')}`;
  return text;
}

function appFacts(repo, dir, apps) {
  // Files of this app: under its directory and not under a nested app.
  const nested = apps.filter((a) => a !== dir && under(dir, a));
  const files = repo.files.filter(
    (f) => under(dir, f) && !nested.some((n) => under(n, f)),
  );
  const pkg = parseJson(repo.read(inApp(dir, 'package.json')));
  const rootPkg = dir === '.' ? null : parseJson(repo.read('package.json'));
  const scripts = { ...scriptsOf(rootPkg), ...scriptsOf(pkg) };
  const depNames = [pkg, rootPkg]
    .filter(Boolean)
    .flatMap((p) =>
      [
        'dependencies',
        'devDependencies',
        'peerDependencies',
        'optionalDependencies',
      ].flatMap((k) => Object.keys(p[k] ?? {})),
    );
  const depText = [
    depNames.join('\n'),
    repo.read(inApp(dir, 'pyproject.toml')),
    repo.read(inApp(dir, 'go.mod')),
    repo.read(inApp(dir, 'Cargo.toml')),
    repo.read(inApp(dir, 'Gemfile')),
    ...files
      .filter((f) => /(^|\/)requirements[^/]*\.txt$/.test(f))
      .map(repo.read),
  ]
    .join('\n')
    .toLowerCase();
  const ciFiles = repo.files.filter((f) => CI_FILE.test(f));
  const hookFiles = repo.files.filter((f) => HOOK_FILE.test(f));
  const ciText = ciFiles.map(repo.read).join('\n');
  const hookText = [
    ...hookFiles.map(repo.read),
    JSON.stringify(pkg?.['simple-git-hooks'] ?? ''),
    JSON.stringify(pkg?.['lint-staged'] ?? ''),
  ].join('\n');
  const enforcedText = [
    effectiveText(ciText, scripts, repo),
    effectiveText(hookText, scripts, repo),
  ].join('\n');
  const sources = files.filter(
    (f) => SOURCE_FILE.test(f) && !TEST_FILE.test(f),
  );
  const tests = files.filter(
    (f) => TEST_FILE.test(f) && /\.[a-z]+$/.test(f) && !/fixtures?\//.test(f),
  );
  const lang = {
    ts: files.some((f) => /\.tsx?$/.test(f) && !f.endsWith('.d.ts')),
    js: files.some((f) => /\.[cm]?jsx?$/.test(f)),
    py: files.some((f) => f.endsWith('.py')),
    go: files.some((f) => f.endsWith('.go')),
    rs: files.some((f) => f.endsWith('.rs')),
    typedOther: files.some((f) => /\.(java|kt|cs|swift|scala)$/.test(f)),
  };
  const find = (re) =>
    files.filter((f) => re.test(dir === '.' ? f : f.slice(dir.length + 1)));
  const findHere = (re) => [
    ...find(re),
    ...(dir === '.'
      ? []
      : repo.files.filter((f) => !f.includes('/') && re.test(f))),
  ];
  const deployFiles = findHere(
    /(^|\/)(Dockerfile[^/]*|Containerfile|Procfile|fly\.toml|app\.ya?ml|render\.yaml|vercel\.json|netlify\.toml|serverless\.ya?ml|wrangler\.toml|railway\.json|Chart\.yaml|kustomization\.ya?ml)$/,
  );
  const serverDep =
    /\b(express|fastify|koa|hono|@nestjs\/core|next|flask|fastapi|django|starlette|gin-gonic|labstack\/echo|axum|actix-web|rocket|rails|sinatra|spring-boot)\b/.test(
      depText,
    );
  const isLibrary =
    (pkg && !pkg.private && (pkg.main || pkg.exports || pkg.types)) ||
    /\[project\]/.test(repo.read(inApp(dir, 'pyproject.toml')));
  const dbDep =
    /\b(pg|postgres|postgresql|psycopg2?|asyncpg|mysql2?|mariadb|mongodb|mongoose|sqlite3|better-sqlite3|redis|ioredis|prisma|@prisma\/client|drizzle-orm|typeorm|sequelize|knex|sqlalchemy|django|gorm|sqlx|diesel|kafkajs|amqplib|elasticsearch)\b/.test(
      depText,
    );
  return {
    dir,
    files,
    pkg,
    scripts,
    depText,
    ciFiles,
    hookFiles,
    ciText,
    enforcedText,
    sources,
    tests,
    lang,
    find,
    findHere,
    deployable: deployFiles.length > 0,
    deployFiles,
    serverDep,
    isLibrary: Boolean(isLibrary),
    dbDep,
  };
}

// ---------------------------------------------------------------- criteria
//
// Each detector returns, for one app:
//   { applicable: false, why }                      not applicable
//   { pass: true|false, evidence: [paths], note }    decided
//   { judge: true, sources: [paths], snippets }      needs a reader

const yes = (evidence, note) => ({ pass: true, evidence, note });
const no = (note, evidence = []) => ({ pass: false, evidence, note });
const na = (why) => ({ applicable: false, why });

/**
 * When the app has a package script matching `nameRe` (such as `lint` or
 * `format`) but no configuration a detector recognises, the tool is one this
 * script does not know, so the answer is not "no" but "ask the reader". Returns
 * a judge result with the scripts and CI files to read, or null.
 */
function unknownToolScripts(a, nameRe) {
  const names = Object.keys(a.scripts).filter((n) => nameRe.test(n));
  if (names.length === 0) return null;
  const text = names.map((n) => `${n}: ${a.scripts[n]}`).join('\n');
  // The CI and hook lines that name one of those scripts, so the reader can
  // see whether the tool is enforced without opening every workflow.
  const runs = names.map((n) => new RegExp(`\\b${n}\\b`));
  const enforced = a.enforcedText
    .split('\n')
    .filter((line) => runs.some((re) => re.test(line)))
    .slice(0, SNIPPET_LINES);
  return {
    judge: true,
    sources: [inApp(a.dir, 'package.json'), ...a.ciFiles.slice(0, 3)],
    snippets: [
      { path: '(package scripts)', text },
      {
        path: '(CI and hook lines naming them)',
        text: enforced.join('\n') || '(none found)',
      },
    ],
  };
}

function snippet(repo, path, lines = SNIPPET_LINES) {
  const text = repo.read(path);
  if (!text) return null;
  return { path, text: text.split('\n').slice(0, lines).join('\n') };
}

/** Lines under the first heading matching `re`, up to the next heading. */
function section(repo, path, re) {
  const lines = repo.read(path).split('\n');
  const start = lines.findIndex((l) => /^#{1,4}\s/.test(l) && re.test(l));
  if (start === -1) return null;
  const end = lines.findIndex((l, i) => i > start && /^#{1,4}\s/.test(l));
  return {
    path,
    text: lines
      .slice(start, end === -1 ? start + SNIPPET_LINES : end)
      .slice(0, SNIPPET_LINES)
      .join('\n'),
  };
}

function readmeOf(repo, a) {
  return a.findHere(/^README(\.(md|rst|txt))?$/i)[0] ?? null;
}

function contextFiles(repo, a) {
  return [
    ...new Set([
      ...a.findHere(/^(AGENTS|CLAUDE)\.md$/),
      ...repo.files.filter((f) => /^(AGENTS|CLAUDE)\.md$/.test(f)),
    ]),
  ];
}

/** Context file text with a bare `@AGENTS.md` style include followed once. */
function contextText(repo, path) {
  let text = repo.read(path);
  for (const m of text.matchAll(/^@([\w./-]+\.md)\s*$/gm)) {
    const target = join(dirOf(path), m[1]).replace(/^\.\//, '');
    if (repo.has(target)) text += `\n${repo.read(target)}`;
  }
  return text;
}

const COMMAND_IN_TEXT =
  /`[^`\n]*\b(npm|yarn|pnpm|bun|npx|make|just|pytest|tox|nox|uv|poetry|pip|go (test|build|run)|cargo|gradle|mvn|bundle|rake|docker compose)\b[^`\n]*`|^\s*\$?\s*(npm|yarn|pnpm|bun|make|pytest|uv|poetry|go|cargo)\s/m;

const DETECTORS = {
  'Linter Configured': (repo, a) => {
    const configs = a.findHere(
      /(^|\/)(eslint\.config\.[cm]?[jt]s|\.eslintrc(\.[a-z]+)?|biome\.jsonc?|\.oxlintrc\.json|ruff\.toml|\.ruff\.toml|\.flake8|\.pylintrc|pylintrc|\.golangci\.ya?ml|\.rubocop\.yml|\.swiftlint\.yml|detekt\.yml)$/,
    );
    const pyproject = inApp(a.dir, 'pyproject.toml');
    if (/\[tool\.(ruff|pylint|flake8)/.test(repo.read(pyproject)))
      configs.push(pyproject);
    if (a.lang.rs && /clippy/.test(a.ciText)) configs.push('(cargo clippy)');
    if (a.pkg?.eslintConfig || /\b(standard|xo)\b/.test(a.depText))
      configs.push(inApp(a.dir, 'package.json'));
    if (configs.length === 0) {
      // A lint script with a tool this list does not know (vp, nx, a
      // wrapper) is not evidence of absence: hand the app to the reader.
      const unknown = unknownToolScripts(a, /^lint(:|$)/);
      if (unknown) return unknown;
      return no('no linter configuration found');
    }
    if (
      !/\b(eslint|biome|oxlint|ruff|flake8|pylint|golangci-lint|clippy|rubocop|swiftlint|detekt|standard|xo)\b/.test(
        a.enforcedText,
      )
    )
      return no('a linter is configured but no CI step or hook runs it', [
        ...configs,
        ...a.ciFiles,
      ]);
    return yes(
      [...configs, ...a.ciFiles.slice(0, 3)],
      'configured and run in CI or a hook',
    );
  },

  'Code Formatter': (repo, a) => {
    const configs = a
      .findHere(
        /(^|\/)(\.prettierrc(\.[a-z]+)?|prettier\.config\.[cm]?[jt]s|biome\.jsonc?|dprint\.json|\.oxfmtrc\.json|rustfmt\.toml|\.rustfmt\.toml|\.clang-format|\.editorconfig)$/,
      )
      .filter((f) => !f.endsWith('.editorconfig'));
    if (a.pkg?.prettier) configs.push(inApp(a.dir, 'package.json'));
    const pyproject = inApp(a.dir, 'pyproject.toml');
    if (/\[tool\.(black|ruff\.format)/.test(repo.read(pyproject)))
      configs.push(pyproject);
    const runs =
      /\b(prettier|biome|dprint|oxfmt|ruff format|black|rustfmt|cargo fmt|gofmt|goimports|gofumpt)\b/.test(
        a.enforcedText,
      );
    if ((a.lang.go || a.lang.rs) && runs)
      return yes(a.ciFiles.slice(0, 3), 'formatter run in CI');
    // An ESLint style preset (StandardJS, @stylistic, the Prettier plugin)
    // formats code when CI runs ESLint, so it counts as the formatter.
    const eslintConfigs = a.findHere(
      /(^|\/)(eslint\.config\.[cm]?[jt]s|\.eslintrc(\.[a-z]+)?)$/,
    );
    const presetDep =
      /^(neostandard|standard|eslint-config-standard(-[\w-]+)?|@stylistic\/eslint-plugin[\w-]*|eslint-plugin-prettier|eslint-config-xo|xo)$/m;
    const presetImport =
      /['"](neostandard|standard|eslint-config-standard|@stylistic\/eslint-plugin|eslint-plugin-prettier|eslint-config-xo)['"/]/;
    if (
      configs.length === 0 &&
      (presetDep.test(a.depText) ||
        eslintConfigs.some((f) => presetImport.test(repo.read(f)))) &&
      /\beslint\b/.test(a.enforcedText)
    )
      return yes(
        [...eslintConfigs, ...a.ciFiles.slice(0, 2)],
        'ESLint style preset enforced in CI',
      );
    if (configs.length === 0) {
      const unknown = unknownToolScripts(a, /^(format|fmt)(:|$)/);
      if (unknown) return unknown;
      return no('no formatter configuration found');
    }
    if (!runs)
      return no(
        'a formatter is configured but no CI step or hook checks it',
        configs,
      );
    return yes(configs, 'configured and checked in CI or a hook');
  },

  'Type Checker / Strict Typing': (repo, a) => {
    if (a.lang.go || a.lang.rs || a.lang.typedOther)
      return yes([], 'statically typed language');
    const tsconfigs = a.findHere(/(^|\/)tsconfig[^/]*\.json$/);
    const strict = tsconfigs.filter((f) =>
      /"strict"\s*:\s*true|@tsconfig\/strictest/.test(repo.read(f)),
    );
    if (strict.length) return yes(strict, 'TypeScript strict mode');
    if (a.lang.py) {
      const cfg = a.findHere(
        /(^|\/)(mypy\.ini|\.mypy\.ini|pyrightconfig\.json)$/,
      );
      const pyproject = inApp(a.dir, 'pyproject.toml');
      if (/\[tool\.(mypy|pyright)/.test(repo.read(pyproject)))
        cfg.push(pyproject);
      if (cfg.length && /\b(mypy|pyright)\b/.test(a.enforcedText))
        return yes(cfg, 'type checker configured and run');
      return no(
        cfg.length
          ? 'type checker configured but not run in CI'
          : 'no Python type checker',
        cfg,
      );
    }
    if (tsconfigs.length)
      return no('tsconfig without "strict": true', tsconfigs);
    return no('untyped JavaScript with no type checking');
  },

  'Pre-commit Hooks': (repo, a) => {
    const hooks = [...a.hookFiles];
    if (a.pkg?.['simple-git-hooks'] || a.pkg?.husky)
      hooks.push(inApp(a.dir, 'package.json'));
    return hooks.length
      ? yes(hooks, 'local Git hooks configured')
      : no('no pre-commit hook configuration');
  },

  'Dead Code Detection': (repo, a) => {
    const re =
      /\b(knip|ts-prune|ts-unused-exports|unimported|depcheck|vulture|deadcode|staticcheck|cargo-udeps|cargo-machete|unused)\b/;
    const cfg = a.findHere(
      /(^|\/)(knip\.jsonc?|\.knip\.jsonc?|knip\.config\.[cm]?[jt]s)$/,
    );
    if (cfg.length || re.test(a.depText) || re.test(a.enforcedText))
      return yes(cfg, 'dead code tool configured');
    return no('no dead code detection tool');
  },

  'Single Command Setup': (repo, a) => {
    const readme = readmeOf(repo, a);
    const sources = [
      readme,
      ...repo.files.filter((f) => /^CONTRIBUTING(\.md)?$/i.test(f)),
    ].filter(Boolean);
    const snippets = [
      ...sources.map((s) =>
        section(
          repo,
          s,
          /install|setup|set up|getting started|quick ?start|develop|local/i,
        ),
      ),
      { path: '(package scripts)', text: Object.keys(a.scripts).join(', ') },
      a
        .findHere(/(^|\/)(Makefile|justfile|Taskfile\.ya?ml)$/)
        .map((f) => snippet(repo, f, 30))[0],
    ].filter(Boolean);
    return { judge: true, sources, snippets };
  },

  'Dependencies Pinned': (repo, a) => {
    const locks = a.findHere(
      /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|poetry\.lock|uv\.lock|Pipfile\.lock|pdm\.lock|go\.sum|Cargo\.lock|Gemfile\.lock|composer\.lock)$/,
    );
    return locks.length
      ? yes(locks, 'lockfile committed')
      : no('no committed lockfile');
  },

  'Build Command Documented': (repo, a) => {
    const docs = [
      readmeOf(repo, a),
      ...contextFiles(repo, a),
      ...repo.files.filter((f) => /^CONTRIBUTING(\.md)?$/i.test(f)),
    ].filter(Boolean);
    const snippets = [
      ...docs.map(
        (d) =>
          section(repo, d, /build|run|test|develop|usage|command|script/i) ??
          snippet(repo, d, 30),
      ),
      {
        path: '(package scripts)',
        text: JSON.stringify(a.scripts, null, 1).slice(0, 2000),
      },
    ].filter(Boolean);
    return { judge: true, sources: docs, snippets };
  },

  'Task / Monorepo Tooling': (repo, a) => {
    const tools = a.findHere(
      /(^|\/)(turbo\.json|nx\.json|lerna\.json|pnpm-workspace\.yaml|rush\.json|Makefile|justfile|Taskfile\.ya?ml|tox\.ini|noxfile\.py|mise\.toml)$/,
    );
    if (Object.keys(a.scripts).length >= 2)
      tools.push(inApp(a.dir, 'package.json'));
    return tools.length
      ? yes(tools, 'task runner or package scripts')
      : no('no task runner or scripts');
  },

  'CI Configured': (repo, a) => {
    const ci = a.ciFiles.filter(
      (f) =>
        !f.startsWith('.github/workflows/') ||
        /\b(pull_request|push)\b/.test(repo.read(f)),
    );
    return ci.length
      ? yes(ci, 'CI runs on pushes or pull requests')
      : no('no CI configuration runs on pushes or pull requests');
  },

  'Unit Tests Exist': (repo, a) => {
    if (a.tests.length)
      return yes(a.tests.slice(0, 5), `${a.tests.length} test files`);
    if (
      a.lang.rs &&
      a.sources
        .slice(0, 300)
        .some((f) => f.endsWith('.rs') && repo.read(f).includes('#[test]'))
    )
      return yes([], 'Rust #[test] functions');
    return no('no test files');
  },

  'Tests Runnable': (repo, a) => {
    const test = a.scripts.test;
    if (test && !/no test specified/.test(test))
      return yes([inApp(a.dir, 'package.json')], `test script: ${test}`);
    if (a.lang.go && a.tests.some((f) => f.endsWith('_test.go')))
      return yes([], 'go test');
    if (a.lang.rs) return yes([], 'cargo test');
    const py = a.findHere(
      /(^|\/)(pytest\.ini|conftest\.py|tox\.ini|noxfile\.py)$/,
    );
    if (/\[tool\.pytest/.test(repo.read(inApp(a.dir, 'pyproject.toml'))))
      py.push(inApp(a.dir, 'pyproject.toml'));
    if (py.length) return yes(py, 'pytest configuration');
    if (/^test:/m.test(repo.read(inApp(a.dir, 'Makefile'))))
      return yes([inApp(a.dir, 'Makefile')], 'make test');
    return no('no command runs the tests');
  },

  'Integration / E2E Tests': (repo, a) => {
    const paths = a.files.filter(
      (f) =>
        /(^|\/|[-_.])(e2e|integration|acceptance)([-_./]|$)/i.test(f) &&
        (TEST_FILE.test(f) || /\.(ya?ml)$/.test(f)),
    );
    const cfg = a.findHere(
      /(^|\/)(playwright\.config\.[cm]?[jt]s|cypress\.config\.[cm]?[jt]s|cypress\.json)$/,
    );
    const ci = a.ciFiles.filter((f) => /integration|e2e/i.test(f));
    const dep =
      /\b(@playwright\/test|playwright|cypress|puppeteer|supertest|testcontainers|light-my-request|webdriverio)\b/.test(
        a.depText,
      );
    const evidence = [...cfg, ...ci, ...paths.slice(0, 3)];
    if (evidence.length || dep)
      return yes(evidence, 'integration or end-to-end tests');
    // A second test tree beside the unit tests (hono's runtime-tests/, a
    // tests/ directory next to src/**/*.test.ts) may be integration tests
    // under another name. The script cannot tell, so the reader decides.
    const rel = (f) => (a.dir === '.' ? f : f.slice(a.dir.length + 1));
    const treeOf = (f) => segments(rel(f))[0];
    const trees = [...new Set(a.tests.map(treeOf))];
    // Unit tests live beside the sources or in the conventional test tree.
    const sourceTrees = a.sources.reduce(
      (m, s) => m.set(treeOf(s), (m.get(treeOf(s)) ?? 0) + 1),
      new Map(),
    );
    const mainSourceTree = [...sourceTrees.entries()].sort(
      (x, y) => y[1] - x[1],
    )[0]?.[0];
    const unitTree = (dir) =>
      /^(src|lib|app|packages?|tests?|__tests__|spec)$/.test(dir) ||
      dir === mainSourceTree;
    const other = trees.filter((t) => !unitTree(t));
    if (trees.length > 1 && other.length) {
      const listing = a.tests.filter((f) => treeOf(f) === other[0]);
      return {
        judge: true,
        sources: listing.slice(0, 5),
        snippets: [
          {
            path: '(test trees)',
            text: trees
              .map(
                (t) =>
                  `${t}/: ${a.tests.filter((f) => treeOf(f) === t).length} test files`,
              )
              .join('\n'),
          },
          {
            path: `(${other[0]}/ listing)`,
            text: listing.slice(0, 40).join('\n'),
          },
        ],
      };
    }
    return no('no integration or end-to-end tests');
  },

  'Test File Conventions': (repo, a) => {
    if (a.tests.length < 3) return na('fewer than 3 test files');
    const kind = (f) =>
      /\.test\.[cm]?[jt]sx?$/.test(f)
        ? 'name.test.ext'
        : /\.spec\.[cm]?[jt]sx?$/.test(f)
          ? 'name.spec.ext'
          : /\.tst\.ts$/.test(f)
            ? 'name.tst.ts'
            : /(^|\/)test_[^/]+\.py$/.test(f)
              ? 'test_name.py'
              : /_test\.(go|py)$/.test(f)
                ? 'name_test.ext'
                : 'other';
    const counts = {};
    for (const f of a.tests) counts[kind(f)] = (counts[kind(f)] ?? 0) + 1;
    const [top, n] = Object.entries(counts).sort((x, y) => y[1] - x[1])[0];
    const share = n / a.tests.length;
    const note = `${Math.round(share * 100)}% of ${a.tests.length} test files use ${top}`;
    return share >= 0.8 && top !== 'other' ? yes([], note) : no(note);
  },

  'Coverage Thresholds': (repo, a) => {
    const gate =
      /--check-coverage|--cov-fail-under|fail_under|coverageThreshold|thresholds\s*[:=]|"check-coverage"\s*:\s*true|--100\b|--branches[= ]\d|--lines[= ]\d/;
    const cfgs = a
      .findHere(
        /(^|\/)(\.nycrc(\.json)?|\.c8rc(\.json)?|jest\.config\.[cm]?[jt]s|vitest\.config\.[cm]?[jt]s|\.coveragerc|codecov\.ya?ml|\.taprc)$/,
      )
      .filter(
        (f) =>
          gate.test(repo.read(f)) ||
          (/codecov/.test(f) && /target:/.test(repo.read(f))),
      );
    if (a.pkg?.jest?.coverageThreshold) cfgs.push(inApp(a.dir, 'package.json'));
    if (
      /\[tool\.coverage[\s\S]*fail_under/.test(
        repo.read(inApp(a.dir, 'pyproject.toml')),
      )
    )
      cfgs.push(inApp(a.dir, 'pyproject.toml'));
    if (gate.test(a.enforcedText))
      return yes(
        [...cfgs, ...a.ciFiles.slice(0, 2)],
        'coverage gate runs in CI',
      );
    if (cfgs.length && /cov|c8|nyc|borp|vitest|jest/.test(a.enforcedText))
      return yes(cfgs, 'coverage threshold configured and run');
    return no(
      cfgs.length
        ? 'threshold configured but CI does not run coverage'
        : 'no coverage gate',
      cfgs,
    );
  },

  README: (repo, a) => {
    const readme = a.find(/^README(\.(md|rst|txt))?$/i)[0];
    if (!readme) return no('no README in the app directory');
    const lines = repo
      .read(readme)
      .split('\n')
      .filter((l) => l.trim()).length;
    return lines >= 5
      ? yes([readme], `${lines} lines`)
      : no('README is nearly empty', [readme]);
  },

  'Agent Context File': (repo, a) => {
    const ctx = contextFiles(repo, a);
    if (!ctx.length) return no('no committed AGENTS.md or CLAUDE.md');
    const useful = ctx.filter((f) =>
      COMMAND_IN_TEXT.test(contextText(repo, f)),
    );
    return useful.length
      ? yes(useful, 'committed and names commands')
      : no('committed but names no build, test, or lint command', ctx);
  },

  'Architecture Docs': (repo, a) => {
    const strong = a.findHere(
      /(^|\/)(ARCHITECTURE\.md|DESIGN\.md|docs\/(architecture|design|adr|adrs|decisions)[^/]*(\/.*)?)$/i,
    );
    if (strong.length)
      return yes(strong.slice(0, 5), 'architecture or design docs');
    const docs = a.files.filter((f) =>
      /(^|\/)docs?\/.+\.(md|mdx|rst)$/i.test(f),
    );
    if (!docs.length) return no('no docs directory or architecture doc');
    return {
      judge: true,
      sources: docs.slice(0, 40),
      snippets: [
        { path: '(docs listing)', text: docs.slice(0, 80).join('\n') },
      ],
    };
  },

  'API / Schema Docs': (repo, a) => {
    if (!a.isLibrary && !a.serverDep && !a.deployable)
      return na('not a library or service');
    const docs = a
      .findHere(
        /(^|\/)(openapi[^/]*\.(json|ya?ml)|swagger[^/]*\.(json|ya?ml)|[^/]+\.graphqls?|typedoc\.json|conf\.py)$/i,
      )
      .concat(
        a.files
          .filter((f) => /(^|\/)docs?\/(api|reference)\//i.test(f))
          .slice(0, 3),
      );
    return docs.length
      ? yes(docs.slice(0, 5), 'API or schema docs')
      : no('no API or schema docs');
  },

  'Documentation Freshness': (repo, a) => {
    // Links are checked in every doc. Script names only in developer docs,
    // and only in code with an explicit `run`: a README often shows commands
    // for the user's own app, not this repository's scripts.
    const devDocs = [
      ...contextFiles(repo, a),
      ...repo.files.filter((f) =>
        /^(\.github\/)?CONTRIBUTING(\.md)?$/i.test(f),
      ),
    ];
    const docs = [readmeOf(repo, a), ...devDocs].filter(Boolean);
    const missing = [];
    let checked = 0;
    for (const d of devDocs) {
      const code = [...repo.read(d).matchAll(/```[\s\S]*?```|`[^`\n]+`/g)]
        .map((m) => m[0])
        .join('\n');
      for (const m of code.matchAll(
        /\b(?:npm|pnpm|bun|yarn)\s+run\s+([\w:.-]+)/g,
      )) {
        checked++;
        if (!(m[1] in a.scripts)) missing.push(`${d}: script "${m[1]}"`);
      }
    }
    for (const d of docs) {
      const text = repo.read(d);
      for (const m of text.matchAll(/\]\((?!https?:|#|mailto:)([^)\s#]+)/g)) {
        const target = join(dirOf(d), m[1]).replace(/^\.\//, '');
        // `tessl install` writes .tessl/ and Git ignores it; its links are
        // not the team's to keep fresh.
        if (target.startsWith('.tessl/')) continue;
        checked++;
        if (
          !repo.has(target) &&
          !repo.files.some((f) => f.startsWith(`${target}/`))
        )
          missing.push(`${d}: link ${m[1]}`);
      }
    }
    if (!checked)
      return {
        judge: true,
        sources: docs,
        snippets: docs.map((d) => snippet(repo, d, 40)).filter(Boolean),
      };
    return missing.length
      ? no(
          `${missing.length} of ${checked} references are stale: ${missing.slice(0, 4).join('; ')}`,
          docs,
        )
      : yes(docs, `all ${checked} referenced scripts and links exist`);
  },

  'Environment Template': (repo, a) => {
    const names = new Set();
    for (const f of a.sources.slice(0, MAX_SOURCE_SCAN)) {
      for (const m of repo
        .read(f)
        .matchAll(
          /process\.env\.([A-Z][A-Z0-9_]+)|process\.env\[['"]([A-Z][A-Z0-9_]+)|os\.environ(?:\.get)?\(?\[?['"]([A-Z][A-Z0-9_]+)|os\.getenv\(['"]([A-Z][A-Z0-9_]+)|os\.Getenv\("([A-Z][A-Z0-9_]+)|env::var\("([A-Z][A-Z0-9_]+)/g,
        ))
        names.add(m.slice(1).find(Boolean));
    }
    for (const n of [
      'NODE_ENV',
      'CI',
      'DEBUG',
      'HOME',
      'PATH',
      'TZ',
      'PWD',
      'TERM',
      'NODE_DEBUG',
    ])
      names.delete(n);
    if (names.size < 2)
      return na('the app reads fewer than two environment variables');
    const tpl = a.findHere(
      /(^|\/)(\.env\.(example|sample|template|dist|defaults)|example\.env|env\.example)$/,
    );
    return tpl.length
      ? yes(tpl, `${names.size} variables read; template committed`)
      : no(
          `reads ${names.size} environment variables but has no .env template`,
        );
  },

  'Local Services Setup': (repo, a) => {
    if (!a.dbDep) return na('no database or service dependency');
    const setup = a.findHere(
      /(^|\/)(docker-compose[^/]*\.ya?ml|compose[^/]*\.ya?ml|Tiltfile|devbox\.json|\.devcontainer\/docker-compose[^/]*\.ya?ml)$/,
    );
    return setup.length
      ? yes(setup, 'local services reproducible')
      : no('depends on a database or service with no local setup');
  },

  'Database Schema & Migrations': (repo, a) => {
    if (!a.dbDep) return na('no database dependency');
    const mig = a.files.filter((f) =>
      /(^|\/)(migrations?|alembic|db\/migrate|drizzle)\/|schema\.prisma$|drizzle\.config\.[cm]?[jt]s$|knexfile\.[cm]?[jt]s$/.test(
        f,
      ),
    );
    return mig.length
      ? yes(mig.slice(0, 3), 'versioned schema or migrations')
      : no('database dependency with no versioned migrations');
  },

  'Dev Container': (repo, a) => {
    // A dev container, or another reproducible environment definition:
    // Gitpod, Devbox, Nix, Flox, or Codespaces.
    const dc = a.findHere(
      /(^|\/)(\.devcontainer\/[^/]*devcontainer\.json|\.devcontainer\.json|\.gitpod\.ya?ml|devbox\.json|flake\.nix|shell\.nix|\.flox\/env\/manifest\.toml)$/,
    );
    return dc.length
      ? yes(dc, 'reproducible development environment')
      : no('no dev container or reproducible environment definition');
  },

  'Structured Logging': (repo, a) => {
    const re =
      /\b(pino|winston|bunyan|loglevel|consola|structlog|loguru|python-json-logger|zap|zerolog|logrus|log\/slog|tracing|slog|serilog|logback|log4j)\b/;
    if (!a.deployable && !a.serverDep && !re.test(a.depText))
      return na('not a service and no logger dependency');
    return re.test(a.depText)
      ? yes([], 'structured logger dependency')
      : no('no structured logger');
  },

  'Health Checks': (repo, a) => {
    if (!a.deployable) return na('not a deployable service');
    const hit = a.files
      .filter((f) => SOURCE_FILE.test(f) || /Dockerfile|\.ya?ml$/.test(f))
      .slice(0, MAX_SOURCE_SCAN)
      .filter((f) =>
        /['"`]\/(healthz?|readyz?|livez?|ping|status)['"`]|HEALTHCHECK|livenessProbe|readinessProbe|health_check/.test(
          repo.read(f),
        ),
      );
    return hit.length
      ? yes(hit.slice(0, 3), 'health endpoint or probe')
      : no('deployable with no health endpoint or probe', a.deployFiles);
  },

  'Metrics / Telemetry': (repo, a) => {
    if (!a.deployable) return na('not a deployable service');
    return /\b(prom-client|prometheus|opentelemetry|@opentelemetry\/[\w-]*metrics|statsd|hot-shots|datadog|dd-trace|posthog|segment|amplitude|mixpanel|newrelic|micrometer)\b/.test(
      a.depText,
    )
      ? yes([], 'metrics or telemetry dependency')
      : no('no metrics or telemetry');
  },

  'Error Tracking': (repo, a) => {
    if (!a.deployable) return na('not a deployable service');
    return /\b(sentry|@sentry\/[\w-]+|bugsnag|rollbar|honeybadger|airbrake|raygun)\b/.test(
      a.depText,
    )
      ? yes([], 'error tracking dependency')
      : no('no error tracking');
  },

  'Distributed Tracing': (repo, a) => {
    if (!a.deployable) return na('not a deployable service');
    return /\b(opentelemetry|@opentelemetry\/[\w-]+|dd-trace|jaeger|zipkin|honeycomb|elastic-apm|newrelic)\b/.test(
      a.depText,
    )
      ? yes([], 'tracing dependency')
      : no('no tracing');
  },

  'Secret Scanning': (repo, a) => {
    const re =
      /\b(gitleaks|trufflehog|detect-secrets|ggshield|secretlint|git-secrets|talisman)\b/;
    const cfg = repo.files.filter((f) =>
      /^(\.gitleaks\.toml|\.secrets\.baseline|\.secretlintrc[^/]*|\.talismanrc)$/.test(
        f,
      ),
    );
    return re.test(a.enforcedText)
      ? yes(
          [...cfg, ...a.ciFiles.filter((f) => re.test(repo.read(f)))].slice(
            0,
            3,
          ),
          'secret scanner in CI or a hook',
        )
      : no(
          cfg.length
            ? 'scanner configured but not run'
            : 'no secret scanning in CI or hooks',
          cfg,
        );
  },

  'Dependency Update Automation': (repo) => {
    const f = repo.files.filter((p) =>
      /^(\.github\/dependabot\.ya?ml|renovate\.json5?|\.renovaterc(\.json)?|\.github\/renovate\.json5?)$/.test(
        p,
      ),
    );
    return f.length
      ? yes(f, 'dependency updates automated')
      : no('no Dependabot or Renovate configuration');
  },

  'Gitignore Comprehensive': (repo, a) => {
    const gi =
      repo.read('.gitignore') +
      '\n' +
      (a.dir === '.' ? '' : repo.read(inApp(a.dir, '.gitignore')));
    if (!gi.trim()) return no('no .gitignore');
    const missing = [];
    if (!/^\/?\.env/m.test(gi) && !/^\*\.env/m.test(gi))
      missing.push('.env files');
    if ((a.lang.js || a.lang.ts) && !/node_modules/.test(gi))
      missing.push('node_modules');
    if (a.lang.py && !/__pycache__|\.pyc|\.venv/.test(gi))
      missing.push('Python caches');
    if (a.lang.rs && !/target/.test(gi)) missing.push('target/');
    return missing.length
      ? no(`.gitignore misses ${missing.join(', ')}`, ['.gitignore'])
      : yes(['.gitignore'], 'ignores env files and build output');
  },

  'Secrets Management': (repo, a) => {
    const leaked = a.files.filter((f) => {
      if (
        /(^|\/)(test|tests|fixtures?|testdata|examples?|__tests__)\//i.test(f)
      )
        return false;
      const b = base(f);
      return (
        (/^\.env(\..+)?$/.test(b) &&
          !/\.(example|sample|template|dist|defaults)$/.test(b)) ||
        /\.(pem|key|p12|pfx|jks)$/.test(b) ||
        /^(id_rsa|id_ed25519|credentials\.json|service-account[^/]*\.json)$/.test(
          b,
        )
      );
    });
    return leaked.length
      ? no(
          `secret-shaped files committed: ${leaked.slice(0, 3).join(', ')}`,
          leaked.slice(0, 5),
        )
      : yes([], 'no secret-shaped files committed');
  },

  CODEOWNERS: (repo) => {
    const f = repo.files.filter((p) =>
      /^(CODEOWNERS|\.github\/CODEOWNERS|docs\/CODEOWNERS)$/.test(p),
    );
    return f.length ? yes(f, 'CODEOWNERS present') : no('no CODEOWNERS file');
  },

  'Agent Context Quality': (repo, a) => {
    const ctx = contextFiles(repo, a);
    if (!ctx.length) return no('no committed agent context file');
    return {
      judge: true,
      sources: ctx,
      snippets: ctx.map((f) => ({
        path: f,
        text: contextText(repo, f).split('\n').slice(0, 150).join('\n'),
      })),
    };
  },

  'Skills / Reusable Context': (repo, a) => {
    const f = repo.files.filter(
      (p) =>
        !/(^|\/)(\.tessl|tessl__)/.test(p) &&
        (/(^|\/)SKILL\.md$/.test(p) ||
          /^\.claude\/(commands|agents)\/.+\.md$/.test(p) ||
          /^\.github\/prompts\/.+\.prompt\.md$/.test(p)),
    );
    const tessl = parseJson(repo.read('tessl.json'));
    if (Object.keys(tessl?.dependencies ?? {}).length) f.push('tessl.json');
    return f.length
      ? yes(f.slice(0, 5), 'skills or reusable prompts')
      : no('no skills, commands, or prompt library');
  },

  'MCP Configuration': (repo) => {
    const f = repo.files.filter(
      (p) =>
        /^(\.mcp\.json|\.cursor\/mcp\.json|\.vscode\/mcp\.json|\.gemini\/settings\.json)$/.test(
          p,
        ) ||
        (p === '.codex/config.toml' && /mcp_servers/.test(repo.read(p))),
    );
    return f.length
      ? yes(f, 'MCP servers configured')
      : no('no MCP configuration');
  },

  'Editor / Agent Rules': (repo) => {
    const f = repo.files.filter((p) =>
      /^(\.cursor\/rules\/|\.cursorrules$|\.claude\/|\.github\/copilot-instructions\.md$|\.github\/instructions\/|\.windsurfrules$|\.clinerules|\.roo\/|\.continue\/)/.test(
        p,
      ),
    );
    return f.length
      ? yes(f.slice(0, 5), 'agent or editor rules')
      : no('no agent or editor rule files');
  },

  'Task Discovery': (repo) => {
    const f = repo.files.filter(
      (p) =>
        /(^|\/)(ISSUE_TEMPLATE(\/|\.md$)|PULL_REQUEST_TEMPLATE(\/|\.md$)|pull_request_template\.md$)/i.test(
          p,
        ) ||
        /^CONTRIBUTING(\.md)?$/i.test(p) ||
        /^\.github\/CONTRIBUTING\.md$/i.test(p),
    );
    return f.length
      ? yes(f.slice(0, 5), 'issue or PR templates or a contributing guide')
      : no('no issue templates, PR template, or contributing guide');
  },
};

// The default action for each criterion that fails, when the agent has no
// better one. One concrete step, as the rubric asks.
const ACTIONS = {
  'Linter Configured':
    'Add the ecosystem linter (ESLint, Ruff, golangci-lint, Clippy) and run it as a CI step on pull requests.',
  'Code Formatter':
    'Add a formatter (Prettier, Ruff format, gofmt, rustfmt) and a CI step that checks formatting.',
  'Type Checker / Strict Typing':
    'Turn on strict type checking (tsconfig "strict": true, or mypy or pyright) and run it in CI.',
  'Pre-commit Hooks':
    'Add a pre-commit hook (pre-commit, Husky, or Lefthook) that runs the linter and formatter.',
  'Dead Code Detection':
    'Add a dead code tool (knip, vulture, staticcheck) and run it in CI.',
  'Single Command Setup':
    'Add one documented command, such as `make setup` or an `npm run setup` script, that takes a fresh clone to a working build.',
  'Dependencies Pinned': 'Commit the package manager lockfile.',
  'Build Command Documented':
    'Document the install, build, and test commands in the README.',
  'Task / Monorepo Tooling':
    'Add package scripts or a Makefile for the common tasks.',
  'CI Configured':
    'Add a CI workflow that runs lint and tests on every pull request.',
  'Unit Tests Exist': 'Add unit tests and a test runner.',
  'Tests Runnable': 'Add a `test` script or command that runs the test suite.',
  'Integration / E2E Tests':
    'Add an integration or end-to-end test suite and run it in CI.',
  'Test File Conventions':
    'Pick one test file naming pattern and rename outliers to it.',
  'Coverage Thresholds':
    'Set a coverage threshold in the test runner config and fail CI below it.',
  README: 'Add a README that says what the app is and how to run it.',
  'Agent Context File':
    'Commit an AGENTS.md with the install, build, test, and lint commands, and a CLAUDE.md that includes it.',
  'Architecture Docs':
    'Add an ARCHITECTURE.md describing the main modules and how data flows between them.',
  'API / Schema Docs':
    'Generate or write API reference docs (OpenAPI, TypeDoc, Sphinx) and keep them in the repo.',
  'Documentation Freshness':
    'Fix the stale commands and links in the docs, and check them in CI.',
  'Environment Template':
    'Commit a .env.example listing every environment variable the app reads.',
  'Local Services Setup':
    'Add a docker-compose file that starts the services the app needs locally.',
  'Database Schema & Migrations':
    'Version the schema with a migration tool and commit the migrations.',
  'Dev Container':
    'Add a .devcontainer/devcontainer.json with the toolchain the repo needs.',
  'Structured Logging': 'Replace ad hoc prints with a structured logger.',
  'Health Checks':
    'Add a /healthz endpoint and wire it to the deployment readiness probe.',
  'Metrics / Telemetry':
    'Instrument request metrics with OpenTelemetry or Prometheus.',
  'Error Tracking': 'Add an error tracking integration such as Sentry.',
  'Distributed Tracing': 'Add OpenTelemetry tracing with context propagation.',
  'Secret Scanning':
    'Add gitleaks or trufflehog as a CI step or pre-commit hook.',
  'Dependency Update Automation':
    'Add a .github/dependabot.yml with a weekly update schedule.',
  'Gitignore Comprehensive': 'Add the missing patterns to .gitignore.',
  'Secrets Management':
    'Remove the committed secret files, rotate their values, and load secrets from the environment.',
  CODEOWNERS: 'Add a CODEOWNERS file assigning reviewers by path.',
  'Agent Context Quality':
    'Make the agent context specific: commands, a module map, and hazards such as generated files.',
  'Skills / Reusable Context':
    'Add reusable agent skills or rules for the common tasks in the repo.',
  'MCP Configuration':
    'Add an .mcp.json with the tool servers agents need for this repo.',
  'Editor / Agent Rules':
    'Add agent rules (.cursor/rules or .claude/) for the conventions of the repo.',
  'Task Discovery': 'Add issue and pull request templates.',
};

// ---------------------------------------------------------------- scoring

function label(app) {
  return app === '.' ? 'root' : app;
}

/** Run every detector for every app and build the rubric-shaped draft. */
/**
 * Run one detector on one app. A detector that throws (an odd manifest, a
 * file it did not expect) does not fail the score or guess: the app goes to
 * the reader with the error as its only snippet.
 */
function detect(name, repo, a) {
  try {
    return DETECTORS[name](repo, a);
  } catch (error) {
    return {
      judge: true,
      sources: [],
      snippets: [
        {
          path: '(detector failed)',
          text: `${name} could not be checked by script: ${error?.message ?? error}`,
        },
      ],
    };
  }
}

export function scoreRepo(root) {
  const repo = openRepo(root);
  const { apps, truncated } = discoverApps(repo);
  const facts = apps.map((dir) => appFacts(repo, dir, apps));
  const names = apps.map(label);
  const categories = Object.entries(RUBRIC).map(([category, criteria]) => ({
    name: category,
    criteria: criteria.map((name) => {
      const results = facts.map((a) => ({
        app: label(a.dir),
        ...detect(name, repo, a),
      }));
      const applicable = results.filter((r) => r.applicable !== false);
      const judge = applicable.filter((r) => r.judge);
      const entry = {
        name,
        applicableApps: applicable.length,
        applicableAppNames: applicable.map((r) => r.app),
      };
      if (judge.length) {
        return {
          ...entry,
          passingApps: null,
          passingAppNames: null,
          needsJudgement: true,
          // Apps the script already decided, to keep as decided.
          decided: applicable
            .filter((r) => !r.judge)
            .map((r) => ({ app: r.app, passes: r.pass, note: r.note })),
          judge: judge.map((r) => ({
            app: r.app,
            sources: r.sources,
            snippets: r.snippets,
          })),
          sources: [...new Set(judge.flatMap((r) => r.sources))],
        };
      }
      const passing = applicable.filter((r) => r.pass);
      const failing = applicable.filter((r) => !r.pass);
      const rationale =
        applicable.length === 0
          ? `Not applicable: ${results[0]?.why ?? 'no app'}.`
          : [
              passing.length
                ? `Passes in ${passing.map((r) => r.app).join(', ')} (${passing[0].note}).`
                : '',
              failing.length
                ? `Fails in ${failing.map((r) => r.app).join(', ')}: ${failing[0].note}.`
                : '',
            ]
              .filter(Boolean)
              .join(' ');
      return {
        ...entry,
        passingApps: passing.length,
        passingAppNames: passing.map((r) => r.app),
        rationale,
        ...(failing.length ? { action: ACTIONS[name] } : {}),
        method: 'checked',
        evidence: [
          ...new Set(applicable.flatMap((r) => r.evidence ?? [])),
        ].slice(0, 8),
      };
    }),
  }));
  return {
    repo: basenameOf(root),
    apps: names,
    appsTruncated: truncated,
    categories,
  };
}

function basenameOf(root) {
  const remote = git(root, ['remote', 'get-url', 'origin']);
  const m = remote && /[/:]([^/:]+\/[^/]+?)(\.git)?\s*$/.exec(remote);
  return m ? m[1] : root.split('/').filter(Boolean).at(-1);
}

/**
 * Re-check a branch against a finished baseline. Checked criteria are re-run;
 * each app whose result changed becomes a flip for rescore.mjs, citing the
 * changed files among the detector's evidence. Judgement criteria whose
 * sources the branch changed are listed for the agent to re-judge.
 */
export function compareToBaseline(root, baseline, changedFiles) {
  const now = scoreRepo(root);
  const changed = new Set(changedFiles);
  const rejudged = [];
  const needed = [];
  const unattributed = [];
  for (const category of now.categories) {
    for (const crit of category.criteria) {
      const was = baseline.categories
        .find((c) => c.name === category.name)
        ?.criteria.find((c) => c.name === crit.name);
      if (!was) continue;
      if (crit.needsJudgement) {
        const touched = crit.sources.filter((s) => changed.has(s));
        if (touched.length)
          needed.push({
            category: category.name,
            name: crit.name,
            changedSources: touched,
            judge: crit.judge,
            baseline: {
              passingAppNames: was.passingAppNames,
              rationale: was.rationale,
            },
          });
        continue;
      }
      const flips = was.applicableAppNames
        .filter((app) => crit.applicableAppNames.includes(app))
        .filter(
          (app) =>
            was.passingAppNames.includes(app) !==
            crit.passingAppNames.includes(app),
        )
        .map((app) => ({ app, passes: crit.passingAppNames.includes(app) }));
      if (!flips.length) continue;
      // The change may have removed the file the baseline pointed at, so the
      // baseline's evidence attributes a flip as well as the branch's.
      const evidence = [
        ...new Set([...crit.evidence, ...(was.evidence ?? [])]),
      ].filter((e) => changed.has(e));
      if (!evidence.length) {
        unattributed.push(`${category.name} / ${crit.name}`);
        continue;
      }
      rejudged.push({
        category: category.name,
        name: crit.name,
        rationale: crit.rationale,
        evidence,
        changes: flips.map((f) => ({ ...f, evidence })),
        ...(crit.action ? { action: crit.action } : {}),
      });
    }
  }
  return { rejudged: { criteria: rejudged }, needed, unattributed };
}

// ---------------------------------------------------------------- CLI

/** Where a path really lands: its nearest existing ancestor, resolved. */
function realDestination(path) {
  if (existsSync(path)) return realpathSync(path);
  const parent = resolve(path, '..');
  return parent === path
    ? path
    : join(realDestination(parent), path.slice(parent.length + 1));
}

function parseArgs(argv) {
  const opts = {
    root: process.cwd(),
    out: null,
    baseline: null,
    changed: null,
  };
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (flag === '-h' || flag === '--help') return { help: true };
    if (value === undefined) throw new Error(`${flag} needs a value`);
    if (flag === '--root') opts.root = resolve(value);
    else if (flag === '--out') opts.out = resolve(value);
    else if (flag === '--baseline') opts.baseline = resolve(value);
    else if (flag === '--changed') opts.changed = resolve(value);
    else throw new Error(`unknown flag ${flag}`);
  }
  if (!opts.out) throw new Error('--out DIR is required');
  const top = git(opts.root, ['rev-parse', '--show-toplevel'])?.trim();
  if (top) {
    const rel = relative(realpathSync(top), realDestination(opts.out));
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)))
      throw new Error(`--out must be outside the repository (${top})`);
  }
  if (Boolean(opts.baseline) !== Boolean(opts.changed))
    throw new Error('--baseline and --changed go together');
  return opts;
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`score-repo: ${error.message}`);
    process.exit(2);
  }
  if (opts.help) {
    console.log(
      'Usage: node score-repo.mjs --out DIR [--root DIR] [--baseline FILE --changed FILE]',
    );
    return;
  }
  mkdirSync(opts.out, { recursive: true });
  if (opts.baseline) {
    const baseline = JSON.parse(readFileSync(opts.baseline, 'utf8'));
    const changed = readFileSync(opts.changed, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const { rejudged, needed, unattributed } = compareToBaseline(
      opts.root,
      baseline,
      changed,
    );
    writeFileSync(
      join(opts.out, 'rejudged.json'),
      `${JSON.stringify(rejudged, null, 2)}\n`,
    );
    writeFileSync(
      join(opts.out, 'rejudge-needed.json'),
      `${JSON.stringify(needed, null, 2)}\n`,
    );
    console.log(
      `${rejudged.criteria.length} checked criteria changed; written to rejudged.json`,
    );
    console.log(
      `${needed.length} judgement criteria need re-judging: ${needed.map((n) => n.name).join(', ') || 'none'}`,
    );
    if (unattributed.length)
      console.log(
        `Changed without a changed file as evidence (left at baseline): ${unattributed.join(', ')}`,
      );
    return;
  }
  const draft = scoreRepo(opts.root);
  const outPath = join(opts.out, 'agent-readiness.json');
  writeFileSync(outPath, `${JSON.stringify(draft, null, 2)}\n`);
  const all = draft.categories.flatMap((c) => c.criteria);
  const judge = all.filter((c) => c.needsJudgement);
  console.log(outPath);
  console.log(
    `${draft.apps.length} app(s): ${draft.apps.join(', ')}${draft.appsTruncated ? ' (truncated)' : ''}`,
  );
  console.log(
    `${all.length - judge.length} criteria checked; ${judge.length} need judgement: ${judge.map((c) => c.name).join(', ')}`,
  );
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
)
  main();
