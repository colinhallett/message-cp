---
name: factory-setup
description: >-
  Set up a Tessl factory on a repository: Tessl agents that turn tickets into
  pull requests, answer reviews and fix checks on them, and review every pull
  request. Use when someone wants Tessl agents to do work in their repo, or
  asks what a factory is. To explain or change a factory that exists, use the
  understand-factory and change-factory skills.
---

# Factory setup

A factory is a set of automations on a repository. Each one is a rule: when
something happens (a ticket is handed to Tessl, a pull request gets a review),
a Tessl agent runs in the cloud and does one job.

Your job is to set up the same factory the Tessl web app sets up, without
asking the person to make choices, then offer the extras only an agent that
can read the repository can recommend.

## What done looks like

Setup is done when the repository has a Tessl project; Ticket to PR is on;
Code Review is on, or the person chose not to install its app; the person has
had the "Your factory is live." message, the first-ticket offer and the
suggested next steps; and every step they accepted is done.

Read where things stand, take the first situation that applies, do its next
action, and look again.

1. **The person asked what a factory is, what theirs does, or to change it.**
   Explain in a few sentences, or use
   [understand-factory](../understand-factory/SKILL.md) or
   [change-factory](../change-factory/SKILL.md). Set nothing up.
2. **The CLI is obsolete or not logged in.** For an obsolete CLI follow
   [Check the Tessl CLI](references/cli-version.md). When `tessl whoami`
   fails, ask the person to run `tessl login` and wait. A newer CLI build is
   not a reason to stop: mention `tessl cli update` once in the live message.
3. **The folder is not a GitHub repository.** Say automations run on a GitHub
   repository and ask which one to use.
