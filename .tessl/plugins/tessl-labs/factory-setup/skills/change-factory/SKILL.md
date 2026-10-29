---
name: change-factory
description: Change or extend a Tessl factory that is already set up on this repository, and suggest what to add next. Use when someone wants to let a teammate start runs, change the model an automation uses, change what an automation does, change how Code Review behaves, stop or remove an automation, update the setup hook, change what the cloud environment can access, add another automation, set up Learn from past work so the factory learns from its mistakes, act on its findings, or asks what they should add to their factory.
---

# Change the factory

Make the change the person asks for to the factory on this repository, or
suggest what to add, and leave the factory working afterwards. Every change to
`tessl.json` goes through a branch and a pull request, and reaches the
automations only once it is on the default branch. Automations set up in Tessl
directly change at once, with commands.

## What done looks like

- The person agreed to the change in plain words before you made it.
- A change to `tessl.json` or the hook is on the default branch, or in an
  open pull request they can merge, and you gave them its link. A setting
  change, or a change to a Loop set up in Tessl, shows its new value in the
  matching `view` command.
- After a merge, the automations match the new `tessl.json`: you checked the
  Loops, as below.
- You told them what is now different, what it costs, and how to undo it.

## Invariants

1. Ask before each write: the branch push, the pull request, a Code Review
   setting, an environment change, setting up, pausing, deleting, or changing a
   Loop. Agreeing to one is not agreeing to the
   next.
2. Never set up an automation the project already has, in Tessl or in
   `tessl.json`.
3. Change only what the person named. Keep every other key in `tessl.json`,
   every other trigger, and every stored environment key as it is.
4. `tessl doctor --automations` reports the configuration valid before you
   push. When the setup hook changed, the cloud check, which runs on the
   pushed branch, has passed before the change is merged.
5. Before a change that costs more credits, such as reviewing every push or a
   larger model, say so.
6. Never print, ask for, or handle the value of a secret.

## The references you build on

The factory-setup skill's references hold the starters, trigger entries,
setup-hook guidance, cloud check, Loops check, and skill edits this skill
uses: [starters](../factory-setup/references/starters.md),
[triggers](../factory-setup/references/triggers.md),
[setup hook](../factory-setup/references/setup-hook.md),
[cloud check](../factory-setup/references/cloud-check.md),
[confirm the Loops](../factory-setup/references/confirm-loops.md),
[editing a factory skill](../factory-setup/references/customize.md), and
[setting up automations in Tessl](../factory-setup/references/set-up-in-tessl.md). A factory
set up with an older version keeps the trigger filters it was written with:
when one of its triggers lacks a filter that the triggers reference now has,
such as the repository ID or an open-state check, say so and offer to add it.

## 1. Read the factory

Do what `understand-factory` step 1 does: the linked project
(`tessl project repair --json`), the automations in `tessl.json`, and their
Loops (`tessl schedule list --project-id <project id> --all --json`). The
project's organization is `environment.attributes.orgId` in
`tessl environment view <environment> --json`, for any environment an action
names; pass it as `--org` to every `tessl code repo` command. Run
`tessl launch models --json` from the repository root, so it reads this
repository's workspace.

A change to `tessl.json` or the setup hook goes on a branch. Check
`git status` first. When the uncommitted changes are the person's own work,
ask them to commit or set them aside. When they are factory configuration the
person wants kept, such as a plugin they just installed, ask whether to
include them in this change. Find the default branch with
`gh repo view --json defaultBranchRef --jq .defaultBranchRef.name`, fetch it,
and start a new branch from it named for the change, such as
`tessl-allow-teammate`. A change to a setting (Code Review, the cloud
environment) needs no branch.

