---
name: factory-setup
description: >-
  Set up, explain, or change a Tessl factory on a repository: agents that act
  on events in the repo, such as triaging new tickets, shipping tickets as
  pull requests, keeping pull requests moving, reviewing code, or running a
  job on a schedule. Use when someone wants Tessl agents to do work in their
  repo, asks what a factory is or what theirs does, or wants to add to,
  change, or customize it.
---

# Factory setup

A factory is a set of automations on a repository. Each one is a rule: when
something happens (a ticket is filed, a pull request gets a review, a time of
day arrives), a Tessl agent runs a skill in the cloud and does one job.

Your job is to help the user pick the first automation that is useful to
them, set it up safely, show it working, and then help them see what else
they could add. Fit the factory to how the user works. Do not assume they use
pull requests, Linear, or any other tool until you have checked.

Rules for the whole session:

- Ask about one thing at a time.
- Use plain words. See [Plain words](#plain-words).
- Change nothing in the repository, the Tessl workspace, or GitHub until the
  user has said yes in step 1.
- Pass `--workspace <workspace>` to every `tessl` command that takes it. `gh`
  and `git` commands do not take it.

## 1. Orient the user

Before you run anything that changes state, tell the user in a few short
sentences:

1. What a factory is (the paragraph at the top, in your own words).
2. Three or four examples from [the starter automations](references/starters.md)
   that could fit this kind of repository.
3. What setup will create: a Tessl project linked to the repo, one cloud
   environment for the agents, the Tessl GitHub App on this repo, a few
   entries in `tessl.json`, and maybe a label.
4. That runs use Tessl credits, and that a first test run costs a few hundred
   credits.
5. That every automation can be turned off by removing it from `tessl.json`.

Then ask: "Do you want to go ahead?" Stop if they say no.

## 2. Preflight

1. Work from the repository root. If there is no `tessl.json`, tell the user to
   run `tessl init` and stop.
2. Run `git status`. If there are uncommitted changes, say so and ask the user
   to commit them or put them aside before you continue. Do not move or stash
   them yourself.
3. Run `tessl whoami`. If it fails, ask the user to run `tessl login`.
4. Run `tessl project repair --json`. The workspace is
   `linkedProject.workspaceName`. If there is no linked project, ask which
   workspace to use, then run `tessl project link --workspace <workspace>`, or
   `tessl project create --workspace <workspace>` if no project matches.
5. Run `tessl org list --json`. If the organization's `credits.state` is not
   `ok`, tell the user that factory runs will not start until the
   organization has credits, and ask whether to continue.
6. Find the GitHub repo (`gh repo view --json nameWithOwner`). Check that the
   Tessl GitHub App can write to it: `tessl integrations show github-app-agent`
   and `tessl github token --repo <owner/repo>`. If either fails, ask the user
   to install the Tessl GitHub App on the repo from workspace settings. Say
   that it asks for read and write access so agents can comment, push
   branches, and open pull requests. Wait until they say it is done.

## 3. Learn how the user works

Read before you ask:

- `CLAUDE.md`, `AGENTS.md`, and `CONTRIBUTING.md`, for rules about branches,
  pull requests, and releases.
- `git log --first-parent -30 <default branch>`. Merge commits mean work
  arrives through pull requests. Plain commits mean people push to the
  default branch.
- `gh pr list --state merged --limit 10` and
  `gh api repos/<owner>/<repo>/rules/branches/<default branch>`.
- Where tickets live: open GitHub issues (`gh issue list --limit 5`), or a
  Linear connection (`tessl integrations show linear --json`).
- CI: the files in `.github/workflows/`.

Tell the user what you found in two or three sentences, for example "You push
straight to main, file GitHub issues, and have no CI." Ask them to correct
it. Then ask: "Is there one thing you want Tessl to take off your plate
first?"

## 4. Show the current factory

Read `tessl.json`. Find the `actions`, `triggers`, and `schedules`, and the
environments they use (`tessl environment view <env>`). Check Code Review with
`tessl integrations show github-app-code-review`.

If nothing is set up, say so and go to step 5.

If something is set up, tell the user in plain words which automations are
on, what starts each one, and which skills are their own copies. Then
suggest one or two automations from [the starters](references/starters.md)
that fit what they already have and how they work, and say what each would
save them. For example: "Tessl already ships your labelled issues. A triage
automation could read each new issue and add the label when the issue is
small and clear." Ask what they want to do: add an automation, remove one,
change what starts one, or [edit a skill](references/customize.md).

## 5. Pick the first automation

Set up one automation first. Add more once it works.

- If the user named a goal in step 3, set up the starter that meets it.
- If not, offer two or three starters from [the starters](references/starters.md)
  that fit how they work, each in one sentence, with your recommendation
  first.
- If they push straight to the default branch, do not offer automations that
  need a pull request on every change. Offer the ones that work without pull
  requests, and say that "ship tickets" opens one pull request per ticket.
- If they want something no starter covers, follow
  [Write your own automation](references/starters.md#write-your-own-automation).

Before you build it, say what it does in plain words: what starts it, what
the agent does, what it changes, and how to stop it. Ask: "Is this what you
want?"

## 6. Create the environment

Use one environment named `<repo>-factory`. If it exists, show its access and
ask before you change it. If not, create it with the access that the chosen
starter lists:

`tessl environment create <repo>-factory <flags>`, then confirm it with
`tessl environment view <repo>-factory`.

If `tessl environment create --help` has no flag that the starter needs, ask
the user to create the environment in the web app, under workspace settings,
Environments, with that access.

## 7. Write tessl.json

1. Pick where the change goes:
   - If the user works through pull requests, create a branch named
     `setup-tessl-factory` from the default branch and make every file change
     on it.
   - If the user pushes straight to the default branch, ask whether to commit
     there or use a `setup-tessl-factory` branch.
2. Add the entries that the starter lists. Keep every other key in the file.
3. If the starter uses a label, create it if it is missing, for example
   `gh label create tessl`.
4. If the starter works on pull requests, check the branch rules from step 3,
   auto-merge, and "dismiss approvals on push". Tell the user how each one
   changes what the automation does. Change nothing without asking.
5. Run `tessl doctor --automations`. Fix what it reports. Tell the user what
   each warning means for them, not what it says. For example, "event
   delivery not confirmed" means "Tessl has not received a GitHub event from
   this repo yet. This is normal until the change is on the default branch."
6. Show the user the diff and say in one sentence what each entry does.

## 8. Go live and show it working

1. Ask: "Do you want me to push this?" If yes, push the commit, or commit on
   `setup-tessl-factory` and open a pull request. The automations start only
   once `tessl.json` is on the default branch.
2. When it is on the default branch, send the user to the project's Loops tab
   in the Tessl web app. Say which loops they will see and what starts each.
3. Ask: "Do you want me to show you it working?" If yes, follow
   [Testing the factory](references/testing.md).

## 9. Recap and suggest what is next

Tell the user:

- Which automations are on, what starts each one, and the link to its loop.
- How to stop one: remove it from `tessl.json`, or remove the label from a
  ticket.
- One or two automations from [the starters](references/starters.md) that
  would fit next, and what each would save them. Ask if they want to add one
  now.

## Plain words

Say the plain words. If a command or screen shows the Tessl term, say what it
means in one line.

| Plain words                                                                           | Tessl term            |
| ------------------------------------------------------------------------------------- | --------------------- |
| automation                                                                            | loop, trigger, action |
| cloud environment: the machine and access the agent gets                              | environment           |
| check the setup                                                                       | `tessl doctor`        |
| review rules: what Code Review looks for                                              | lens                  |
| keep pull requests moving: answer review comments, fix failing checks                 | shepherd              |
| wait time: Tessl waits about 90 seconds after an event, so quick events start one run | debounce              |
