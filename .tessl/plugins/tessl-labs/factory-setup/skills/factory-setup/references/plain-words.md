# Plain words

For the agent; never shown or sent to the person. Say the plain word. When a
link, screen or command output puts a Tessl term in front of the person, say
what it means in one line, once, at that point, and only when it bears on what
they do next. Do not define a term the person will not meet.

## Names on screens

- **Implement ticket, Shepherd PR, Follow ticket changes:** the Loops page's
  names for ship tickets, answer reviews and fix checks, and follow ticket
  changes.
- **Agent Retro, Review Development Patterns:** older names on the Loops page
  for Learn from agent runs and Learn from review feedback.
- **Tessl Verify check:** the check on a pull request that reports what the
  verifiers found.
- **run label,** such as `issue-labelled #5 @ada`: what started the run, the
  issue or pull request, and who acted.
- **clone, manifest-sync, skill-install, cloud-launch-setup:** the steps before
  the agent starts: get the repository, sync its config, install the skill,
  run the setup script. A run can fail at any of them.
- **Closes #N,** in a pull request Tessl opened: tells GitHub to close issue N
  when it merges.
- **#N:** pull request or issue number N in this repository.

## Tessl words

- **automation:** one rule: when this happens, an agent does this job. Tessl
  shows it as a Loop.
- **project:** the repository's home in Tessl, where its automations and runs
  live.
- **the Tessl App:** the GitHub App that lets agents write to the repository,
  also shown as `github-app-agent`.
- **Tessl Reviewer:** the GitHub App that runs Code Review, also shown as
  `github-app-code-review`.
- **cloud environment:** the machine and access the agent gets in Tessl's
  cloud; Tessl makes one per automation.
- **answer reviews and fix checks:** on Tessl's pull requests, an agent
  answers review comments and fixes failing checks (shepherd).
- **shepherd round:** one pass over a pull request after a review or a check
  result.
- **issue source:** where tickets come from, GitHub issues or Linear.
- **the `tessl` label:** the GitHub label that starts a run; Tessl creates it,
  and adding it needs triage access to the repository.
- **cloud check:** one cloud run that runs the setup script to prove it works
  before it merges; it uses credits.
- **finding:** one recorded problem that keeps coming back, with its evidence
  and the fix to make.
- **lens:** a set of review rules Code Review applies to the paths it covers.
- **review profile:** `.tessl-code-review.yml`, which says which lenses review
  which paths.
- **verifier:** a pass-or-fail rule the repository keeps, judged by a model on
  the files it covers; agents run it before they push, and it reports on pull
  requests once verification is turned on for the repository.
- **`tessl.json`:** the file in the repository that holds Tessl's
  configuration.

## Skills and plugins

- **prepare-repo:** the skill that reads review history and CI failures and
  proposes agent context, checks and review rules.
- **understand-factory:** the skill that explains what the factory did and why
  a run failed.
- **change-factory:** the skill that changes or extends the factory.
- **`tessl-labs/factory`:** the published skills the automations run.
- **`tessl-labs/learn-from-past-work`:** the published skills Learn from past
  work runs.
- **`tessl/code-review`, `tessl/tessl-verify`:** plugins installed to the
  person's account, not the repository, to write review rules and checks.
- **`tessl-factory/`:** the repository's own copy of a skill, which no longer
  gets Tessl's fixes.
- **`@tessl-code-review`:** a comment that is only this handle asks Code
  Review to review the pull request again.
