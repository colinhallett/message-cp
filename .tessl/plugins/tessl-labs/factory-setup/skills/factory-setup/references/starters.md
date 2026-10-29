# Starter automations

Offer the starters that fit how the user works. Describe each one by the job
it takes off their plate, not by its parts.

| Starter                                 | Fits                                      | Built from                               |
| --------------------------------------- | ----------------------------------------- | ---------------------------------------- |
| Ship tickets                            | Any repo with GitHub issues or Linear     | `tessl-labs/factory` skills              |
| Answer reviews and fix checks           | Users who ship tickets                    | `tessl-labs/factory` skills              |
| Review pull requests                    | Repos that use pull requests              | Tessl Code Review                        |
| Review what lands on the default branch | Users who push straight to it             | Own skill                                |
| Learn from past work                    | Repos with merged pull requests           | `tessl-labs/learn-from-past-work` skills |
| Scheduled job                           | Anyone, for example a weekly release plan | Own skill                                |

## Ship tickets

"When you add the `tessl` label to an issue, or delegate a Linear issue to
Tessl, an agent reads it, makes the change on its own branch, runs the tests,
and opens one pull request for you to review."

- Set up in Tessl, with "answer reviews and fix checks" and "follow ticket
  changes", as [Set up automations in Tessl](set-up-in-tessl.md) says. For
  Linear, follow [Linear prerequisites](linear.md) first. "Follow ticket
  changes" cancels runs when a person takes an issue back, closes the pull
  request when an issue ends, wakes an issue when a person answers Tessl's
  question or its blocker ends, and cancels runs when a pull request closes.
- Stop it: pause or delete its Loop, "Implement ticket", with
  `tessl schedule pause <loop id>` or on the Loops page. That prevents new
  runs; it does not cancel one already in progress. When it is in
  `tessl.json` instead, remove its action and trigger, and the
  follow-ticket-changes action and triggers, and get that change onto the
  default branch.
- Stop one ticket: for GitHub, remove the `tessl` label. For Linear, remove
  Tessl delegation or move the issue to a state whose type is `backlog`,
  `triage`, `completed` or `canceled`; the agent checks the state type, not its
  name. A started state, such as Paused, does not stop it. A run already in
  progress may continue until it checks the ticket again.

## Answer reviews and fix checks

"On pull requests that Tessl opened, an agent answers review comments, fixes
failing checks, and tells you when the pull request is ready to merge."

- Only for pull requests that Tessl opened. Offer it when the user chooses
  "ship tickets", or later if they decline it.
- Set up in Tessl with "ship tickets", as
  [Set up automations in Tessl](set-up-in-tessl.md) says.
- Stop it: pause or delete its Loop, "Shepherd PR", with
  `tessl schedule pause <loop id>` or on the Loops page. When it is in
  `tessl.json` instead, remove the `shepherd` action and its triggers (five, or six
  with Code Review) and
  get that change onto the default branch. That stops new runs, not one
  already in progress. Removing the `tessl` label from a pull request does not
  stop the two triggers that start when a check finishes.

## Review pull requests

"Tessl reviews every pull request and leaves findings as review comments."

- When the Tessl Review app is not connected, or cannot see the repository,
  [check permissions](permissions.md), then give the user the `webUrl` from
  `tessl integrations show github-app-code-review --json` to install the app or
  grant it the repository, and wait until they say it is done.
- Turn review on with
  `tessl code repo update <owner/repo> --review-enabled --review-trigger every-push`,
  after any setup pull request has merged, so it is not reviewed, and confirm
  with `tessl code repo view <owner/repo> --json`. Leave `publicationMode` as
  it is. It needs an organization admin. If it refuses, say why and ask the
  user to turn review on under **Code reviews** in the web app.
- When review is already on, change none of its settings.
- No `tessl.json` entries, and nothing to install in the repository.

## Review what lands on the default branch

"When work lands on your default branch, an agent reviews what changed since
the last run and files an issue for each real problem. Nothing waits on it,
so you keep shipping, and you check its issues before you tag a release."

- Event: a push to the default branch, if `tessl doctor --automations`
  accepts it. If not, run it on a schedule instead, for example each night.

## Learn from past work

"Each week, agents read the review feedback on recently merged pull
requests, the transcripts of recent agent runs, and how Code Review's lenses
did, and record each mistake that keeps recurring as a finding on your Tessl
project, with the cheapest fix. They never change the repository; you choose
which findings to act on."

- Four Loops from `tessl-labs/learn-from-past-work`: Learn from review
  feedback reads pull request reviews; Learn from agent runs reads the runs
  that opened pull requests, so offer it once "ship tickets" is on; Tune Review Lenses
  reads how Code Review's lenses did and proposes lens changes, so offer it
  once Code Review is on; Turn findings into tickets files tickets for the
  factory from the findings worth doing, each starting an implementation
  run, so offer it once "ship tickets" is on and findings have been recorded.
- Set up in Tessl, as [Set up automations in Tessl](set-up-in-tessl.md#learn-from-past-work)
  says. Tessl creates the read-only environment Learn from agent runs uses;
  Turn findings into tickets runs with an environment the user chooses.
- Findings appear on the project's Findings page in the web app, and in
  `tessl finding list --project <linked project id>`.
- Try one only once its Loop exists, with `tessl schedule trigger <loop id>`;
  a run started another way cannot record findings.
- Stop it: pause or delete its Loops with `tessl schedule pause <loop id>` or
  on the Loops page. When they are in `tessl.json` instead, remove its entries
  from `schedules` and get that change onto the default branch. That stops
  new runs, not one in progress.

## Scheduled job

"At a time you pick, an agent does one job, for example writes a release
plan from open issues, or checks for flaky tests."

- Use a `schedules` entry with an `action` that holds the `skill` and
  `environment`, beside the entry's `cron` and `description`.

## Write your own automation

Use this for any starter whose "Built from" is "Own skill", and for any job
the user asks for that no starter covers.

1. Write the skill at `tessl-factory/skills/<name>/SKILL.md` with the
   `write-factory-skill` skill, and show it to the user.
2. Add it to `tessl-factory/.tessl-plugin/plugin.json` as in
   [Editing a factory skill](customize.md).
3. Add an action with `"skill": "file:tessl-factory#<name>"` and the
   environment. Add a trigger with the event and a `when` filter, following
   the shape in [the triggers reference](triggers.md), including a
   `concurrency` key so one ticket or one commit starts one run. For a
   schedule, add a `schedules` entry that names the action with
   `"action": "<name>"`.
4. Run `tessl doctor --automations`. If it rejects the event, tell the user
   and offer a schedule instead.
