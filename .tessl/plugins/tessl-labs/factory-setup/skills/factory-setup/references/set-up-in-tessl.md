# Set up automations in Tessl

"Ship tickets", "answer reviews and fix checks", "follow ticket changes", and
"Learn from past work" are set up in Tessl directly, the same way the web app
sets them up: no `tessl.json` entries, no pull request, and they are on as
soon as the call returns. Every other starter is set up in `tessl.json`.

Call these with `tessl api`, which uses the user's own login. `<project id>`
is `linkedProject.id` from `tessl project repair --json`; `<org id>` is the
organization preflight chose.

## What is there already

Before you set anything up, list the project's Loops:
`tessl schedule list --project-id <project id> --all --json`. Each entry's
`attributes.definitionSource` is `app` for a Loop set up in Tessl and `repo`
for one from `tessl.json`, and `attributes.label` is its name.

- Do not set up an automation the project already has, from either source.
  Say it is already on.
- When `tessl.json` already has the "ship tickets" or "answer reviews" actions
  (an action whose skill is `tessl-labs/factory#implement-github-issue`,
  `#implement-linear`, `#shepherd`, or `#follow-ticket-changes`), do not set up
  Ticket to PR in Tessl as well: Tessl would run both, and two agents would
  answer the same pull request. Keep the `tessl.json` ones, and say so.

## Ticket to PR

One call sets up all three automations together: "ship tickets" (Tessl's
name: Implement ticket), "answer reviews and fix checks" (Shepherd PR), and
"follow ticket changes".

1. Check the Tessl App can reach the repository:
   `tessl api /experimental/projects/<project id>/factory/helper-access`.
   `data.attributes.status` is `accessible` or `missing`. When it is
   `missing`, give the user the GitHub App links as "The Tessl App" in preflight does,
   wait until they say it is done, and check again.
2. Read the plan:
   `tessl api '/experimental/projects/<project id>/factory/ticket-to-pr?issueSource=github&label=tessl'`
   for GitHub issues, or `?issueSource=linear` for Linear. Each entry in
   `data.attributes.loops` is one automation, with its triggers, and an
   `existingLoopId` when the project already has it; `data.attributes.issueSource`
   is the source setup will use.
3. What it creates, for the person: three automations, each with its own
   cloud environment that Tessl creates (`factory-<workspace>-<project>-<stage>`,
   with GitHub write access, and Linear access for Linear). Anyone who can add
   the label to an issue can start one, which on GitHub needs triage access,
   and on Tessl's pull requests so can review comments from anyone who is not
   a bot; on a public repository say that this is anyone who can comment. The
   model, the environment and what starts each one cannot be changed on these
   automations; the `change-factory` skill can move one into `tessl.json` for
   that.
4. Set it up. Write the body to a file and send it:
   `{"issueSource": {"type": "github", "label": "tessl"}}`, or
   `{"issueSource": {"type": "linear"}}`, then
   `tessl api -X POST /experimental/projects/<project id>/factory/ticket-to-pr --input <file>`.
   It creates the label if it is missing. The answer's
   `data.attributes.loops` lists each automation's `stage`, Loop `id`, and
   whether it was `created` or was already there. Calling it again is safe.
5. Check the three Loops are listed in
   `tessl schedule list --project-id <project id> --all --json`, active.

When it refuses:

- "Connect the Tessl App to this repository": step 1 failed; fix the access
  and try again.
- Missing organization permission: the first setup creates the environments,
  which needs `environment.write` on the organization. [Check
  permissions](permissions.md) and ask for exactly that.
- Linear: it needs the Linear connection and a team routed to the project;
  follow [Linear prerequisites](linear.md).
- Anything else: show the `message` it returns, in plain words, and stop.

## The first ticket

Offer open issues and a starter issue you propose from the checked-out repository.

- **Open issues**
  - GitHub: `tessl api /experimental/projects/<project id>/factory/implement/github-issues`
    lists them (`number`, `title`, `url`). Offer the first five by title, as the
    web does. Give one to Tessl with
    `tessl api -X POST /experimental/projects/<project id>/factory/implement/github-issues/<number>/label`.
  - Linear: `tessl api /experimental/projects/<project id>/factory/implement/issues`
    lists them (`identifier`, `title`, `url`, `state`); offer the first five.
    Delegate one with `tessl api -X POST /experimental/projects/<project id>/factory/implement/delegate --input delegate.json`
    and `{"issueId": "<the entry's id>"}` in `delegate.json`.
