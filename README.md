# memory-cp

This repo is a test bed for the [Tessl](https://tessl.io) factory.

## How the factory works

The factory runs from the **Factory stages** on the project's Loops tab in the
Tessl web app (Implement, Shepherd, Code Review). It does **not** run from
`tessl.json`.

## How to start work

1. Create or find a COL Linear issue describing what you want done.
2. Delegate the issue to **Tessl** and leave it in **Todo**.
3. Tessl picks it up, opens a branch and a pull request, then comments a link.

**To stop the work:** move the issue out of Todo, or remove the Tessl delegate.
Tessl will notice and stop without making further changes.
