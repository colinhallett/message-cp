---
name: tune-review-lenses
description: >-
  Weekly look at how this repository's Tessl Code Review lenses are doing:
  read the review statistics and the findings authors declined or refuted,
  read the pull requests behind them and the bugs that got past review, and
  write Tessl findings that propose specific changes to the lenses in
  review-lenses/. Writes findings only; changes no file and opens no pull
  request. The findings-triage loop decides what happens to them.
---

# Tune the review lenses

This repository reviews its pull requests with the lenses in `review-lenses/`,
routed by `.tessl-code-review.yml`. A lens that keeps raising findings authors
decline, or that misses a kind of bug that later needs a fix, costs review
rounds and trust. Your job is to find such patterns in the evidence and turn
each into a Tessl finding with a concrete proposed change to a lens. You never
edit a lens yourself: you change no file, push nothing and open no pull request.
The findings-triage loop reads your findings like any other, and lens changes
are the owner's to approve.

## What you can read

- The project and organization ids are in your instructions. Without them,
  the project id is `linkedProject.id` from `tessl project repair --json`.
- **Counts per lens, from GitHub.** Tessl's organisation-level review
  statistics (`/v1/orgs/<org>/code-reviews` and `.../code-reviews/runs`) are
  refused inside a factory run, which has no organisation role, so count from
  the pull requests instead. Every inline comment the reviewer posts carries
  hidden markers: `<!-- tessl-code-review:lenses:v1 refs=<url-encoded lens
  refs, comma separated> -->` names the lenses behind a finding,
  `<!-- tessl-code-review:finding:v1 id=<finding id> -->` its id, and a later
  reply's `<!-- tessl-code-review:reconciliation:v1 id=<finding id>
  category=<addressed|refuted|declined> -->` how it was settled. For the
  pull requests merged or updated in your window (`gh pr list --state all
  --search "updated:>=<date>" --json number`), read `gh api
  repos/<owner>/<repo>/pulls/<n>/comments --paginate` and count, per lens:
  findings raised, and how many were addressed, declined, refuted or are still
  open. The severity is in the comment's first bold line. If an
  organisation-level call does work for you, use it as a cross-check, not a
  replacement.
- Findings authors settled as refuted or declined, newest first, with the lens
  refs that raised each, its severity, path and line, and the note that settled
  it: `tessl api "/experimental/projects/<project>/code-review-settled-findings?page%5Bsize%5D=100&filter%5Bsince%5D=<ISO date>"`
  (page with `page%5Bnumber%5D`).
- The pull request threads behind them: `gh api
  repos/<owner>/<repo>/pulls/<n>/comments` and `.../reviews`, and `gh pr view
  <n> --comments`. The author's reply to a finding says why it was declined.
- What got past review: commits and pull requests on `main` that fix
  something an earlier merged pull request broke (`git log`, PR titles and
  descriptions naming an earlier PR, `prod-check` issues in Linear if you can
  read it).
- The lenses themselves, `.tessl-code-review.yml`, `AGENTS.md` (its "Design
  constraints" state the scale and rules this project has already decided)
  and `DIRECTION.md`.
- Findings: `tessl finding list --project <project> --state <state> --json
  --limit 100` for each of `open`, `in-progress`, `resolved` and `ignored`.

Write every `tessl api` path with its query string URL-encoded as above. If a
call fails, say which in your output and carry on with what you have.

## What counts as a pattern

Look back 14 days, or to the newest finding you wrote before if that is more
recent (your findings carry the tag `code-review-lens`).

- **Noise:** findings from one lens, declined or refuted three or more times
  for the same reason. The usual cause is a lens that does not know a decision
  this project has written down (for example the scale in `AGENTS.md`), or a
  threshold that makes a minor concern request changes. Check the replies: a
  decline the author justified only by the ticket's scope is weaker evidence
  than one that cites a standing project rule.
- **Miss:** a bug that reached `main` and was fixed later, in an area a lens is
  routed to, that a reasonable reading of that lens should have caught. One
  clear miss is enough.
- **Misrouting:** a lens reviewing files its own text says it does not cover,
  or files no lens reviews.

Not a pattern: one-off disagreements, findings that were simply addressed, and
anything about how the change was written rather than what the lens asked for.

## Writing a finding

At most three findings per run, the strongest first. Before writing one, read
the open, in-progress, resolved and ignored findings tagged `code-review-lens`:
do not repeat one that is open, in progress or ignored, and only revisit a
resolved one if the pattern has come back since it was resolved.

Each finding proposes one change to one lens (or to the profile's routing):

- `title`: the lens and the change, for example "review-scale-and-resilience:
  weigh paging and fan-out against the scale AGENTS.md states".
- `analysis`: the pattern, with counts (for example "9 of 31 scale findings
  since 2026-10-08 declined, each citing the AGENTS.md scale"), two to four
  quoted examples with their pull request, and why the lens produces them, from
  its own text.
- `recommendation`: the edit, concretely: which file, which section (Scope,
  Method, Threshold, Reporting), and the sentence to add, change or remove.
  Keep a lens general, as its own guidance asks: say what to weigh, not a list
  of this week's cases.
- `expectedImprovement`: what should change in the numbers (fewer declined
  findings from that lens, or the missed kind of bug caught).
- `observations`: one, with `observedAt` now and `evidence` the pull request
  comment URLs and settled-finding ids you relied on.
- `tags`: `["code-review-lens", "<lens skill name>"]`.

Create it with `tessl finding create --project <project> --file -`, passing
`{"schemaVersion": 1, ...}` with those fields on stdin. If creating findings is
refused in this run, put the full text of each finding you would have written in
your output instead and say so.

## Ending

Say in your output: the window you read, the headline numbers (pull
requests, findings, addressed, declined, refuted, by lens, from GitHub), each finding you created with
its id and title, the patterns you looked at and did not write up and why, and
anything you could not read.
