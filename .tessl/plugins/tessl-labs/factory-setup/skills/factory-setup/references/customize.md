# Editing a factory skill

The factory actions run skills from `tessl-labs/factory`. The user has two ways
to change what a skill does.

## Add instructions

For a small change, keep the published skill and add `instructions` to the
action in `tessl.json`, for example "Run `bun run lint` before you push." The
user keeps getting fixes when `tessl-labs/factory` is updated.

## Use an own copy

For a larger change, copy the skill into the repository and point the action
at the copy. The user owns the copy and no longer gets fixes from
`tessl-labs/factory`. Tell the user this before you copy.

1. In a new empty directory outside the repository, run `git init`, write
   `{"name": "factory-copy", "dependencies": {}}` to `tessl.json`, and run
   `tessl install tessl-labs/factory --yes`.
2. Copy `.tessl/plugins/tessl-labs/factory/skills/<skill>` from that directory
   to `tessl-factory/skills/<skill>` in the repository.
3. Write `tessl-factory/.tessl-plugin/plugin.json` with `name` set to
   `<workspace>/<repo>-factory`, `version` `0.1.0`, a one-line
   `description`, `private` `true`, and a `skills` entry for each copied
   skill. If the file exists, add the new skill
   to its `skills` list.
4. In `tessl.json`, change the action's `skill` to
   `file:tessl-factory#<skill>`.
5. Run `tessl doctor --automations`.
6. Make the change the user asked for in the copied `SKILL.md` with the
   `write-factory-skill` skill. Keep its "Invariants" section.

The change takes effect after it merges to the default branch.
