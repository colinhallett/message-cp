# Check the setup hook in the cloud

The fresh-clone check runs the hook on the user's machine. This check runs it
on the cloud machine before the change reaches the default branch. Each check
is one cloud run and uses its credits; say so when you start it, without
asking. Run it again after each fix to the hook.

The check runs a branch's hook, so it starts only after the user has agreed to
push when going live: the setup branch, or, when the user pushes straight to the
default branch, a temporary branch named `tessl-check-hook`, deleted once the
check is done. Push to the default branch only once the hook passes.

1. Launch the check from the default branch, with the environment and the
   agent and model the actions use, naming the branch to check:

   ```
   tessl launch skill tessl-labs/factory-setup#check-cloud-setup --cloud \
     --repo <owner/repo> --base-branch <default branch> \
     --environment <environment> --agent <agent> --model <model> \
     --instructions "Branch: <branch>" \
     --label "Check the setup hook" --no-wait --json
   ```

   `<environment>` is the one the automations use: `<repo>-factory`, or, for
   automations set up in Tessl, a Loop's own, from
   `attributes.environment.name` in `tessl schedule view <loop id> --json`:
   the "Implement ticket" Loop's when there is one, otherwise the "Learn
   from agent runs" Loop's (named "Agent Retro" when set up earlier). The
   check only reads the branch, so read access is enough.
   When no Loop has an environment, create `<repo>-factory` with
   `--github-access read` for it.
   Take `<agent>` and `<model>` from a pair `tessl launch models --json` lists
   (it spells `claude` as `claude-code`), or leave `--model` out when the list
   has a `default` pair. The default branch has no hook yet on a first setup,
   so the run starts and the agent runs that branch's hook itself. A hook
   that fails while Tessl prepares the run leaves no output; one the agent runs
   keeps it. Keep `launchRunId` and give the user the run's link, `data.webUrl`
   from `tessl launch view <id> --json`.

2. Once a minute, for up to 10 minutes, read `tessl launch view <id> --json`.
3. When `data.attributes.status` is `completed` and
   `data.attributes.outcome.status` is `succeeded`, give the user
   `data.attributes.result.summary`: the hook passed twice, and what the
   machine has. Then go back to the step that asked for the check.
4. When `data.attributes.outcome.status` is `failed`, show
   `data.attributes.result.summary` and the hook's output in
   `data.attributes.result.reason`, fix the hook on the branch, push, and
   check again.
5. When the run itself fails, read
   `tessl launch progress <id> --filename prepare-subphases.json`:
   `first_failed` names the step, and `cloud-launch-setup` means the default
   branch's own hook failed.
6. For any other result (cancelled, no outcome, or still pending after 10
   minutes), say so, give the run's link, and say the hook is unverified.
