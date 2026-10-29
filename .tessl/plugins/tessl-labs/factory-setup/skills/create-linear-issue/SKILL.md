---
name: create-linear-issue
description: Write and file a Linear issue for the Tessl factory to turn into a pull request, with the person's own Linear access, and delegate it to Tessl. Use when someone wants Tessl to work on something in a repository whose factory takes Linear issues, wants a task split into issues the factory builds in order, or asks how to write an issue for Tessl.
---

# Create a Linear issue for the factory

Write issues the factory can build without asking, and file them in Linear as
the person. [Writing a ticket for the factory](../../docs/writing-factory-tickets.md)
says how to find the state and delegate the factory starts on, what an issue
says, and how to size and order a batch. Read it first.

## Steps

1. Find how this project takes tickets, as that doc says. When its Loop
   starts on a GitHub label, use
   [create-github-issue](../create-github-issue/SKILL.md) instead.
2. Find Linear access: a Linear MCP server, or the Linear API with the
   person's own key in `LINEAR_API_KEY`. With neither, ask the person to
   connect a Linear MCP server or set a key, and wait.
3. Find the team. `tessl api /v1/orgs/<org id>/integrations/linear/routes`
   lists which Linear team runs in which project: take the team whose
   `projectId` is this project. A `linearTeamId` of `*` routes every team
   without a route of its own. When more than one team fits, ask which.
4. Find Tessl in Linear: the workspace's app user named Tessl. Its id is the
   delegate the Loop starts on.
5. Draft each issue from the repository, as the doc says.
6. Show the drafts and wait for the person's yes.
7. File each one in the team, assigned to the person:
   - **No blockers:** create it in the Todo state with Tessl as delegate.
   - **With blockers:** create it in Backlog without a delegate, add its
     `blocked by` relations, then make one update that sets Tessl as delegate
     and moves it to Todo.
   - **To park it until the person decides:** leave it in Backlog. Delegating
     it and moving it to Todo later starts the work.
8. Give each issue's link, and say how to stop the work: move the issue to
   Backlog with Tessl still its delegate. When the project's follow ticket
   changes Loop is active, that cancels a run in progress; otherwise the run
   stops at its next check of the issue and uses credits until then.
   Removing Tessl as delegate only stops new runs.

## Rules

- The Loop starts on every create or update that leaves the issue delegated
  and in Todo. Do not edit an issue in that state; once it has a pull
  request, comment on the pull request.
- Never delegate an issue the person did not ask to hand over.
- Never print the API key or put it in a command line argument.
- When a call is refused, do not work around it: ask the person to make the
  change in Linear.