4. **No project for this repository, or you do not know its org.**
   [Find or create it](#the-project).
5. **The Tessl App cannot reach the repository.** [Get it there](#the-tessl-app).
6. **Ticket to PR is not on.** [Turn it on](#ticket-to-pr).
7. **Code Review is not on, and the person has not said to skip it.**
   [Turn it on](#code-review).
8. **The live message has not been sent.** [Send it](#its-live).
9. **The first ticket has not been offered.** [Offer it](#the-first-ticket).
10. **The suggested next steps have not been sent.**
    [Send them](#suggested-next-steps).
11. **The person accepted a next step that is not done.** Do it, as its
    step says.

If what you find fits none of these, say what you found and ask.

## Invariants

### Talking to the person

1. Ask nothing that a default answers. The only things to ask for are what
   only the person can do (log in, install an app), which org or workspace
   when the rules below leave more than one, the first ticket, and which
   suggested next steps to take.
2. Use plain words; see [Plain words](#plain-words). Never show a generated
   identifier, such as a workspace name that starts with `ws-`; with one
   workspace, say "your Tessl workspace".
3. Give a browser link whenever you create or check something the person may
   want to see, from the command's `webUrl` ([Browser links](references/links.md)),
   as a plain URL. Add `onboarding=true` to every link on the Tessl web app's
   host: `?onboarding=true`, or `&onboarding=true` when the link already has a
   query. Links to other sites, such as GitHub, stay as they are.
4. Say what you have checked and what you have not. Never say the factory is
   running until its Loops are listed, or that a run worked until you have
   seen what it did.
5. After a side request, answer it, then go back to the situation you were
   on.

### Changes

6. Change nothing in the repository before the factory is live: no
   `tessl init`, no `tessl.json`, no commit. Afterwards, change it only for an
   extra the person accepted, and ask before each push and merge.
7. Never set up an automation the project already has
   ([What is there already](references/set-up-in-tessl.md#what-is-there-already)),
   and never change a Code Review setting on a repository whose review is
   already on.
8. When a command is refused, by the agent's permission system or by GitHub,
   do not retry or work around it: ask the person to run it.
9. Every command acts on the org and workspace this setup chose: pass
   `--org <org id>` to `tessl code repo` and `--workspace <workspace>` to
   `tessl integrations show`, so neither falls back to a local or default
   one.

## Environment facts

- Ticket to PR is three automations set up in Tessl in one call: "ship
  tickets" (Implement ticket), "answer reviews and fix checks" (Shepherd PR)
  and "follow ticket changes". They are on as soon as the call returns, with
  cloud environments Tessl creates. [Set up automations in
  Tessl](references/set-up-in-tessl.md) has the calls.
- A run starts about 90 seconds after the event and uses Tessl credits.
  `tessl org list --json` gives each org's `credits.state` and
  `credits.remaining`.
- Two GitHub Apps: the Tessl App lets agents comment, push branches and open
  pull requests; Tessl Review runs Code Review.
- `tessl api <path>` calls the Tessl API with the person's login; send a body
  with `--input <file>`.
- `gh repo view --json nameWithOwner,isFork,parent,visibility` gives the
  repository. A fork gets its own factory, not its parent's.

## Judgment

- While you set up, read the repository for the first ticket and suggested
  next steps: package manifests, lockfiles and CI install steps (what a cloud run needs to build
  and test), the services its tests need, its agent context (`AGENTS.md`,
  `CLAUDE.md`), and its review history. Use what you find when offering the
  first ticket, and save the other recommendations for the suggested next steps.
- A person who wants something other than Ticket to PR, such as a schedule or
  a trigger of their own, gets the factory first, then
  [change-factory](../change-factory/SKILL.md) for the rest.

## The project

1. **The org.** From `tessl org list --json`: the only one; otherwise the one
   that already has a project for this repository; otherwise the one whose
   Tessl App can see the repository
   (`/v1/orgs/<org id>/integrations`, then
   `/v1/orgs/<org id>/integrations/<integration id>/repositories?scope=account&q=<repo>`);
   otherwise ask which, by name. When its `credits.state` is not `ok`, say
   once that runs will not start until it has credits, and carry on.
2. **The project.** List the org's projects with
   `tessl api '/v1/orgs/<org id>/projects?filter[q]=<owner>/<repo>'` and take
   the one whose `sourceUri` is `https://github.com/<owner>/<repo>` and whose
   `repoSubpath` is empty. `filter[q]` also matches names and other
   repositories, so match those two fields yourself.
3. **Otherwise create it** in the org's workspace
   (`tessl api /v1/orgs/<org id>/workspaces`: the only one, or the one the
   person names) with `tessl api -X POST /v1/projects --input <file>` and
   `{"workspaceId": "<workspace id>", "name": "<repo>", "sourceType": "git",
   "sourceUri": "https://github.com/<owner>/<repo>", "repoSubpath": ""}`. When
   the name is taken, add `-2`, `-3` and so on.
4. Keep the project's id and give the person its link: the web app's
   `/go/projects/<project id>`, on the host the other commands' `webUrl`
   values use (such as `https://tessl.io`). The create call returns no link. A refusal
   about permissions: [check permissions](references/permissions.md) and ask
   for exactly what is missing.

## The Tessl App

`tessl api /experimental/projects/<project id>/factory/helper-access` gives
`data.attributes.status`: `accessible` or `missing`. When it is `missing`,
give one link from `tessl integrations show github-app-agent --json`, as
[Browser links](references/links.md) says, and say it asks for read and write
access so agents can comment, push branches and open pull requests. Wait until
the person says it is done, then go on to Ticket to PR: this check keeps
answering `missing` for up to five minutes after access is granted, and the
Ticket to PR call refuses with "Connect the Tessl App to this repository" while
access is really missing. When it refuses, say the access can take a few
minutes to show, and try again.

## Ticket to PR

Turn it on as [Ticket to PR](references/set-up-in-tessl.md#ticket-to-pr) says. The
issue source is Linear when the Linear connection has a team routed to this
project ([Linear prerequisites](references/linear.md)); otherwise GitHub
issues with the `tessl` label. Do not ask. When the project already has an
implement automation, the call keeps its source. Confirm the three Loops are
listed and active.

## Code Review

`tessl code repo view <owner/repo> --json`. When `repository.review.enabled`
is true, leave every setting as it is. Otherwise, when the Tessl Review app
cannot see the repository, give the `webUrl` from
`tessl integrations show github-app-code-review --json`, say it reviews every
pull request, including Tessl's, and that the person can say to skip it; wait
until they say it is done or to skip. Then turn it on to review every push:
`tessl code repo update <owner/repo> --review-enabled --review-trigger every-push`,
and confirm with `tessl code repo view`. A refusal needs an organization
admin; say so and carry on without it.

## It's live

One message that starts "Your factory is live.":

- What is on, what starts each, and the project's Loops link (the project
  link with `/loops` added), using the issue source the Ticket to PR plan
  reported (`issueSource`), which is an existing automation's when the
  project had one: "Add the `<label>` label to an issue and Tessl opens a pull
  request for it", or for Linear, "Delegate an issue to Tessl".
- How to stop each: removing that label or taking the issue back stops one
  ticket; pausing a Loop on that page stops it for every ticket.
- The org's remaining credits, from `credits.remaining`.
- That their agent can later explain what the factory did
  ([understand-factory](../understand-factory/SKILL.md)) or change it
  ([change-factory](../change-factory/SKILL.md)).

## The first ticket

Offer it as [The first ticket](references/set-up-in-tessl.md#the-first-ticket)
says: a few of the open issues the web would offer, and a useful starter issue
you propose from the checked-out repository.
Giving Tessl a ticket starts a run that uses credits, so this is the one choice
in setup; when the person declines, say how to give it one later and go on.
When they pick one, follow its run as [Testing the
factory](references/testing.md) says, and send the suggested next steps while
it runs. Report only what you saw: the run starting, its pull request, or what
stopped it.

## Suggested next steps

One message under the heading "Suggested next steps". Open with one line: the
factory is doing its job, and these steps make it better at this repository.
Then at most three steps as peers, each ending with what it gains the person,
not with a caveat. Learn from past work always comes first; suggest the others
only when the evidence from the repository supports them, and give that
evidence:

- **Learn from past work:** each week Tessl reads the factory's runs and the
  pull requests' reviews, records the problems that keep coming back as
  findings, and turns them into tickets the factory builds. If accepted, turn
  on all four Loops with the suggested environment for tickets, as [Learn from
  past work](references/set-up-in-tessl.md#learn-from-past-work) says.
- **A setup script for cloud runs,** when building or testing needs tools,
  dependencies or services, such as a lockfile to install from or a database
  the tests use. Name what you found and what `.tessl/cloud-launch-setup.sh`
  would install, so the next run builds and tests like CI does. If accepted,
  write it as [the setup hook reference](references/setup-hook.md) says, on a branch with a pull request,
  check it on a cloud machine before the merge as [Check the setup hook in the
  cloud](references/cloud-check.md) says, never by running it here, and ask
  before pushing and merging.
- **prepare-repo,** when agent context is thin or missing: it reads the
  repository's review history, CI failures and fix commits, and turns what it
  finds into agent context, checks and review rules, so the next pull request
  starts from what the first one had to work out
  ([prepare-repo](../prepare-repo/SKILL.md)). It changes nothing until the
  person picks what to keep.
- **Code Review,** when it ended up off: say that Tessl did not review the
  pull request it opened, because review is off for this repository, and that
  with it on every pull request gets findings and the agent answering reviews
  fixes them. Say nothing about whether anyone else reviewed it. Turn it on as
  [Code Review](#code-review) says, or point to **Code reviews** in the web
  app when that was refused.

End with one question that assumes a start: which step to begin with, and
which one you would begin with now. Do not call the steps optional, and do
not offer "none"; a person who wants to stop says so, and then leave it. Add
one line on what else they can ask for later, such as other automations from
[the starters](references/starters.md).

## Plain words

Say the plain words. If a command or screen shows the Tessl term, say what it
means in one line.

- **automation:** a Loop, trigger or action.
- **the Tessl App:** the GitHub App that lets agents write to the repository,
  also shown as `github-app-agent`.
- **cloud environment:** the machine and access the agent gets in Tessl's
  cloud.
- **answer reviews and fix checks:** on Tessl's pull requests, an agent
  answers review comments and fixes failing checks (shepherd).
