# Factory skill shape

What to put in a skill that a factory automation runs. Read this before
drafting or editing one.

A factory skill runs as a one-shot round: a fresh agent with no memory of
earlier rounds, on the agent and model its automation names. Tessl's cloud
prepares the run before the agent starts: the clone, GitHub authentication,
`.cloud-launch/trigger-events.json` with the events that started the round, the
installed skill, the inputs in `.cloud-launch/inputs.json`, the team's rules
in `.cloud-launch/instructions.md`, and the repository's setup hook. What it
does not provide is anything between rounds. An agent harness, code that runs
an agent round after round, can skip feedback it has handled, retry a failed
round and stand down when the ticket is stopped; a factory automation has only
its skill text, its triggers or schedule, and the scripts and tools the skill
ships with, so what those do not say or enforce does not happen. A numbered
procedure copied from a prompt written for a harness becomes choreography the
agent misreads ([Taking over from what runs today](incumbent-contract.md) says
how to learn from such a prompt without copying it), and two paragraphs that
disagree get applied to the wrong case. Say in the skill which wins when the
team's rules in `instructions.md` conflict with its invariants.

The starting state is unknown to every factory skill, including one that runs
once from start to finish. A run-once skill can be launched against an issue a
person has half-done, run again after a round that pushed a branch and crashed
before opening the pull request, or woken again by an edit to an issue that is
still waiting to start. A numbered procedure assumes one starting state and one
path from it. Every other start has to be added as an early exit, each exit can
only stop, and for a start nobody listed the agent runs the steps from the top
or guesses where to resume. A finished state with the situations that can
precede it, each with its next action, gives the agent something to match
against whatever the pull request, the issue or other record shows.

Write the skill in four parts, never as a numbered list of steps to perform in
order. A numbered list of situations in precedence order is fine:

- **What done looks like.** The finished state, then the situations the work
  can be in, in precedence order ("take the first that applies"), each with one
  next action. Close the list: if the record fits none of them, the agent says
  what it found and stops. Without an order, situations overlap: feedback that
  arrives after an approval matches both "there is work to do" and "approved,
  request the owner".
- **Invariants.** A section labeled "Invariants", grouped under theme headings,
  numbered continuously across the groups so the rest of the text can cite
  them. State each in its natural form: a never, an always, or a plain
  statement of what holds. Do not bend a rule into a prohibition for
  uniformity: "never leave an item without exactly one answer" reads worse
  than "every actionable item gets exactly one answer". Give the harm in a
  sentence where it helps the agent judge an edge case ("review threads are
  anchored to commits, so rewriting history orphans them").
- **Environment facts.** What the tools print, what wakes a round and what
  does not, what the bots do. [State in factory skills](factory-skill-state.md)
  says how to check them.
- **Judgment.** How to read ambiguous state: what is actionable, when to fix,
  refute or decline, when to stop and ask a person.

The skill does not describe its own configuration: no prose about how its
triggers or concurrency are set up, no step that checks that setup, no note
that an invariant is also enforced elsewhere, no history of what it replaced.
What wakes the agent, and what does not, is an environment fact and belongs in
the skill ("nothing wakes you when the base branch moves; if the pull request
needs something no event will bring, say so on it"). The design gap behind it
belongs in your own notes or issue tracker, not in the skill.

Ticket state is output, not input. Have the agent write the ticket's state to
mirror the work, for the people reading the board, and read it only for what a
person sets to steer the work: the state that starts it, the state or
delegate change that takes it back, and the states that end it. Have it judge
those from the record as well as the state: what the person said last, and
what the agent itself said before it.

## Inputs

A skill's inputs are declared in its `schemas/inputs.schema.json`, which its
`SKILL.md` frontmatter links. The automation that launches the skill fills
them: each trigger maps the event onto them, and a schedule passes fixed
values. They set inputs by name, so renaming an input breaks every trigger and
Loop that sets the old name, and making one required breaks every one that
does not set it; for a published skill, those are in other repositories.

- **One subject, one required input.** A skill that works on one Linear issue,
  one GitHub issue or one pull request takes it from one input its schema
  requires, such as `LINEAR_ISSUE_IDENTIFIER` or `GITHUB_PR_NUMBER`, and every
  trigger that starts it maps that input. A missing required input then fails
  the launch before any agent runs. It never falls back to
  `.cloud-launch/trigger-events.json` to find that subject. It may read the
  events for facts only they carry (a skill that runs when a pull request
  closes reads the merge result and head branch), and it stops without a write
  when they name a different subject. A skill whose run folds several events
  into one, such as one that posts a summary of new findings, reads its
  subjects from the events, and a scheduled skill finds its own set of things
  to work on; this point covers neither.
- **The name says whose value it is.** An input name starts with the system's
  name, such as `GITHUB_`, `LINEAR_` or `SLACK_`, when its value belongs to
  that system. Git values
  (`BRANCH`, `BASE_BRANCH`) and run settings (`DRY_RUN`) have no prefix.
- **An automation reads only its inputs.** The action does not read the event.
  Its triggers map the event onto the inputs.
