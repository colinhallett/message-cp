# Taking over from what runs today

How to build a factory skill from whatever does the work today, and why that
thing's text is never copied. It can be an agent harness (code that runs an
agent round after round), an earlier version of a skill you are rewriting, a GitHub
Actions workflow, a script, or a person following a runbook. Read this with
[Factory skill shape](factory-skill-shape.md), and keep the findings in your
working notes.

**The prompt is not the contract.** A harness enforces much of what it
guarantees in code: it decides what wakes a round, skips feedback a previous
round handled, retries a failed round, stands down when the ticket is paused,
and tells its own comments apart from everyone else's. Its prompt covers only
the agent's share and reads as if that code were there. Copying the prompt
into a factory skill keeps the share and drops the guarantees, and an author
who notices the drop re-expresses each guarantee as a step, which is how a
factory skill becomes a numbered procedure. So read the code as well as the
prompt, and treat the prompt as evidence of what the harness expected the
agent to do, not as a draft.

**Extract the contract as observable outcomes.** List what it guarantees and
what it never does, as a person watching the pull request, the ticket or
whatever record it works from would state them: "every actionable review item
gets exactly one answer", "never rewrites history on a branch with review
threads", "asks for a review after every push". Not its code paths. For each,
record where it is enforced: code, prompt, a tool's behavior, trigger
configuration, or nowhere but convention. To find them in code, start from
what drives it: what starts a round, what each round reads, what it writes,
what stops it, and what happens when a round fails. Check each on the default
branch, because a prompt can describe behavior its code has since lost.

**Map each item to where the factory will hold it.** A platform mechanism
(trigger conditions, a schedule, the action's concurrency key, a collector
that reads one record in full into one output, a tool that stamps its own
marker), the agent's judgment (the skill text), or a gap. Replicate the
outcomes and invariants, not the way the old system produced them: a dedupe it
did by remembering what it posted becomes "every item gets one answer, and
your earlier replies are on the thread under your own name". What the old
system already wrote, its comments and the labels it set, is part of the
record: say how the skill reads it, or its first run repeats it. A gap the agent
cannot close, such as nothing waking it when the base branch moves, goes in
your notes or issue tracker, and the skill says only what the agent cannot
rely on.

**When rewriting a skill, classify every paragraph** of the current text as a
goal, invariant, environment fact, judgment, procedure, restatement, or stale
claim. Give each the commit that added it and the reason from the issue or
pull request behind that commit; write "reason not found" rather than guess.
For text copied from another file in the repository, follow the phrase through
that file's history too (`git log -S'<phrase>' -- <file>`), or every paragraph
dates to the copy commit. Keep goals, invariants the agent owns, facts true on
the default branch, and judgment. Drop the rest, and write down what you
dropped and why. A paragraph whose reason you did not find stays, in its own
words.

**What goes wrong without this.** One skill that looked after pull requests
began as a copy of the prompt an in-house harness gave its agent, and grew to
more than a thousand lines of numbered steps. The harness was mostly code, so
the prompt alone was never the contract: the copy described a watcher that
re-ran rounds on any red check (in the factory, only triggers on check results
woke it) and a review command the harness had already removed, and it let only
a round that pushed or replied ask for a re-review, so one missed request
stalled the pull request for every later round. Patches then added what the
harness used to do as more steps, among them a fresh run whenever a ticket was
resumed, which no trigger started. The rewrite extracted the harness's
contract from its code, mapped each item to a trigger, a collector or the
skill text, and became a goal, invariants, environment facts and judgment.
