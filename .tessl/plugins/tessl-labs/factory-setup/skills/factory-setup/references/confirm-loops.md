# Confirm the Loops appear

Tessl reads `tessl.json` from the default branch after a push and creates or
updates one Loop for each entry. A recent or successful sync time does not
prove that the Loops exist, so check for each Loop by name.

1. List the expected Loops from the merged `tessl.json`: one for each entry
   under `actions`, one for each trigger or schedule whose `action` is
   written inline instead of naming an entry under `actions`, and one for each
   flat schedule that declares `skill` and `environment` directly instead of
   an `action`.
2. Tell the user you are waiting up to 10 minutes for the Loops to appear.
   Then run
   `tessl schedule list --project-id <linked project id> --all --json`
   once a minute, with the project ID from
   `linkedProject.id` in `tessl project repair --json`. The command returns
   only that project's Loops, so other projects in the same workspace and
   Loops with the same name never match. A Loop has appeared when an entry in
   `data` has `attributes.label` set to its name and its
   `attributes.triggers[].name` values include every trigger and schedule in
   the merged file that runs it. A schedule is listed there with
   `kind` `cron`, and an action that nothing runs has an empty list. Stop when
   every expected Loop has appeared.
3. Each minute, also run `tessl schedule list` without `--json` from the
   repository root. If it warns that the last sync of `tessl.json` failed, stop
   waiting and run `tessl schedule validate`. Tell the user that the sync
   failed, what `tessl schedule validate` reports, and that the automations
   are not live.
4. When every Loop has appeared, give the user the project's Loops link (the
   project's `webUrl` with `/loops` added). Do not give each Loop's `webUrl` from
   `tessl schedule list`: it opens the old Schedules page.
5. If any Loop is still missing after 10 minutes, stop waiting. Tell the user
   which Loops did not appear, and that setup is not finished. Check that the
   merge was to the default branch and that the environment name in
   `tessl.json` matches the environment you created. Then run
   `tessl doctor --automations` and explain each Event delivery warning and
   what to do. "The Tessl App is not installed on this repository"
   means the Tessl App cannot see it: give the links as preflight
   "The Tessl App" in the skill's preflight does, and check again once the
   user says it is done.

## Example

This `tessl.json` declares two actions, one trigger, and one schedule:

```json
"actions": {
  "implement-linear": { "skill": "tessl-labs/factory#implement-linear", "environment": "factory" },
  "triage": { "skill": "acme/ops#triage", "environment": "factory" }
},
"triggers": {
  "linear-issue-delegated": { "on": ["linear:Issue.create"], "action": "implement-linear" }
},
"schedules": {
  "weekly-digest": {
    "cron": "0 9 * * 1",
    "action": { "skill": "acme/ops#digest", "environment": "factory" }
  }
}
```

Expect three Loops. Trimmed to the fields this check reads,
`tessl schedule list --project-id <linked project id> --all --json` returns:

```json
{
  "links": { "self": null, "next": null, "prev": null },
  "meta": { "count": 3 },
  "data": [
    {
      "id": "<id>",
      "type": "schedule",
      "attributes": {
        "label": "implement-linear",
        "kind": "event",
        "triggers": [{ "name": "linear-issue-delegated", "kind": "event" }]
      },
      "webUrl": "<Loop link>"
    },
    {
      "id": "<id>",
      "type": "schedule",
      "attributes": { "label": "triage", "kind": "schedule", "triggers": [] },
      "webUrl": "<Loop link>"
    },
    {
      "id": "<id>",
      "type": "schedule",
      "attributes": {
        "label": "weekly-digest",
        "kind": "schedule",
        "triggers": [{ "name": "weekly-digest", "kind": "cron" }]
      },
      "webUrl": "<Loop link>"
    }
  ]
}
```

So:

- `implement-linear`, with `attributes.triggers` names
  `["linear-issue-delegated"]`.
- `triage`, with no triggers, because nothing runs it.
- `weekly-digest`, with `attributes.triggers` names `["weekly-digest"]` and
  that entry's `kind` is `cron`.

After a sync failure or a timeout, say the automations are not live, and do
not go on.
