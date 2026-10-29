---
name: create-github-issue
description: Write and file a GitHub issue for the Tessl factory to turn into a pull request, with the person's own GitHub account. Use when someone wants Tessl to work on something in a repository whose factory takes GitHub issues, wants a task split into issues the factory builds in order, or asks how to write an issue for Tessl.
---

# Create a GitHub issue for the factory

Write issues the factory can build without asking, and file them with `gh` as
the person. [Writing a ticket for the factory](../../docs/writing-factory-tickets.md)
says how to find the factory's label, what an issue says, and how to size and
order a batch. Read it first.

## Steps

1. Find how this project takes tickets, as that doc says. When its Loop
   starts on a Linear delegate, use
   [create-linear-issue](../create-linear-issue/SKILL.md) instead.
2. Check `gh auth status` and `gh repo view --json nameWithOwner`. When `gh`
   is missing or not logged in, ask the person to install it or run
   `gh auth login`, and wait.
3. Draft each issue from the repository, as the doc says. For a blocker, add a
   `Blocked by #<n>` line to the body. File blockers first so their numbers
   exist.
4. Show the drafts and wait for the person's yes.
5. File each one: `gh issue create --title <title> --body-file <file>
   --assignee @me --label <label>`. Write the body to a file outside the
   repository. An issue with a `Blocked by` line gets the label too: Tessl
   waits for its blockers and starts it when they close. To park an issue
   until the person decides, leave the label off; adding it later with
   `gh issue edit <n> --add-label <label>` starts the work.
6. Give each issue's link, and say that removing the label stops the work on
   it.

## Rules

- Write the whole issue before it gets the label. A run starts about 90
  seconds after the label is added and reads the issue as it is then.
- Never add the label to an issue the person did not ask to hand over.
- When a command is refused, by GitHub or by the agent's permission system, do
  not work around it: ask the person to run it.
