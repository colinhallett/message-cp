# Readiness score

Score the repository against [the readiness rubric](readiness-rubric.md) with
`scripts/score-repo.mjs`. The script checks every criterion that is a fact
about files, such as a config that exists or a tool CI runs, for every app,
and writes the rubric's JSON. It decides only what it can decide without
doubt: a criterion whose answer needs a reader (does the README explain
setup), a tool it does not know (a `lint` script that runs something other
than the linters it recognises), or a check that threw is left marked
`needsJudgement`, with the snippets to judge it from. It reads only tracked
files, runs in seconds, and changes nothing. Do not read the repository to
re-check what the script decided.

When the script itself fails, score in a subagent instead, as
[the fallback](#fallback-score-in-a-subagent) says. When you cannot start a
subagent either, skip the score, tell the user in one line, and go on.

## Baseline (step 1)

1. Make a temporary directory outside the repository, for example with
   `mktemp -d`. Call it the score directory. Record the commit you score with
   `git rev-parse HEAD`; call it the baseline commit.
2. From the repository root, run
   `node <this skill's directory>/scripts/score-repo.mjs --out <score directory>`
   (use `bun` if `node` is unavailable). It writes `agent-readiness.json` there
   and prints the apps it found and the criteria that need judgement. A
   non-zero exit is the script failing: use the fallback.
3. Open `agent-readiness.json` and fill each criterion with
   `"needsJudgement": true`:
   - Judge it from its `judge` entries: each lists an app, the files it rests
     on (`sources`), and `snippets` of them. Open a source only when its
     snippet is cut off before the answer. Apply the rubric strictly.
   - Keep the apps in its `decided` list as decided.
   - Set `passingAppNames`, the apps that pass, from `applicableAppNames`, and
     `passingApps` to their count. Write a one or two sentence `rationale`, and
     an `action` when any app fails.
   - Remove `needsJudgement`, `judge`, `decided`, and `sources`.
4. Add `recommendations`: the 2 or 3 failed criteria whose actions would help
   agents most, each with a `title` and a one-sentence `detail`.
5. Change a checked criterion only when its rationale is wrong about a file
   you opened. Say so in its rationale, starting with "Corrected:".
6. From the score directory as the working directory, run
   `node <this skill's directory>/scripts/build-report.mjs agent-readiness.json`.
   It writes `agent-readiness-report.md` and prints one summary line. Keep the
   line, the score directory, and the baseline commit for the rest of the
   session. Leave `agent-readiness.json` there; the re-score reuses it.

## Re-score (step 8)

The re-score re-checks only what the branch changed and keeps the baseline
result for everything else, so the score moves only where the branch did.

1. Write the files the branch changed, one path per line, to
   `changed-files.txt` in the score directory, with
   `git diff --name-only <branch start> HEAD`, using the branch start that
   [Start the branch](apply.md#start-the-branch-step-6) recorded. When the
   list is empty, the score is unchanged; show the baseline summary line and
   stop here.
2. When the branch start differs from the baseline commit, the default branch
   moved during the session. List those files with
   `git diff --name-only <baseline commit> <branch start>`, and tell the user
   that the baseline was scored before them and the re-score does not judge
   them.
3. From the repository root, run
   `node <this skill's directory>/scripts/score-repo.mjs --out <score directory> --baseline <score directory>/agent-readiness.json --changed <score directory>/changed-files.txt`.
   It writes `rejudged.json`, one entry per checked criterion whose result a
   changed file flipped, and `rejudge-needed.json`, the judgement criteria
   whose sources the branch changed, with fresh snippets and the baseline
   result. When the baseline came from the fallback, every criterion is a
   judgement criterion: re-judge as the fallback says instead.
4. For each entry in `rejudge-needed.json`, judge it again from its snippets.
   When an app's result changes, add an entry to `rejudged.json` in the same
   shape as the others: `category`, `name`, `rationale`, `evidence` (changed
   files only, exactly as `changed-files.txt` writes them), `changes` (each
   flipped `app`, its new `passes`, and its `evidence`), and an `action` when
   it still fails. Leave out a criterion that did not move.
5. From the score directory as the working directory, run
   `node <this skill's directory>/scripts/rescore.mjs`. It applies the flips,
   writes `agent-readiness-after.json` and `agent-readiness-after-report.md`,
   and prints the score before and after and each criterion that moved. When
   it refuses an entry, fix `rejudged.json` and run it again.
6. Show the user those lines. When the script lists changed files no
   criterion cites, name them, and say which criterion, if any, they should
   have moved. Confirm `git status` shows no changes.

## Fallback: score in a subagent

Used only when `score-repo.mjs` fails. The subagent judges every criterion
itself, so its score is not comparable with a scripted one; use it for both
the baseline and the re-score of one session.

Baseline: start a subagent with the repository as its working directory and
give it these instructions:

- Read [the readiness rubric](readiness-rubric.md) and assess the repository
  against it. Base every judgement on files you open.
- Do not create, change, or delete any file in the repository.
- Write the assessment JSON, in the shape the rubric documents, to
  `agent-readiness.json` in the score directory, not the repository root.
  Give every criterion two more fields: `applicableAppNames`, the apps it
  applies to, and `passingAppNames`, the apps that satisfy it, each using
  names from `apps` and matching `applicableApps` and `passingApps`.
- From the score directory as the working directory, run
  `node <this skill's directory>/scripts/build-report.mjs agent-readiness.json`.
- Reply with only the summary line the script printed.

Then check that `git status` shows what it showed before the subagent ran;
if not, tell the user which files changed and leave them for the user.

Re-score: start a subagent with the repository as its working directory and
give it these instructions:

- Read the rubric, the baseline `agent-readiness.json` in the score
  directory, and `changed-files.txt`.
- Pick the criteria whose evidence is in a changed file. Leave every other
  criterion alone, even when you would judge it differently today.
- For each picked criterion, start from the baseline rationale and its
  `applicableAppNames` and `passingAppNames`. List only the apps whose result
  a changed file flips, following the rubric and files you open. Every other
  app keeps its baseline result.
- Do not create, change, or delete any file in the repository.
- Write `rejudged.json` to the score directory, in the shape step 4 of the
  re-score describes, with one entry per picked criterion and none for the
  rest. `category` and `name` match the baseline exactly; each `app` is a
  name from the baseline's `apps` list; `passes` is the app's new result;
  each `evidence` lists changed files, exactly as `changed-files.txt` writes
  them; a criterion still failing needs an `action`.
- From the score directory as the working directory, run
  `node <this skill's directory>/scripts/rescore.mjs`, fix `rejudged.json`
  when it refuses an entry, and reply with only the lines it printed.

Then continue at step 6 of the re-score.
