# Check permissions

Check only what setup still has to do. If the Tessl App can already
write to the repository, the user does not need the right to connect it.

| Step still to do                           | Needs                                                       | Read it from                                                |
| ------------------------------------------ | ----------------------------------------------------------- | ----------------------------------------------------------- |
| Link or create the project                 | `edit` in the workspace                                     | `allowedActions` for it in `tessl workspace list --json`    |
| Connect the Tessl App or Review            | `manage_integrations` in the org                            | `data.meta.allowedActions` in `tessl api /v1/orgs/<org id>` |
| Create the cloud environment               | `environment.write` in the org                              | the same org `allowedActions`                               |
| Set up automations in Tessl the first time | `environment.write` in the org, and `edit` in the workspace | the same lists                                              |

Publisher or above in the workspace gives `edit`; organization admin gives the
other two. Without `manage_integrations`, an app install becomes a request an
admin approves. Setup never creates a workspace: if none the user can see
gives `edit`, an organization admin has to create one or add them to one. Do
not take a permission from seeing an organization or from the person's role
in the web app; if a list cannot be read, say so and let the step's own
command decide.

When something is missing, send one message the user can forward to an admin:
which account needs which role, in which workspace or organization, and for
which step. Show the timeline with "Check your setup" marked `◐`, and check
again once the user says it is done.
