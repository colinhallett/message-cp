# Lint rules and tests

How to propose a lint rule or test for a candidate routed to lint or test, using the linters and test runner the repository already has.

This version only proposes. Do not enable a rule, edit lint config, add a test, or fix a violation. Enabling a rule across an existing repository produces a very large pull request, so the proposal is the whole output. Lint and test proposals are not items the user picks in step 5, and step 6 applies none of them.

Each section belongs to one step of the skill:

- **Step 4 (route):** "Detect the linters", "Choose the home for each candidate", and "Count current violations". The counts are local, read-only runs that spend no credits.
- **Step 5 (pick):** "What a proposal says", for the step 5 list.
- **Step 8 (open the pull request):** "What a proposal says" again, for the pull request body and the closing message.

## Detect the linters

Find what the repository already runs, from two sources:

- **Config files:** linter and formatter configs at the root and in each project, such as ESLint, Biome, Ruff, golangci-lint, Clippy, RuboCop, Checkstyle, ast-grep, or Semgrep rules. Note which projects each config covers.
- **CI steps:** the lint, typecheck, and test steps in the CI workflows. A tool that runs in CI is the one that gates merges, even when its config is hard to find.

Record, for each tool: its name, the config path, the projects it covers, and whether CI runs it. A tool configured but never run in CI is a weaker home, so say so.

Find the test runner the same way, for the rules that fit a test better than a lint rule.

If the repository has no linter, propose none. Tell the user in one line that lint-tier candidates have no home, and route them to a test, a verifier, or agent context instead.

## Choose the home for each candidate

For each lint-tier candidate, pick the first that fits:

1. **An existing rule** in a linter the repository already runs, not yet enforcing the candidate on the code it covers. Name the rule and its options. A rule enforces the candidate only when all of these hold: it is enabled for that code, its current options cover the candidate, and a violation fails a CI step that gates merges, so it is set to error, or its warnings fail the run (such as ESLint with `--max-warnings 0`). A local Git hook does not count, because it can be missing on a clone or skipped with `--no-verify`. Then propose nothing here and handle it as [one home per rule](routing.md#one-home-per-rule) says. Otherwise it is a proposal for the change that would make it gate: the options it would need, such as a restricted-imports rule that lists other imports, raising its severity, or adding its linter to CI when only a hook or nothing runs it.
2. **A custom rule** in that same linter, or in a structural search tool the repository already uses. Use this only when no built-in rule matches.
3. **A test** in the test runner the repository already uses, when no linter rule fits, such as a rule about relationships between files or generated output that a linter cannot see.

Do not propose a new tool. A rule that needs one fails the ladder here and moves to the next tier.

## Count current violations

For each proposal, count how many places break the rule today. Count only that rule, not the repository's existing violations of its other rules:

- **An existing rule:** select just that rule where the tool supports it, such as `ruff check --select <code>`, or take the tool's JSON output and keep only the diagnostics with that rule id.
- **A custom rule** in ast-grep or Semgrep: run the tool with the rule inline, such as `ast-grep scan --inline-rules` or `semgrep -e`.
- **A test:** count only when the check reduces to an exact search over the tracked files. Otherwise report the count as not measured and say why.

Keep every run read-only. Step 5 has not happened yet, so the repository must not change:

- Call the linter binary directly, not the repository's lint script, which may add fix, write, or cache flags.
- Never pass a fix or write flag.
- Turn caches off, or point them outside the repository, such as `ruff --no-cache` or mypy's `--cache-dir`.
- Put any temporary config in a new temporary directory outside the repository, never inside the Git worktree.
- Install nothing. If the tool or its dependencies are missing, fall back to a text search when the rule is a pattern one can find, such as `new Error(` in the files the rule covers: search the tracked files with `git grep`, and report the count as "<n> by text search; <tool> isn't installed". When no search can stand in for the rule, report the count as not measured.
- Scope each run to the projects the rule covers, and stop it after a few minutes. On a timeout, report the count as not measured.
- Check that `git status --porcelain` is the same after the run as before it. If it changed, tell the user what the run wrote.

Report the count and the number of files and projects it spans, and whether it came from the linter or a text search. If the count cannot be measured, say so and why. Never estimate.

The count tells the user the cost of enabling the rule:

- **Zero:** safe to enable now.
- **A handful:** enable together with the fixes.
- **Many:** say that enabling needs a staged rollout, such as a baseline or a per-directory switch, and name the mechanism the linter offers.

## What a proposal says

In step 5, show the lint and test proposals as their own group, unnumbered, under the heading "Lint, for your team to decide (not applied)", in the format from [routing](routing.md#the-proposal-list). Each is one line: the rule, what enforces it (the existing rule, or the custom rule or test that would be written), how many files break it today, and "Seen on". Nothing applies these in this version.

In the pull request body and the closing message, give each lint proposal these lines:

- **Enforced by:** the existing rule, or the custom rule or test that would be written.
- **Goes in:** the config file or directory where it would live.
- **Current violations:** the count, and the files and projects it spans.
- **Rollout:** one line, from the count above.