A Loop whose `attributes.definitionSource` is `app` was set up in Tessl, not in
`tessl.json`: "ship tickets", "answer reviews and fix checks", "follow ticket
changes", and Learn from past work usually are. Pausing, resuming or deleting
it is a command, as [Stop, pause, or change one later](../factory-setup/references/set-up-in-tessl.md#stop-pause-or-change-one-later)
says, and needs no branch. Any other change, its instructions included, needs
it moved into `tessl.json` first, as [Move a Loop into tessl.json](../factory-setup/references/set-up-in-tessl.md#move-a-loop-into-tessljson)
says, which opens a pull request; once it merges, change it like any other
`tessl.json` automation. Never edit a Loop set up in Tessl through the API.

## 2. Make the change

Say what will change and what the person gains or loses, and ask. Then:

- **Let someone else start runs.** On a Loop set up in Tessl there is no
  list to add them to: anyone who can add the label starts an issue, and
  anyone who is not a bot starts a round on Tessl's pull requests. Check the
  person's access as below, and tell the person what they can start. For a
  `tessl.json` automation, add their GitHub ID
  (`gh api users/<login> --jq .id`) to `event.sender.id` in every GitHub
  trigger that has one, as `{ "in": [<id>, <id>] }`, so every trigger lists
  the same people. `shepherd-pr-review-by-reviewer` names only the Tessl
  Reviewer bot, as `{{ github.tesslReviewerApp.userId }}`: leave it as it is,
  and never add the Reviewer to another trigger. The `shepherd-checks-*`
  triggers have no sender list, because checks start them. The
  `github-issue-labelled` trigger also has no sender list: any person, bot, or
  app that can apply the `tessl` label to an open issue can start Implement.
  Keep its label and open-issue conditions. Then check the person's access:
  `gh api repos/<owner>/<repo>/collaborators/<login>/permission --jq .role_name`.
  Adding a label needs `triage` or above, so with `read` they can comment on
  Tessl's pull requests but cannot start an issue; tell the person. Runs from
  Linear are started by anyone who can delegate to Tessl; nothing to change
  there.
- **Change the agent or model.** On a Loop set up in Tessl, move it into
  `tessl.json` first, as above. Use only a pair that
  `tessl launch models --json` lists; it spells `claude` as `claude-code`.
  Change `agent` and `model` on the named action. Removing `model` runs the
  listed `default` pair, which can be a different agent and a much smaller
  model: say which before you offer it.
- **Change Code Review.** These are settings, not `tessl.json`:
  `tessl code repo update <owner/repo> --org <org>` with `--review-trigger
  every-push|open-and-command` (every push re-reviews the agent's fixes and
  uses credits each time), `--review-publication enforcing|advisory`
  (whether a review can approve or request changes), `--review-auto-approve`
  (approve once its findings are resolved), or `--no-review-enabled` to turn
  it off. Confirm with `tessl code repo view <owner/repo> --org <org> --json`.
  Changing these needs an organization admin.
- **Stop or remove an automation.** On a Loop set up in Tessl, pause it
  (`tessl schedule pause <loop id>`, undone with `tessl schedule resume`) or
  delete it (`tessl schedule delete <loop id>`); ask which. For a `tessl.json`
  automation, remove its triggers, or its action and
  everything that names it, from `tessl.json`. That stops new runs once it is
  on the default branch; it does not cancel a run in progress. Do not use
  `tessl schedule pause` for these: a Loop defined in `tessl.json` is changed
  through the file. Before you ask, say what stops working, from that
  automation's section in `triggers.md` or `starters.md`. For "follow ticket
  changes": taking an issue back no longer cancels its run at once, closing an
  issue no longer closes its pull request, and a reply to Tessl's question no
  longer wakes the issue, so the person has to remove the label and add it
  again.
- **Update the setup hook** when the repository's tools or versions change.
  Edit `.tessl/cloud-launch-setup.sh` as `setup-hook.md` says, then run the
  cloud check from `cloud-check.md` on the branch before the merge.
- **Change what the cloud environment can access.** Run
  `tessl environment view <environment> --json` to see its access and key
  names. GitHub or Linear access:
  `tessl environment update <environment> --github-access <level>` or
  `--linear-access <level>`, which keeps every stored key. To add a key, send
  the person to the environment's page in the web app, which adds it to the
  others; never use `--env-file`, which replaces every stored key with the
  file's. Then check the key name appears in `environment view`.
- **Change what an automation does**, such as "run the linter before you push"
  or "never touch the migrations folder". Follow `customize.md`: a small
  change is an `instructions` string on the action, which keeps the published
  skill and its fixes; a larger one is a copy of the skill in the repository,
  which the person then owns. Say which, and that a copy stops getting fixes,
  before you start. Write a copy's change, or a new skill for an automation,
  with the `write-factory-skill` skill. On a Loop set up in Tessl, either one
  needs it moved into `tessl.json` first, as above. Ask whether the change also applies to other actions
  that do the same kind of work, such as the shepherd, which pushes fixes
  too.
- **Add another automation.** First check what the project already has, as
  [What is there already](../factory-setup/references/set-up-in-tessl.md#what-is-there-already)
  says, and never add one it has. "Ship tickets" (with "answer reviews and fix
  checks" and "follow ticket changes") and Learn from past work are set up in
  Tessl, as [setting up automations in Tessl](../factory-setup/references/set-up-in-tessl.md)
  says, with no branch. For any other, follow its starter in `starters.md` and its
  entries in `triggers.md`: create its environment when it needs its own, add
  its entries to `tessl.json`, create its label if it uses one. To show it
  working, wait until its Loop has appeared after the merge, then follow
  [testing the factory](../factory-setup/references/testing.md). Run a
  scheduled one only with `tessl schedule trigger <loop id>`: a run started
  with `tessl launch skill` belongs to no Loop, so Tessl refuses its findings
  and the run's work is lost. When you are done with this change, give the
  "Suggest what to add" list below a look for the person's next step.
- **Something else.** If no case above fits, say what you would change and
  why, and ask before you do it.

## 3. Check and publish the change

For a setting, or a Loop set up in Tessl, the command's own output and the
`view` or `tessl schedule list` after it are the check: skip to item 5. For a change on a branch:

1. Run `tessl doctor --automations`. Act on the Automation Configuration
   section only, and fix what it reports.
2. Show the diff, and say in one sentence what each change does.
3. Ask: "Do you want me to push this and open a pull request?" If yes, push
   and open it against the default branch, and give the link. Ask before you
   merge it; if the person declines, or the merge is refused, leave it for
   them.
4. Once it is merged, check the Loops as `confirm-loops.md` says: every
   action in the new `tessl.json` has its Loop with every trigger. For a
   removed action, check that its Loop is no longer listed; if it still is
   after 10 minutes, tell the person, with the Loops link, and do not say it
   is stopped.
5. Tell the person what is now different, what it costs, and how to undo it:
   revert the pull request, or for a setting, the same command with the old
   value.

## Suggest what to add

When the person asks what to add, or after you finish a change, show them
what else Tessl can do for this repository. Read the factory first, then the
last 7 days of runs from one `tessl launch list` pass, as `understand-factory`
step 2 does: enough to see patterns, without a lookup per run. Check each
feature in [features](references/features.md), and offer only the ones that
are off and that something in this repository points to, each in one or two
sentences: what it does, what this repository would get from it, and what it
costs. Leave out a feature with nothing behind it; offering none is fine.

1. Lead with a fix for anything the runs show is stuck or broken, because
   the person is waiting on it: pull requests stalled on canceled checks, a
   setup hook that keeps failing, teammates whose labels start nothing. `gh pr
   checks` shows a canceled check as `fail`; read the conclusion from
   `gh api repos/<owner>/<repo>/commits/<head sha>/check-runs`.
2. Then Learn from past work while it is off, and say which of its three
   automations this repository is ready for now. When it is on, its open
   findings instead, with an offer to act on one.
3. Then up to two more features the repository points to:
   - Code Review lenses, verifiers, or prepare-repo, when its reviews keep
     repeating the same kind of comment.
   - A scheduled job, when the person mentions a recurring chore or the
     repository shows one: a `CHANGELOG.md` updated by hand, tests that keep
     failing in CI. Offer it as a question, not a recommendation.
4. Then any gap in the factory itself:
   - **Answer reviews and fix checks**, when "ship tickets" is on without it.
   - **Code Review**, when it is off.
   - **Code Review that can approve**, when it is on in `advisory` mode and
     the default branch requires an approving review: in `enforcing` mode
     Tessl can approve its own pull requests once their findings are
     resolved. Check with
     `gh api repos/<owner>/<repo>/branches/<default branch>/protection` (a
     404 means the branch is not protected) and
     `gh api repos/<owner>/<repo>/rules/branches/<default branch>`.

Give the docs link from the features page where there is one. Ask which, if
any, they want, and make it as in step 2.
