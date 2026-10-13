# memory-cp

This repo is a test bed for the [Tessl](https://tessl.io) factory.

## How the factory works

The factory runs from the **Factory stages** on the project's Loops tab in the
Tessl web app (Implement, Shepherd, Code Review). Actions and triggers are
configured in `tessl.json`; adding or removing them enables or disables
automations when the file reaches the default branch.

## How to start work

Requires a connected Linear workspace with a team mapped to this project and an
active issue-to-PR automation in `tessl.json`: the `implement-linear` action
and a `linear-issue-delegated` trigger that fires on `linear:Issue.create` and
`linear:Issue.update`, filters for the Tessl delegate id and `unstarted` state,
limits to one active implementation per issue (concurrency key `implement:{{ event.data.id }}`, limit 1),
and dispatches `implement-linear`.

1. Create or find a COL Linear issue describing what you want done.
2. Delegate the issue to **Tessl** and leave it in **Todo**.
3. Tessl picks it up, opens a branch and a pull request, then comments a link.

**To stop the work:** move the issue out of Todo, or remove the Tessl delegate.
Tessl will notice and stop without making further changes.
