# Starter automations

Offer the starters that fit how the user works. Describe each one by the job
it takes off their plate, not by its parts.

| Starter                                 | Fits                                      | Built from                  |
| --------------------------------------- | ----------------------------------------- | --------------------------- |
| Ship tickets                            | Any repo with GitHub issues or Linear     | `tessl-labs/factory` skills |
| Keep Tessl's pull requests moving       | Users who ship tickets                    | `tessl-labs/factory` skills |
| Review pull requests                    | Repos that use pull requests              | Tessl Code Review           |
| Triage new tickets                      | Any repo that files tickets               | Own skill                   |
| Review what lands on the default branch | Users who push straight to it             | Own skill                   |
| Scheduled job                           | Anyone, for example a weekly release plan | Own skill                   |

## Ship tickets

"When you add the `tessl` label to an issue, or delegate a Linear issue to
Tessl, an agent reads it, makes the change on its own branch, runs the tests,
and opens one pull request for you to review."

- Environment: `--github-access write`. For Linear, also
  `--linear-access write`, and follow [Linear prerequisites](linear.md).
- Entries: "Issue to PR" in [the triggers reference](triggers.md).
- Stop it: remove the label, or move the Linear issue out of Todo.

## Keep Tessl's pull requests moving

"On pull requests that Tessl opened, an agent answers review comments, fixes
failing checks, and tells you when the pull request is ready to merge."

- Only for pull requests that Tessl opened. Offer it with, or after, "ship
  tickets".
- Environment: `--github-access write`.
- Entries: "PR shepherding" in [the triggers reference](triggers.md).

## Review pull requests

"Tessl reviews every pull request and leaves findings as review comments."

- Follow "Installing on a repository" in the `code-review` skill. If that
  skill is not available, run `tessl install tessl/code-review` first.
- No `tessl.json` entries.

## Triage new tickets

"When a ticket is filed, an agent reads it and the code it touches. If the
ticket is small and clear, it adds the `tessl` label so Tessl ships it. If
not, it comments with what is unclear, or suggests how to split it."

- Pair it with "ship tickets" if the user wants clear tickets shipped
  without a person adding the label.
- Event: `github:issues.opened`, or `linear:Issue.create` for Linear.

## Review what lands on the default branch

"When work lands on your default branch, an agent reviews what changed since
the last run and files an issue for each real problem. Nothing waits on it,
so you keep shipping, and you check its issues before you tag a release."

- Event: a push to the default branch, if `tessl doctor --automations`
  accepts it. If not, run it on a schedule instead, for example each night.

## Scheduled job

"At a time you pick, an agent does one job, for example writes a release
plan from open issues, or checks for flaky tests."

- Use a `schedules` entry with `skill`, `cron`, `environment`, and
  `description`.

## Write your own automation

Use this for any starter whose "Built from" is "Own skill", and for any job
the user asks for that no starter covers.

1. Write the skill at `tessl-factory/skills/<name>/SKILL.md`. Say what the
   agent reads (`.cloud-launch/trigger-events.json` holds the events that
   started it), what it does, what it must not do, and when to stop. Keep it
   short, and show it to the user.
2. Add it to `tessl-factory/.tessl-plugin/plugin.json` as in
   [Editing a factory skill](customize.md).
3. Add an action with `"skill": "file:tessl-factory#<name>"` and the
   environment. Add a trigger with the event and a `when` filter, or a
   `schedules` entry. Follow the shape in [the triggers reference](triggers.md),
   including a `concurrency` key so one ticket or one commit starts one run.
4. Run `tessl doctor --automations`. If it rejects the event, tell the user
   and offer a schedule instead.
