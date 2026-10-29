# Applying the picked items

How to make the picked changes on one branch, check them, and land them as one
pull request the team can review. Each section names the
[SKILL.md](../SKILL.md) step it runs in.

Nothing here runs before the user confirms in step 5. Lint and test proposals are
never applied; they go into the pull request body for the team to decide.

## Start the branch (step 6)

1. Fetch the remote default branch from the preflight and start one branch
   from `origin/<default branch>`, not from a local copy that may be out of
   date.
2. Name it `prepare-repo-for-agents`. If that name exists locally or on the
   remote, add `-2`, `-3`, and so on until the name is free.
3. Record the commit the branch starts from: `git rev-parse HEAD`. Call it the
   branch start. The re-score diffs against it.

## Write the files (step 6)

Make every picked change on that branch, one tier at a time, from the step 6
sections that [SKILL.md step 6](../SKILL.md#6-apply) lists. Write only what
the user picked. Leave every file outside those changes as it is.

Before writing each file, read it again on the new branch. When an item no
longer fits it, such as a heading that is not there, a line it already states,
or a verify group that is missing, skip the item and tell the user.

## Try the verifiers (step 7)

The paid run in the session is the batch in
[verifiers](verifiers.md#3-sample-and-replay) section 3: a sample of 3
files and one replay of the change it came from per new verifier, 4 judge
calls, or 1 for a diff-scope verifier, and the same again for a verifier
that is tuned once. The last proposal message in step 5 says it will run,
with the number of verifiers, so it needs no further approval; `tessl change
verify lint` and `--dry-run` commands are free. Afterwards report the calls
actually spent. A verifier whose findings are not real after its one tune is
deleted: remove its file under `verifiers/<group>/` and its entries in
`tessl.json`. Verifiers load from the group's `path` glob, so a file left in
place still runs.

Nothing else is run against history in this session. Each verifier lands at
the level its sample set, `error` when it found no real violation and `warn`
when it did, or `warn` when its replay missed its own evidence twice, and
the pull request body says which and why. Lenses are not run; the pull
request says each is untested until reviews run.

## Check the configuration (end of step 7)

Check the configuration before you commit, so every fix lands in the commit
of its category:

1. Run `tessl doctor --automations`. It checks only that `tessl.json` loads and
   validates its `actions`, `triggers`, and `schedules` blocks, which this
   branch does not change. Act only on a report that `tessl.json` does not
   load, and ignore its other sections.
2. For each verify group this branch added or changed, run
   `tessl change verify lint` on its files, then
   `tessl change verify --dry-run --all --group <group>`. Check that it lists
   only the verifiers that survived step 7, and no `coverage=target-stale` or
   `coverage=rule-stale`.
3. Nothing checks `.tessl-code-review.yml` locally. When the branch changed
   it, read it again against [The profile](lenses.md#the-profile) rules.

Fix what these find. Tell the user what each finding means for them, not what
it says.

## Commit (end of step 7)

Commit once the samples and replays are settled, so the tuning lands in the
same commits.
Make one commit per category, in this order, and skip a category with no
picked items:

1. **Context:** the context files, and any `.tessl/memory/` files the picked
   items edited.
2. **Verifiers:** the verifier files that survived step 7 and `tessl.json`.
3. **Lenses:** the lens files that survived step 7 and
   `.tessl-code-review.yml`.

Follow the repository's commit message convention from its context files or
recent history. Stage each file by path, and check the staged list before each
commit. Never commit `evidence.json`, score files, or verify reports.

## Re-score (step 8)

When step 1 scored the repository, re-score the branch following
[the re-score in scoring](scoring.md#re-score-step-8), after every commit is
made. It re-judges only the criteria whose evidence the branch changed and
carries the step 1 result over for the rest, so the score moves only where the
branch did. Show the score before and after, and each re-judged criterion's
coverage before and after. The score directory is outside the repository, so
its files never reach the pull request.

## Push and open the pull request (step 8)

Ask: "Do you want me to push this and open a pull request?" If the user says
no, tell them the branch name and go on to the closing message. If yes, push
the branch, open one pull request against the default branch, and give the
user its link.

The pull request body says:

- each applied change, grouped by category, with its rule and evidence in one
  line, as the step 5 list showed it;
- for each verifier, its level and what its 3-file sample found (real
  violations, false alarms it was tuned for, or nothing), and for one at
  `warn`, the file that breaks it and how to promote it, as
  [verifiers](verifiers.md#3-sample-and-replay) says;
- for each verifier, what its replay found: the pull request or commit it
  was replayed on, and whether it caught it as it was before the fix, passed
  it because it follows the rule, or missed it;
- for each lens, that it is untested until reviews run, and that the
  "Learn from past work" starter records what it gets wrong;
- the lint and test proposals, in the format from
  [lint](lint.md#what-a-proposal-says), under a heading that says they are
  not applied and are for the team to decide, followed by any "needs
  <plugin>" items with the plugin each one needs;
- the score before and after, when step 1 scored the repository.

When the branch added or changed lenses, also give the user
[Tell the user](lenses.md#tell-the-user) from the lenses reference.

## Closing message (step 8)

End with one completion message, whether or not the user chose to push, so
it is plain that setup is finished. Use this shape, in this order:

1. The opening line from the example below, exactly as written, on its own
   line.
2. The readiness score before and after, when step 1 scored the repository.
3. The pull request link, or "Branch: <name>, not pushed" when the user did
   not push.
4. **What changed:** one line per group that changed (verifiers, review
   rules, agent context), saying what was added. Do not repeat the evidence.
5. **What happens next:** what the user should expect, in a few lines:
   - new verifiers report on every pull request at the level each was set
     to, a `warn` one never blocks, and how to make one required once it
     proves reliable;
   - the lint and test proposals, for the team to decide, none applied: when
     the user pushed, say they are in the pull request description; when the
     user did not push, list them here in the format from
     [lint](lint.md#what-a-proposal-says);
   - any "needs <plugin>" items, with the plugin to install for each;
   - any evidence source that was skipped, and what would turn it on;
   - that nothing takes effect until the pull request merges, or, when the
     user did not push, how to push it.
6. The full [progress timeline](../SKILL.md#progress-timeline), every stage
   marked done or skipped.

For example:

```
✓ Your repository is prepared for agents!

Readiness: 61% → 72%
Pull request: https://github.com/acme/web/pull/15

What changed
- 2 verifiers, at warning level: public type changes need a type test; option changes update Server.md.
- AGENTS.md is now committed, with CI commands and the two generated files marked.

What happens next
- The verifiers report on every new pull request but never block it. Once they've proven reliable, switch them to error to make them required.
- The 2 lint rules are in the pull request description for your team to decide.
- Nothing runs until you merge the pull request.

Preparing your repository
✓ Baseline: Level 3/5, 61%; installed tessl-verify.
✓ Gather evidence: 10 pull requests, 2 CI failures, 41 fix commits.
✓ Propose rules: 5 proposals.
✓ Confirm: you kept all 5.
✓ Apply and test: 2 commits; server-docs check tuned after 1 false alarm.
✓ Open the pull request: #15.
```

## Offer to keep it current (step 8)

Offer the
[Learn from past work](../../factory-setup/references/starters.md#learn-from-past-work)
starter, so recurring mistakes keep being recorded as findings the user can
act on. If the user agrees, set it up in Tessl directly, with no branch:
find the org and project as
[factory-setup's The project](../../factory-setup/SKILL.md#the-project) says,
check what the project already has as
[What is there already](../../factory-setup/references/set-up-in-tessl.md#what-is-there-already)
says, then turn it on as
[Learn from past work](../../factory-setup/references/set-up-in-tessl.md#learn-from-past-work)
says.
