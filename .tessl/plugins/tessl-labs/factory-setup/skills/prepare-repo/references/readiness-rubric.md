# Agent readiness rubric

## Per-app scoring

First identify the repository's **apps**: the independently deployable or
maintained units. In a monorepo these are the directories under `apps/`,
`packages/`, `services/`, and similar (each with its own manifest / build /
deploy). A single-service repository has exactly one app: the repo itself.

Then score every criterion in all eight categories **per app**, not once for the
whole repo. For each criterion, count:

- `applicableApps`: how many apps the criterion could apply to (exclude apps
  where it genuinely does not, e.g. a database criterion for an app with no
  database). `0` means the criterion applies to no app, so it is skipped.
- `passingApps`: of those, how many actually satisfy it.

A capability enforced centrally (root CI, shared config that all apps inherit)
counts as satisfied for every app it covers. A capability present in only some
apps counts only for those; do not round up to the whole repo.

**Judge strictly.** An app satisfies a criterion only if the capability is
present **and actually in effect**. A config file that nothing runs does not
count (the linter must run in CI or a hook, the coverage threshold must fail the
build, the documented test command must work). When in doubt for an app, it does
not pass. Most real monorepos have significant per-app gaps and should land in
the middle, not the top.

## Categories and criteria

### Style & Validation

- **Linter Configured**: a linter is configured (eslint/oxlint/ruff/clippy/…).
- **Code Formatter**: an autoformatter is configured (prettier/oxfmt/ruff/gofmt/…).
- **Type Checker / Strict Typing**: static typing is enforced (tsconfig strict, mypy, a typed language).
- **Pre-commit Hooks**: local git hooks run linters/formatters before commit.
- **Dead Code Detection**: tooling flags unused code/exports (knip, ts-prune, …).

### Build System

- **Single Command Setup**: one documented command takes a clone to a running or building state.
- **Dependencies Pinned**: a committed lockfile pins dependency versions.
- **Build Command Documented**: the build/run commands are documented.
- **Task / Monorepo Tooling**: a task runner or monorepo orchestrator is configured where relevant.
- **CI Configured**: CI runs build/lint/test on pushes or PRs.

### Testing

- **Unit Tests Exist**: the repository contains unit tests.
- **Tests Runnable**: a documented command runs the tests.
- **Integration / E2E Tests**: higher-level tests exist beyond units.
- **Test File Conventions**: a consistent test-file naming/location convention is followed.
- **Coverage Thresholds**: a coverage gate is enforced.

### Documentation

- **README**: a README documents what the project is and how to run it.
- **Agent Context File**: an `AGENTS.md` / `CLAUDE.md` documents conventions and commands for agents.
- **Architecture Docs**: design/architecture documentation exists.
- **API / Schema Docs**: generated or maintained API/schema docs exist where relevant.
- **Documentation Freshness**: docs appear maintained (referenced commands and paths still exist).

### Development Environment

- **Environment Template**: a `.env.example` (or equivalent) lists required configuration.
- **Local Services Setup**: local dependencies are reproducible (docker-compose / Tilt / scripts).
- **Database Schema & Migrations**: schema and migrations are versioned where a database is used.
- **Dev Container**: a reproducible dev container is provided.

### Observability

- **Structured Logging**: a structured logger is used rather than ad-hoc prints.
- **Health Checks**: deployable services expose health/readiness endpoints.
- **Metrics / Telemetry**: metrics or product telemetry is instrumented.
- **Error Tracking**: an error-tracking integration is configured (Sentry/…).
- **Distributed Tracing**: request/trace propagation is instrumented where relevant.

### Security

- **Secret Scanning**: secret scanning runs in CI or hooks.
- **Dependency Update Automation**: dependabot/renovate or equivalent is configured.
- **Gitignore Comprehensive**: `.gitignore` excludes secrets, build output, and local files.
- **Secrets Management**: secrets are sourced from a manager/env, never committed.
- **CODEOWNERS**: a `CODEOWNERS` file assigns review ownership.

### Agent Readiness

- **Agent Context Quality**: agent-context files are specific and actionable, not boilerplate.
- **Skills / Reusable Context**: reusable agent skills, rules, or prompt libraries are present.
- **MCP Configuration**: MCP servers or tool integrations are configured for agents.
- **Editor / Agent Rules**: `.cursor/rules`, `.claude/`, or similar agent rules exist.
- **Task Discovery**: issue/PR templates or tracked task conventions help an agent find work.

## Output: `agent-readiness.json`

Write your judgements to `agent-readiness.json` in the repository root. Record
the discovered `apps` and, per criterion, only `applicableApps` / `passingApps`
counts plus a `rationale`, and no totals, pass rates, scores, statuses, or levels.
Those are computed by `scripts/build-report.mjs`, which reads this file, derives
every aggregate, and renders `agent-readiness-report.md`.

Shape:

```json
{
  "repo": "<repository name>",
  "apps": ["apps/backend", "apps/frontend", "apps/cli"],
  "categories": [
    {
      "name": "Testing",
      "criteria": [
        {
          "name": "Unit Tests Exist",
          "applicableApps": 3,
          "passingApps": 3,
          "rationale": "All three apps have *.test.ts files and a test runner configured."
        },
        {
          "name": "Coverage Thresholds",
          "applicableApps": 3,
          "passingApps": 1,
          "rationale": "Only apps/backend enforces a coverage gate; frontend and cli do not.",
          "action": "Add a coverage threshold to the frontend and cli vitest configs and fail CI below it."
        }
      ]
    }
  ],
  "recommendations": [
    {
      "title": "Enforce a coverage gate in every app",
      "detail": "Set a coverage threshold in each app's test config and fail the CI job when it drops below it."
    }
  ]
}
```

- List every discovered app in `apps` (at least one). For a single-service repo,
  that is one entry.
- Include all eight categories, each using the exact `name` above, and in
  each one every criterion listed under it, once, by its exact name. The
  builder rejects a missing, renamed, extra, or repeated criterion.
- For each criterion set `applicableApps` (0 if it applies to no app → skipped)
  and `passingApps` (0 ≤ passingApps ≤ applicableApps). The builder derives the
  status: all applicable apps pass → `passed`; some/none → `failed`; zero
  applicable → `skipped`.
- Keep each `rationale` to one or two sentences; where adoption is partial, say
  which apps pass and which do not.

### Actions

- Every criterion the builder will mark `failed` (i.e. `passingApps <
  applicableApps`) MUST include an `action`: one concrete, specific engineering
  step that closes the gap across the apps that lack it. Fully-passing and
  skipped criteria omit `action`.
- Make each action specific and directly runnable: name the file, tool, config,
  or CI step to change (e.g. "Add a `dependabot.yml` with a weekly npm update
  schedule", "Add a `/healthz` route and wire it to the k8s readiness probe").
  Not vague advice ("improve observability").
- `recommendations` is the 2 to 3 highest-impact actions to start with. Each has a
  `title` and a one-sentence `detail`. Order by impact.

The builder scores each criterion as `passingApps / applicableApps`, derives
each category's pass rate and the **app-weighted** `overallScore`
(total passing apps / total applicable apps across all criteria), and the
maturity level: <40% → 1 (Functional), 40-59% → 2 (Documented), 60-79% →
3 (Standardized), 80-91% → 4 (Optimized), ≥92% → 5 (Autonomous). It renders the
coverage fractions, `recommendations`, and the gaps → actions table.
