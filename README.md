# memory-cp

This repo is a test bed for the [Tessl](https://tessl.io) factory: an automated
engineering workflow that ships Linear issues and follows up on pull requests.

## Automations

Two automations are configured in `tessl.json`:

### implement-linear

Triggered when a Linear issue is delegated to Tessl and its state is `unstarted`.
The agent reads the issue, makes the change on a `tessl/<issue-id>` branch, runs
tests, and opens a pull request.

### shepherd

Triggered when a reviewer submits a review, leaves a comment, or checks fail or
pass on a pull request labelled `tessl`. The agent reads the feedback and either
addresses it or explains why it cannot.

## How to use

Delegate a Linear issue to Tessl and leave it in Todo. The factory picks it up,
does the work, and opens a pull request for your review. Moving the issue out of
Todo or removing the delegate stops the work.
