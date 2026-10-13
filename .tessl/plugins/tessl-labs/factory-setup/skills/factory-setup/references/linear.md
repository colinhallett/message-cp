# Linear prerequisites

Linear issue to PR needs three things. Check each one and stop with a clear
instruction when one is missing.

1. **Linear is connected to the workspace.** Run
   `tessl integrations show linear --workspace <workspace> --json`. If there is
   no connection, ask the user to connect Linear from workspace settings, under
   Integrations.
2. **The delegate id.** In that JSON, read `connectionData.agentAppUserId`.
   This is the Linear user id of the Tessl agent. A person starts the work by
   delegating an issue to this user. Use it as `<delegate-id>` in the trigger.
3. **A Linear team routes to this project.** Linear events reach the project
   only when a Linear team is mapped to it. Ask the user which team the factory
   should work on, and ask them to map that team to this project in workspace
   settings, under Integrations, Linear.

Tell the user how a person starts work: delegate a Linear issue to Tessl and
put it in a Todo (unstarted) state. Moving the issue out of Todo, or removing
the delegate, stops the work.