- **Suggested issue:** read the checked-out repository's agent instructions,
  source, tests, documentation and CI configuration. Find one concrete,
  useful change small enough for a first pull request, supported by what you
  actually read. Check the open issues above to avoid duplicating one.
  - Draft a specific `title` and a complete `body` with the problem, evidence
    and relevant file paths, the intended change, scope limits, acceptance
    criteria and how to validate it. Do not invent a problem or use a generic
    documentation task as a fallback.
  - Keep the draft's title and body together. Offer its title, why it helps
    and the repository evidence; let the person read the full body before
    choosing.
  - If the checkout is unavailable or gives too little evidence for a useful
    suggestion, say so. The choices are an open issue, a task the person
    writes, or nothing. Never substitute a generic ticket.
- **A task the person writes:** ask for the title and the description.

Nothing is created, labelled or delegated until the person chooses. File a
chosen suggestion with its exact `title` and complete `body`, unchanged.

When you have the tracker's own tools, file it as the person: for GitHub
issues, `gh` logged in, follow [create-github-issue](../../create-github-issue/SKILL.md);
for Linear, a Linear MCP server or the person's `LINEAR_API_KEY`, follow
[create-linear-issue](../../create-linear-issue/SKILL.md). The person then owns
the issue. Without them, file it through Tessl as below, and say the issue is
filed by Tessl's app rather than by them. Write
the request to a `.json` file from the selected draft, without rewriting or
shortening the body:
`{"title": …, "body": …}` for GitHub, sent with
`tessl api -X POST /experimental/projects/<project id>/factory/implement/github-issues --input issue.json`,
or `{"teamId": "<routed team id>", "title": …, "description": <the body>}` for
Linear, sent to `…/implement/issues` the same way. Choosing a different
suggestion replaces the title and body together. If the person edits the
title, keep the body only when they confirm it still fits; a task they write
never reuses a suggestion's body.

## Learn from past work

`tessl api -X POST /v1/orgs/<org id>/projects/<project id>/loops/learn-from-past-work --input <file>`
with a body naming the automations the user chose:

```json
{
  "loops": {
    "learn-from-review-feedback": {
      "cadence": "weekly",
      "additionalContext": ""
    },
    "learn-from-agent-runs": { "cadence": "weekly", "additionalContext": "" },
    "tune-review-lenses": { "cadence": "weekly", "additionalContext": "" },
    "turn-findings-into-tickets": {
      "cadence": "weekly",
      "additionalContext": "",
      "environment": { "id": "<environment id>" }
    }
  }
}
```

Turn findings into tickets files tickets, so it needs an environment that can
write a GitHub or Linear issue. Read the choices first with
`tessl api /v1/orgs/<org id>/projects/<project id>/loops/learn-from-past-work`:
`data.attributes.ticketEnvironments` lists the project's environments with that
access, the Loops that use each, whether the user may create one, and a
`suggested` choice. Offer the suggestion, usually the environment "ship
tickets" takes tickets with, and send `{ "id": "<environment id>" }` or
`{ "create": true }`. Creating one makes an organization environment with
GitHub write access, plus Linear write access when Linear is connected, and
needs an organization admin.

Each entry in the answer's `data.attributes.loops` has an `outcome`:
`created`, `already-set-up`, or `refused` with a `reason`. A refused one does
not stop the others: tell the user each refusal's reason. Tessl creates the
read-only environment Learn from agent runs uses. All run weekly. Name each
Loop's schedule from `tessl schedule list` when you tell the user.

## Stop, pause, or change one later

- Pause or resume one: `tessl schedule pause <loop id>` and
  `tessl schedule resume <loop id>`.
- Remove one: `tessl schedule delete <loop id>`. To set it up again later,
  call the route again.
- Any other change, such as instructions like "run the linter before you
  push", the model, the environment, or who can start it: move the Loop into
  `tessl.json`, then change it there. Never edit a Loop set up in Tessl through
  the API.

## Move a Loop into tessl.json

The move opens a pull request on the repository, so ask the person first and
name each Loop it moves. It moves one Loop: move only the ones the change
needs.

1. `tessl api -X POST /experimental/schedules/<loop id>/move-to-repo`, with the
   Loop's id from `tessl schedule list`. `data.attributes.pullRequestUrl` is
   the pull request that adds the Loop to `tessl.json`, creating the file when
   there is none. Give the person its link and every entry in
   `data.attributes.warnings`. When a move is already open, the same call
   returns that pull request.
2. The person can do the same with **Move to tessl.json** on the Loop's page,
   from the project's Loops page.
3. A refusal about the Tessl App means it cannot reach the repository: get it
   there as [factory-setup](../SKILL.md#the-tessl-app) says.
4. Once the pull request merges, Tessl replaces the Loop with the one
   `tessl.json` declares, keeping its runs. Change it there, through a branch
   and a pull request.

None of these cancels a run already in progress.
