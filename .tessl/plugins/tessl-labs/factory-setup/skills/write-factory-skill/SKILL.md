---
name: write-factory-skill
description: >-
  Write or rewrite a skill used in a Tessl factory: a new skill for an
  automation, a copy of a published factory skill kept in the repository, or
  a skill that takes over work a script, a runbook or an earlier skill does
  today. Use when drafting such a skill, rewriting one that has grown into a
  numbered procedure, or checking one before it merges.
---

# Write a factory skill

A factory skill runs unattended, one round at a time, on whatever the pull
request or ticket shows at that moment. Text that reads well to a person can
still send that agent the wrong way. Two references say what the finished
skill looks like: read [Factory skill shape](references/factory-skill-shape.md)
and [State in factory skills](references/factory-skill-state.md) first, and
again before step 3. A third, [Taking over from what runs
today](references/incumbent-contract.md), says how to learn from whatever the
skill replaces. Keep working notes in a directory the repository ignores,
never in the change itself.

1. **Learn what the skill replaces**, when it takes over work another system
   does (a script, a runbook, a GitHub Actions workflow, an agent harness) or
   rewrites an existing skill: follow [Taking over from what runs
   today](references/incumbent-contract.md). You end with the outcomes and
   rules the incumbent holds, each mapped to a platform mechanism, the skill
   text or a gap, and for a rewrite a classification of every paragraph of the
   current text. A new skill that replaces nothing starts at step 2.
2. **List the environment facts and check each one** against the repository's
   default branch, fetched first: what the skill's tools print, what starts a
   round and what does not (the automation's triggers or schedule in
   `tessl.json`), which other automations the skill's own writes start (an
   issue it labels `tessl` starts Implement), and what bots and reviewers do.
   For each fact, find what makes it true: a file, a trigger, a command's
   output. Delete a fact you cannot find, and say instead what the agent cannot
   rely on.
3. **Draft** to the shape: what done looks like, invariants, environment facts,
   judgment. Wire a new skill as [Write your own
   automation](../factory-setup/references/starters.md#write-your-own-automation)
   says. A scheduled one that writes takes a concurrency key with `limit: 1`,
   as `turn-findings-into-tickets` does in
   [triggers](../factory-setup/references/triggers.md), so two runs never
   overlap. Its `SKILL.md` frontmatter links its input schema; without the link
   the schema is not checked:

   ```yaml
   schemas:
     inputs:
       $ref: ./schemas/inputs.schema.json
   ```

4. **Walk concrete cases with a reviewer who has not seen your work**: a
   subagent, or a fresh session. Give it the skill text and a list of cases,
   each a real pull request or ticket state (link real ones where they exist)
   with the action you expect. Ask what an agent following only the text would
   do in each case and which line it relied on; then ask for contradictions,
   facts to check against named files, rules whose absence would do harm, and
   wording a model would misread. Tell it the shape is decided. Fix what it
   finds and walk the cases again. A finding is not a rule to add: ask first
   whether the shape, a fact or the agent's judgment already covers the case,
   because a sentence written for one case is the start of a numbered
   procedure, and most fixes are a deletion or a corrected fact. Put the cases
   and the last walk's outcome in the pull request description. A case walk checks the decision; when the
   change affects what the agent writes, also run the action once after the
   merge with `tessl action trigger <name>`, giving `--input` the subject it
   should work on (a throwaway pull request or ticket) and a dry-run input if
   it writes to real records, and tell the person what it did.
5. **Do not test the wording.** Never write a test that matches the text of a
   `SKILL.md`. A script the skill runs gets its own tests; the case walk tests
   the text.
