# Verifiers

How to write `tessl change verify` verifiers for the candidates routed to
verifiers, register them so they do not fail on the repository's existing code,
and try each one on a few files.

The `tessl-verify` skill owns verifier authoring: the file shape, writing
`relevant_when` and the checklist, scopes, content filters, and tuning. Use it
for those. This page adds only what `prepare-repo` needs on top. Read
`tessl change verify --help` before running anything.

The `tessl-verify` skill does not ship with this plugin. The skills check in
[step 1](../SKILL.md#1-baseline) checks for it and handles a missing one.

Each section belongs to one step of the skill:

- **Step 4 (route):** use this page only to decide that a candidate belongs in
  the verifier tier. Write nothing yet.
- **Step 6 (apply):** sections 1 and 2, on the apply branch, only for the
  verifiers the user confirmed in step 5. They write the files, edit
  `tessl.json`, and run only free lint and dry-run commands.
- **Step 7 (try the checks):** sections 3 and 4. Section 3 is the session's
  paid run, 3 sample calls and 1 replay call per new verifier, run again
  once for a verifier that is tuned, announced in the last proposal message
  of step 5. Section 4 runs only free lint and dry-run commands.

Write nothing and run no paid command before the user confirms in step 5.

The sample command below passes `--verifier <id>` once for each new
verifier, so verifiers already in a reused group are not judged or billed and
do not mix into the results.

## 1. Write one file per rule

1. Pick a group name for this batch, such as the repository or the area the
   rules cover. Reuse an existing group in `tessl.json` when the new rules fit
   its `include` globs and its level.
2. Write one verifier JSON per picked candidate under `verifiers/<group>/`,
   named for the rule in kebab case, such as
   `verifiers/core/errors-name-a-next-step.json`. The file name, without
   `.json`, is the verifier id.
3. Write `context` from the candidate's evidence: why the rule matters, and
   where it was seen, such as "Raised in review on #31, #40, and #52" or "The
   `lint` job failed on this in 6 pull requests". For a bots-only candidate,
   write "Review bots flagged this on #31 and #40". Name pull requests
   and CI runs by number or link. Never paste review text, author names, or
   anything else from `evidence.json`.
4. When a lint rule or test enforces the whole rule (see
   [routing](routing.md#one-home-per-rule)), add a `covered_by` link, as in
   [Coverage links](#coverage-links).
5. Run `tessl change verify lint <file>` on each new file. Fix every error
   before going on.

## 2. Register the group

Edit the root `tessl.json`. Add or extend `verify.groups.<group>` and keep
every other key in the file as it is. When the repository has no
`tessl.json`, create it with only the `verify` block; no other key is
required.

- **`path`**: the glob for the group's files, such as
  `verifiers/<group>/*.json`.
- **`include`**: globs for the source the rules apply to. Leave out tests,
  fixtures, generated files, and vendored code unless a rule governs them, by
  adding them to `exclude`. A diff-scope verifier whose rule names a
  companion file, such as the test a fix must add or the doc it must update,
  needs those files inside its `include`, or the judge never sees them in
  the diff. Give it its own group when the group's `exclude` drops them.
- **`content`**: a prefilter, only when a rule applies just to files that
  contain certain code, such as `{ "containsAny": ["new UserFacingError("] }`.
  Put it on the group when it fits every rule, or under
  `verifiers.<verifier-id>.content` when it fits one. It must match every file
  that could break the rule; when you cannot be sure of that, leave it out.
- **`level`**: for a new group, set by the sample in section 3. Start with
  `"error"` and lower a verifier to `warn` only when section 3 says so. A
  reused group keeps its level; set each new verifier's level under
  `verifiers.<verifier-id>.level` instead.

Then run `tessl change verify --dry-run --all --show-files --group <group>`.
Check that each verifier lists the files you meant it to, and none that are
empty or wrong. Narrow `include` or the content filter until it does.

## 3. Sample and replay

Each new verifier gets one batch of paid calls: a sample of 3 of its own
files, which shows it is quiet on code that is fine, and one replay of the
change it came from, which shows it catches the mistake. Prepare everything
for free first, spend once, then tune once with both results in view.

### Pick the replay

For each verifier, pick one pull request or commit from its evidence that
broke the rule before its fix: a fix pull request for the rule's mistake, or
a fix commit from `fixCommits`. The pre-fix state is the fix's parent commit,
or the merge commit's first parent for a pull request. When no evidence shows
the rule being broken, because the evidence is pull requests that follow it,
pick one of those and expect a pass.

### Prepare, free

Replay in a temporary Git worktree outside the repository, detached at the
pre-fix commit. Copy in the new verifier files and the edited `tessl.json`
and commit them, so the verifiers are not themselves changed files. For a
diff-scope verifier, apply the fix on top and commit that too.

Then dry-run every replay in one pass, before any paid call:

- **File scope:**
  `tessl change verify --dry-run --all --group <group> --verifier <id> --include <file>`
  with the file the fix changed.
- **Diff scope:**
  `tessl change verify --dry-run --base <the verifiers commit> --group <group> --verifier <id>`.

A replay goes on only when its plan says 1 matching file and 1 judge call.
A plan with 0 files means the path or the working directory is wrong; fix it
before spending. A diff-scope plan that lists the fix but not its test or
doc means the group's `include` drops the companion file; fix the group as
section 2 says.

### Spend

Run, per verifier:

- the sample, `tessl change verify --all --group <group> --verifier <id> --sample 3`,
  one command per verifier so each is judged on 3 of its own files;
- the replay, the dry-run command above without `--dry-run`, with
  `--report-json` to a file outside the repository.

That is 4 judge calls per file-scope verifier. Diff-scope verifiers do not
run with `--all`, so they get no sample: 1 call, and the replay is their
only test. The sample is deterministic: sampling again after a tune judges
the same files.

### Sort

Each sample failure is one of:

- **The code is fine**: the verifier overreaches.
- **A real violation**: the rule holds and existing code breaks it. Note the
  file for the pull request.

Each replay is one of:

- **Caught:** it failed the pre-fix code or the violating diff. Report it as
  "caught #N as it was before the fix".
- **Missed:** it passed code that breaks the rule, or judged it not relevant.
  Confirm the violation in the replayed code itself, not from what the fix
  says.
- **Expected pass:** the evidence follows the rule and the verifier passed
  it. Report it as "passed #N, which follows the rule; no past change broke
  it, so the catch is untested". A failure here is a false alarm.

### Tune once

A verifier with an overreach, a miss, or a replay false alarm gets one tune
with the `tessl-verify` skill, written so the new wording passes the code
that is fine and still catches the replay. Then rerun its sample and its
replay together, 4 more calls, or 1 for diff scope. After that rerun:

- sample failures that are still not consistently real violations delete
  the verifier: remove its file and any `verifiers.<verifier-id>` entry in
  `tessl.json`;
- a replay still missed lands the verifier at `warn`, and the pull request
  says it missed its own evidence.

Remove each worktree when done.

### Set the level

Set each verifier's level from its real sample violations:

- **None found**: `error`. The pull request says the level rests on a 3-file
  sample and one replay.
- **Any found**: `warn`, as a verifier override under
  `verifiers.<verifier-id>.level` when the rest of the group is `error`.
  This is the temporary rollout exception the `tessl-verify` skill allows:
  the rule is calibrated, and only existing code stops it gating. Record
  that reason and the file in the pull request, with how to promote it: fix
  the existing code, then set the level to `error`.

Tell the user, for each verifier, its level, what its sample found, what its
replay found with the commit it was replayed on, and the judge calls spent.

## 4. Lint again

Run `tessl change verify lint` on every new or changed verifier file, then
`tessl change verify --dry-run --all --group <group>` to check that
`tessl.json` still loads.

## Coverage links

A `covered_by` entry tells verify that a lint rule or test already enforces
the rule, so the judge is skipped while the link is fresh. Each entry has:

- **`type`**: `lint`, `test`, or `other`.
- **`target`**: the repository-relative path of the lint rule or test file.
- **`hash`**: `sha256:` and the hex SHA-256 of the target file's bytes.
- **`verifier_fingerprint`**: `sha256:` and the hex SHA-256 of the verifier's
  rule. Build the hashed text from the trimmed `instruction`, then for each
  checklist item, in order, its `name`, trimmed `rule`, and trimmed
  `relevant_when` (empty when absent) joined by newlines. Join those parts
  with `\n---\n`.
- **`note`**: optional, what the target checks.

Compute both hashes with a short script once the verifier's wording is final.
`tessl change verify lint` prints each link as `rule fresh` or `rule-stale`;
fix a `rule-stale` link before going on. Lint does not check `target` or
`hash`, so then run `tessl change verify --dry-run --all --group <group>` and
confirm the verifier shows covered targets and no `coverage=target-stale` or
`coverage=rule-stale`. Editing the rule or the target later makes the link
stale, and the judge runs again.
