# State in factory skills

How a skill that a factory automation runs should treat state: what the agent
may remember, what it decides from, and what it must be told. Read this with
[Factory skill shape](factory-skill-shape.md) before drafting or editing one.

**The record is the only memory.** Each round starts with nothing but what the
pull request and its ticket show (or whatever record the automation works
from), so have the agent put every decision on that record, and on a pull
request in the thread it belongs to: a fix, a refutation, a decline, a
question, a check rerun, a repair. Do not give it a database or a per-finding
ID scheme to keep: a person reviewing has neither and works from the review
surface, and so can the agent. A marker on the agent's comments lets a later
round find them, but only together with their author: a marker pasted into a
person's comment does not make it the agent's.

**Recovery is a property of state, not of the round.** Write every next action
as a condition on the pull request as it stands, never as something only "the
round that pushed" does. One skill stalled on exactly that: a round pushed
fixes and missed the re-review request, and every later round found nothing
outstanding and did nothing. The fix was "nothing is outstanding and the
reviewer has not looked at the pull request as it stands: ask", whichever
round pushed.

**Every "at most once" needs a way to reopen.** Say what answers it. A review
request is answered by the first review after it, and once the agent has
answered that review it may ask again. Without that, a round that refutes every
finding and pushes nothing leaves the one request spent and the pull request
stuck.

**Judge by age, not by rounds.** "Wait one round" needs memory the agent does
not have. "No review thirty minutes after the request" is something it can
read from the record.

**Give the agent facts for what it cannot know.** An agent called an
eleven-hour-old request "less than thirty minutes old" because nothing told it
the time. The fix was a fact, a `Collected at` line in the script that reads
the record, and one sentence telling the agent to work out the age from it. A
collector is a script shipped with the skill that reads one record, such as a
pull request or an issue, in full into one output and fails rather than print
a partial read; the skill has the agent
decide from it and not from reads of its own. Prefer a platform mechanism over
an instruction whenever one exists or is cheap: a collector, a tool that stamps
its own marker, the action's concurrency key. Where none exists yet, start with
an instruction the agent can follow.

**A script reads one thing and decides nothing.** It runs one query to the
last page, fails rather than print a partial read, prints every result in one
fixed shape with a `Collected at` line, and takes its input as the plain value
the query needs (a branch, an issue ID), never deriving one from a convention
the skill owns. Every qualifier in a query is a decision, and decisions live
in the skill text next to their reason: a script that computes "this pull
request belongs to the issue" has moved the rule out of the one place a
reviewer reads it, and changing the rule becomes a script change with tests.
The test is whether the skill text could change the policy without the script
changing. Split by what is read, not by who needs it: one script per record
or query, composed by the text, because a script that reads two systems
"because the skill needs both" is a procedure again. Name it after what it
does to the record, `gather-<record>` for one thing read by ID and
`list-<things>` for a set, since a singular name on a search misleads the
reader about what comes back. Print only the fields a sentence in the skill
uses; the rest are free in the query but each is a line the agent weighs.

**Where the world cannot be enumerated, name the judgment and stop.** The
counterpart of the script rule. Some states have more shapes than a text can
list, and a rule that decides them up front is wrong for every shape nobody
listed. Write what the agent reads, the cases it must recognize, and the
surface the person uses to steer it, and leave the decision to the agent. The
test: would an engineer in the same position want a rule here, or want to
look? A branch left by an earlier attempt, for example, is read (its diff, its
authors, the conversation of the pull request closed on it), not ruled on; the
person steers through the issue, so moving it back to the state that starts
the work is the decision to try again, and what becomes of the branch is the
agent's call.

**Check every environment fact against the default branch, and say why the
agent needs it.** A skill copied from an older system described a poller that
re-ran rounds on red checks, a fresh run whenever a ticket was resumed, and a
review command that no longer existed, none of which existed where the skill
ran. Check the triggers too, not only the code: nothing polls the checks, but a
trigger on a check result, such as a failed check run, does wake a round. A
skill that describes a world that does not exist is worse than one that says
what the agent cannot rely on.

**Handles are commands.** Tessl Code Review takes `@tessl-code-review` or
`@tessl-reviewer` as a review request when a new comment on the pull request or
in a review thread, from anyone, says the handle rather than shows it: outside
code spans, fenced blocks and block quotes. Give the skill one form for asking,
a top-level comment whose whole body is the handle, which also lets a later
round see that a request was already made. Any other comment the agent writes
must not say either handle; mentioning a person in it is fine.
