# Triggers reference

These are the `tessl.json` entries for each starter. "Ship tickets", "answer
reviews and fix checks", "follow ticket changes", and Learn from past work are
normally [set up in Tessl](set-up-in-tessl.md) instead, with no entries here; use
these entries for them only when the person wants them in `tessl.json`.

Replace `<env>` with the environment name and `<user-id>` with the GitHub user
ID of the person setting up (`gh api user --jq .id`). Write
`{{ linear.tesslApp.userId }}` exactly as shown: Tessl replaces it with the Tessl
agent's Linear user id from the workspace's Linear connection. Add the actions
under `actions` and the triggers under `triggers`. If `tessl.json` already has an
action or trigger with the same name as one you are adding, ask the user before
you replace it.

The agents get write access to the repository, so GitHub triggers started by a
person's action match `event.sender.id`, except for the issue-label start
trigger described below: only the people listed there can start those runs,
even on a public repository. Use the same list in every sender-filtered trigger.
To let more people start them, list their IDs:
`"event.sender.id": { "in": [<user-id>, <other-id>] }`. Find someone's ID with
`gh api users/<login> --jq .id`. When Code Review is on or chosen, also add
`shepherd-pr-review-by-reviewer`, which matches reviews by the Tessl Reviewer
bot; leave it out otherwise. Write `{{ github.tesslReviewerApp.userId }}` in it
exactly as shown: Tessl replaces it with the Reviewer bot's GitHub user ID from
the workspace's Tessl Reviewer connection. Never put it in another trigger's
sender list: when the workspace has no Reviewer connection, a condition that
names it fails, and the people in that list could no longer start runs.
"Issue to PR with GitHub Issues" uses one `github-issue-labelled` trigger with
no sender restriction: any person, bot, or app that can apply the `tessl` label
to an open issue can start Implement. This includes Tessl filing a test issue
from the web and waking an issue after a reply. Keep existing sender filters on
shepherd, comment, and `issues.unlabeled` triggers: Tessl removes the label to
wake an issue, and that must not cancel its runs.
Every trigger whose event names the pull request's head also matches
`<repo-id>`, the repository's ID from `gh api repos/<owner>/<repo> --jq .id`, so
a pull request from a fork whose branch also starts with `tessl/` starts
nothing. A PR comment's event has no head; the shepherd itself stops on a pull
request from a fork. The triggers that start implementation on an issue and
wake it on a reply match only open issues; the one for a closed issue matches
closed ones, so it can close Tessl's pull request.

Every trigger passes the issue or pull request it is about to its action as an
input, mapped from its own event in the trigger's `inputs`. No entry in the
`actions` block reads `event.`; only a trigger's `inputs` do. The implement and
shepherd actions declare their concurrency key on the action, read from that
input, so every trigger that starts one shares one lane, at most one run at a
time, for the same issue or pull request. Those triggers declare no
concurrency of their own.

A declared action can choose its run settings from its inputs:

- **`overlays`**: named sets of settings. Each takes the fields a trigger's
  `use` override takes, except `tags` and `concurrency`, by the same rule: a
  value replaces the action's, `null` removes it, `inputs` merges by name.
- **`selectOverlays`**: templates such as `"estimate-{{ inputs.ESTIMATE }}"`,
  rendered against the inputs the run is given. One that renders to exactly an
  overlay's name applies it; any other applies nothing. A selector without
  `{{ }}` must name a declared overlay, and an overlay's name never holds `{{`.
- **`params`**: per input, `"string"` (required: with no value it refuses the
  run, whether or not a template reads it; an input with no entry refuses only
  when a template reads it), or
  `{ "type": "string", "optional": true, "actionOnly": true }`.
  An optional input with no value reads as empty text and is left out of the
  skill's inputs; an `actionOnly` input never reaches the skill.

Settings layer in this order, later winning: the action's own, the selected
overlays in selector order, the trigger's or schedule's `use` fields, then the
request's fields, such as `tessl action trigger --model`. An action written
inline in a trigger or schedule cannot set these fields.

New implement, shepherd, and Learn from past work actions use Claude Opus 5.5. The follow-ticket-changes action
does small bookkeeping jobs, so it uses Codex with GPT-6 Luna. The user can
change the model or remove it. Removing it uses the platform default instead.
Before you write a pair, confirm that `tessl launch models --json` lists it for
this workspace; it spells `claude` as `claude-code` and `tessl` as
`tessl-agent`, and never name a model it does not list. When its `default` is
not `null`, removing `model` runs that pair.

## Issue to PR with Linear

```json
"actions": {
  "implement-linear": {
    "skill": "tessl-labs/factory#implement-linear",
    "environment": "<env>",
    "agent": "claude",
    "model": "claude-opus-5-5",
    "concurrency": {
      "keys": ["implement:linear-issue:{{ inputs.LINEAR_ISSUE_IDENTIFIER }}"]
    }
  }
},
"triggers": {
  "linear-issue-delegated": {
    "on": ["linear:Issue.create", "linear:Issue.update"],
    "when": {
      "event.data.delegateId": "{{ linear.tesslApp.userId }}",
      "event.data.state.type": "unstarted"
    },
    "action": {
      "use": "implement-linear",
      "inputs": { "LINEAR_ISSUE_IDENTIFIER": "{{ event.data.identifier }}" }
    }
  }
}
```

## Issue to PR with GitHub Issues

```json
"actions": {
  "implement-github-issue": {
    "skill": "tessl-labs/factory#implement-github-issue",
    "environment": "<env>",
    "agent": "claude",
    "model": "claude-opus-5-5",
    "concurrency": {
      "keys": ["implement:github-issue:{{ inputs.GITHUB_ISSUE_NUMBER }}"]
    }
  }
},
"triggers": {
  "github-issue-labelled": {
    "on": ["github:issues.labeled"],
    "when": {
      "event.label.name": "tessl",
      "event.issue.state": "open"
    },
    "action": {
      "use": "implement-github-issue",
      "inputs": { "GITHUB_ISSUE_NUMBER": "{{ event.issue.number }}" }
    }
  }
}
```

## PR shepherding

The implement skills open pull requests with the `tessl` label on a `tessl/`
branch. `shepherd-pr-review`, `shepherd-pr-review-by-reviewer` and
`shepherd-pr-review-comment` match both the label and the branch.
`shepherd-pr-comment` matches only the label; the shepherd then stops without
acting on a pull request that is not on a `tessl/` branch.
`shepherd-checks-failed` and `shepherd-checks-passed` match only the `tessl/`
branch, not the label, so removing the label does not stop them.
To turn the shepherd off, remove the `shepherd` action and all of its
triggers: five, or six with Code Review. That prevents new rounds; it does not
cancel one in progress.

```json
"actions": {
  "shepherd": {
    "skill": "tessl-labs/factory#shepherd",
    "environment": "<env>",
    "agent": "claude",
    "model": "claude-opus-5-5",
    "concurrency": {
      "debounce": "90s",
      "keys": ["github:pr:{{ inputs.GITHUB_PR_NUMBER }}"]
    }
  }
},
"triggers": {
  "shepherd-pr-review": {
    "on": ["github:pull_request_review.submitted"],
    "when": {
      "event.pull_request.labels.*.name": { "any": { "equals": "tessl" } },
      "event.pull_request.head.ref": { "matches": "^tessl/" },
      "event.pull_request.head.repo.id": <repo-id>,
      "event.pull_request.state": "open",
      "event.sender.id": <user-id>
    },
    "action": {
      "use": "shepherd",
      "inputs": { "GITHUB_PR_NUMBER": "{{ event.pull_request.number }}" }
    }
  },
  "shepherd-pr-review-comment": {
    "on": ["github:pull_request_review_comment.created"],
    "when": {
      "event.pull_request.labels.*.name": { "any": { "equals": "tessl" } },
      "event.pull_request.head.ref": { "matches": "^tessl/" },
      "event.pull_request.head.repo.id": <repo-id>,
      "event.pull_request.state": "open",
      "event.sender.id": <user-id>
    },
    "action": {
      "use": "shepherd",
      "inputs": { "GITHUB_PR_NUMBER": "{{ event.pull_request.number }}" }
    }
  },
  "shepherd-pr-comment": {
    "on": ["github:issue_comment.created"],
    "when": {
      "isPullRequest": "true",
      "event.issue.labels.*.name": { "any": { "equals": "tessl" } },
      "event.issue.state": "open",
      "event.sender.id": <user-id>
    },
    "action": {
      "use": "shepherd",
      "inputs": { "GITHUB_PR_NUMBER": "{{ event.issue.number }}" }
    }
  },
  "shepherd-checks-failed": {
    "on": ["github:check_run.completed"],
    "when": {
      "event.check_run.pull_requests.0.number": { "exists": true },
      "event.check_run.pull_requests.0.head.repo.id": <repo-id>,
      "event.check_run.check_suite.head_branch": { "matches": "^tessl/" },
      "event.check_run.conclusion": {
        "in": ["failure", "timed_out", "startup_failure", "action_required"]
      }
    },
    "action": {
      "use": "shepherd",
      "inputs": { "GITHUB_PR_NUMBER": "{{ event.check_run.pull_requests.0.number }}" }
    }
  },
  "shepherd-checks-passed": {
    "on": ["github:check_suite.completed"],
    "when": {
      "event.check_suite.pull_requests.0.number": { "exists": true },
      "event.check_suite.pull_requests.0.head.repo.id": <repo-id>,
      "event.check_suite.head_branch": { "matches": "^tessl/" },
      "event.check_suite.conclusion": "success"
    },
    "action": {
      "use": "shepherd",
      "inputs": { "GITHUB_PR_NUMBER": "{{ event.check_suite.pull_requests.0.number }}" }
    }
  }
}
```

When Code Review is on or chosen, also add `shepherd-pr-review-by-reviewer`
to the same `triggers`; leave it out otherwise.

```json
"triggers": {
  "shepherd-pr-review-by-reviewer": {
    "on": ["github:pull_request_review.submitted"],
    "when": {
      "event.pull_request.labels.*.name": { "any": { "equals": "tessl" } },
      "event.pull_request.head.ref": { "matches": "^tessl/" },
      "event.pull_request.head.repo.id": <repo-id>,
      "event.pull_request.state": "open",
      "event.sender.id": "{{ github.tesslReviewerApp.userId }}"
    },
    "action": {
      "use": "shepherd",
      "inputs": { "GITHUB_PR_NUMBER": "{{ event.pull_request.number }}" }
    }
  }
}
```

A Linear issue to PR setup with shepherding also needs `--linear-access` on
the environment, because the shepherd reads the Linear issue.

## Merge conflict sweep

Opt-in: add it only when the person asks for it. After each push to the
default branch, it finds Tessl's open pull requests that now conflict with
that branch and starts one `shepherd` round for each one whose issue Tessl is
still working on, so `shepherd` starts on the conflict without waiting for a
review or a check to wake it. It reads GitHub and Linear and starts `shepherd`; it never writes to a
pull request or an issue.

Add the sweep only when `shepherd` is declared in `tessl.json`. The sweep
wakes `shepherd` by its action name, and that finds only actions declared in
`tessl.json`, so a factory set up in Tessl cannot run the sweep yet. For such a
factory, add neither the sweep nor a `shepherd` action to `tessl.json`: a
factory runs from Tessl or from `tessl.json`, never both.

Replace `<default-branch>` with the repository's default branch. Write
`{{ github.tesslApp.userId }}` and `{{ linear.tesslApp.userId }}` exactly as
shown: Tessl replaces them with the Tessl app's GitHub and Linear user ids.
For a GitHub Issues factory, leave out `LINEAR_TESSL_APP_USER_ID`: without a
Linear connection its placeholder does not resolve and the run is refused.
When the implement trigger uses a label other than `tessl`, set
`GITHUB_ISSUE_LABEL` to it. The trigger runs one sweep at a time per repository and gathers a burst of
pushes into one.

```json
"actions": {
  "merge-conflict-sweep": {
    "skill": "tessl-labs/factory#merge-conflict-sweep",
    "environment": "<sweep-env>",
    "agent": "codex",
    "model": "gpt-6-luna",
    "timeout": "2h",
    "inputs": {
      "GITHUB_AUTHOR_IDS": "{{ github.tesslApp.userId }}",
      "LINEAR_TESSL_APP_USER_ID": "{{ linear.tesslApp.userId }}"
    }
  }
},
"triggers": {
  "merge-conflict-sweep": {
    "on": ["github:push"],
    "when": { "event.ref": "refs/heads/<default-branch>" },
    "concurrency": {
      "keys": [
        { "key": "merge-conflict-sweep:{{ event.repository.id }}", "limit": 1 }
      ],
      "debounce": "5m"
    },
    "action": "merge-conflict-sweep"
  }
}
```

`<sweep-env>` is an environment with `--github-access read`,
`--action-trigger project` so the sweep can start `shepherd`, and, for a
Linear factory, `--linear-access read`. Create one with
`tessl environment create`, or update one with `tessl environment update`.
Do not give it the implement environment's write access. Try it once with
`tessl action trigger merge-conflict-sweep --input DRY_RUN=true`, which
reports what it would start and starts nothing.

## Follow ticket changes

One small loop keeps the factory in step with what people do. Add it with
"Issue to PR", in the same `tessl.json` change and the same environment. Each
trigger tells the skill what happened through the `TICKET_CHANGE` input:

- `taken-back`: a person takes an issue back, so cancel its runs.
- `issue-ended`: a person ends an issue, so close its open pull request and
  wake the issues it was blocking.
- `replied`: a person answers Tessl's question, so wake the issue.
- `pr-closed`: a Tessl pull request closes, so cancel its runs.

```json
"actions": {
  "follow-ticket-changes": {
    "skill": "tessl-labs/factory#follow-ticket-changes",
    "environment": "<env>",
    "agent": "codex",
    "model": "gpt-6-luna"
  }
}
```

Unlike implement and shepherd, the follow-ticket-changes action declares no
key; each of its triggers declares its own, read from the input it passes. The
`replied` triggers use the implement action's key, so a wake never runs at the
same time as an implement round on the same issue. The others use their own
key, so a cancellation never waits behind the run it cancels. A run holds its
action's keys as well as its trigger's, so a key on this action would put an
issue's cancellations in the same lane as its wakes and implement rounds.

### With Linear

```json
"triggers": {
  "follow-ticket-changes-linear-taken-back": {
    "on": [
      "linear:Issue.update"
    ],
    "when": {
      "event.data.delegateId": "{{ linear.tesslApp.userId }}",
      "event.actor.id": {
        "not": {
          "equals": "{{ linear.tesslApp.userId }}"
        }
      },
      "event.updatedFrom.stateId": {
        "exists": true
      },
      "event.data.state.type": {
        "in": [
          "backlog",
          "triage"
        ]
      }
    },
    "concurrency": {
      "keys": [
        "follow-ticket-changes:linear-issue:{{ inputs.LINEAR_ISSUE_IDENTIFIER }}"
      ]
    },
    "action": {
      "use": "follow-ticket-changes",
      "inputs": {
        "TICKET_CHANGE": "taken-back",
        "LINEAR_ISSUE_IDENTIFIER": "{{ event.data.identifier }}"
      }
    }
  },
  "follow-ticket-changes-linear-ended": {
    "on": [
      "linear:Issue.update"
    ],
    "when": {
      "event.data.delegateId": "{{ linear.tesslApp.userId }}",
      "event.actor.id": {
        "not": {
          "equals": "{{ linear.tesslApp.userId }}"
        }
      },
      "event.updatedFrom.stateId": {
        "exists": true
      },
      "event.data.state.type": {
        "in": [
          "completed",
          "canceled",
          "duplicate"
        ]
      }
    },
    "concurrency": {
      "keys": [
        "follow-ticket-changes:linear-issue:{{ inputs.LINEAR_ISSUE_IDENTIFIER }}"
      ]
    },
    "action": {
      "use": "follow-ticket-changes",
      "inputs": {
        "TICKET_CHANGE": "issue-ended",
        "LINEAR_ISSUE_IDENTIFIER": "{{ event.data.identifier }}"
      }
    }
  },
  "follow-ticket-changes-linear-replied": {
    "on": [
      "linear:AgentSessionEvent.prompted"
    ],
    "when": {
      "event.appUserId": "{{ linear.tesslApp.userId }}",
      "event.agentActivity.signal": {
        "not": {
          "equals": "stop"
        }
      }
    },
    "concurrency": {
      "keys": [
        "implement:linear-issue:{{ inputs.LINEAR_ISSUE_IDENTIFIER }}"
      ]
    },
    "action": {
      "use": "follow-ticket-changes",
      "inputs": {
        "TICKET_CHANGE": "replied",
        "LINEAR_ISSUE_IDENTIFIER": "{{ event.agentSession.issue.identifier }}"
      }
    }
  },
  "follow-ticket-changes-pr-closed": {
    "on": [
      "github:pull_request.closed"
    ],
    "when": {
      "event.pull_request.labels.*.name": {
        "any": {
          "equals": "tessl"
        }
      },
      "event.pull_request.head.ref": {
        "matches": "^tessl/"
      },
      "event.sender.id": <user-id>,
      "event.pull_request.head.repo.id": <repo-id>
    },
    "concurrency": {
      "keys": [
        "follow-ticket-changes:github-pr:{{ inputs.GITHUB_PR_NUMBER }}"
      ]
    },
    "action": {
      "use": "follow-ticket-changes",
      "inputs": {
        "TICKET_CHANGE": "pr-closed",
        "GITHUB_PR_NUMBER": "{{ event.pull_request.number }}"
      }
    }
  }
}
```

Wakes from blockers happen only when an issue delegated to Tessl ends: when a
person finishes the last open blocker themselves, the dependent waits until a
person moves it. A reply wakes an issue only through Tessl's agent session.

### With GitHub Issues

```json
"triggers": {
  "follow-ticket-changes-github-taken-back": {
    "on": [
      "github:issues.unlabeled"
    ],
    "when": {
      "event.label.name": "tessl",
      "event.sender.id": <user-id>
    },
    "concurrency": {
      "keys": [
        "follow-ticket-changes:github-issue:{{ inputs.GITHUB_ISSUE_NUMBER }}"
      ]
    },
    "action": {
      "use": "follow-ticket-changes",
      "inputs": {
        "TICKET_CHANGE": "taken-back",
        "GITHUB_ISSUE_NUMBER": "{{ event.issue.number }}"
      }
    }
  },
  "follow-ticket-changes-github-ended": {
    "on": [
      "github:issues.closed"
    ],
    "when": {
      "event.issue.labels.*.name": {
        "any": {
          "equals": "tessl"
        }
      },
      "event.sender.id": <user-id>
    },
    "concurrency": {
      "keys": [
        "follow-ticket-changes:github-issue:{{ inputs.GITHUB_ISSUE_NUMBER }}"
      ]
    },
    "action": {
      "use": "follow-ticket-changes",
      "inputs": {
        "TICKET_CHANGE": "issue-ended",
        "GITHUB_ISSUE_NUMBER": "{{ event.issue.number }}"
      }
    }
  },
  "follow-ticket-changes-github-replied": {
    "on": [
      "github:issue_comment.created"
    ],
    "when": {
      "isPullRequest": "false",
      "event.issue.state": "open",
      "event.issue.labels.*.name": {
        "any": {
          "equals": "tessl"
        }
      },
      "event.sender.id": <user-id>
    },
    "concurrency": {
      "keys": [
        "implement:github-issue:{{ inputs.GITHUB_ISSUE_NUMBER }}"
      ]
    },
    "action": {
      "use": "follow-ticket-changes",
      "inputs": {
        "TICKET_CHANGE": "replied",
        "GITHUB_ISSUE_NUMBER": "{{ event.issue.number }}"
      }
    }
  },
  "follow-ticket-changes-pr-closed": {
    "on": [
      "github:pull_request.closed"
    ],
    "when": {
      "event.pull_request.labels.*.name": {
        "any": {
          "equals": "tessl"
        }
      },
      "event.pull_request.head.ref": {
        "matches": "^tessl/"
      },
      "event.sender.id": <user-id>,
      "event.pull_request.head.repo.id": <repo-id>
    },
    "concurrency": {
      "keys": [
        "follow-ticket-changes:github-pr:{{ inputs.GITHUB_PR_NUMBER }}"
      ]
    },
    "action": {
      "use": "follow-ticket-changes",
      "inputs": {
        "TICKET_CHANGE": "pr-closed",
        "GITHUB_PR_NUMBER": "{{ event.pull_request.number }}"
      }
    }
  }
}
```

Tessl removes and adds the label itself to wake an issue. The `event.sender.id`
filter keeps those changes from starting `follow-ticket-changes-github-taken-back`.

To turn the follow-ticket-changes loop off, remove its action and triggers. Without it,
Tessl still stops at its next round when a person takes an issue back, but
runs in progress finish, open pull requests stay open, and a blocked or
waiting issue stays put until a person moves it.

## Learn from past work

Replace `<org-id>` with the organization's `id` from `tessl org list --json`
and `<project-id>` with `linkedProject.id` from `tessl project repair --json`.
Each runs weekly, on its own day, with the environment from
[Learn from past work](starters.md#learn-from-past-work), except
`turn-findings-into-tickets`, which files tickets and so runs with an
environment that can write a GitHub or Linear issue (`<ticket-env>`), usually
the one the factory's implement action uses.

```json
"schedules": {
  "learn-from-review-feedback": {
    "cron": "0 6 * * 1",
    "description": "Find review feedback that agent context or a verifier could prevent",
    "action": {
      "skill": "tessl-labs/learn-from-past-work#learn-from-review-feedback",
      "environment": "<env>",
      "agent": "claude",
      "model": "claude-opus-5-5",
      "inputs": { "orgId": "<org-id>", "projectId": "<project-id>" }
    }
  },
  "learn-from-agent-runs": {
    "cron": "0 6 * * 3",
    "description": "Find problems that recur across recent agent runs",
    "action": {
      "skill": "tessl-labs/learn-from-past-work#learn-from-agent-runs",
      "environment": "<env>",
      "agent": "claude",
      "model": "claude-opus-5-5",
      "inputs": { "orgId": "<org-id>", "projectId": "<project-id>", "windowDays": "7" }
    }
  },
  "tune-review-lenses": {
    "cron": "0 6 * * 5",
    "description": "Propose Code Review lens changes from how the lenses did",
    "action": {
      "skill": "tessl-labs/learn-from-past-work#tune-review-lenses",
      "environment": "<env>",
      "agent": "claude",
      "model": "claude-opus-5-5",
      "inputs": { "orgId": "<org-id>", "projectId": "<project-id>" }
    }
  },
  "turn-findings-into-tickets": {
    "cron": "0 6 * * 6",
    "description": "Turn open findings into tickets the factory builds",
    "action": {
      "skill": "tessl-labs/learn-from-past-work#findings-triage",
      "environment": "<ticket-env>",
      "agent": "claude",
      "model": "claude-opus-5-5",
      "inputs": { "orgId": "<org-id>", "projectId": "<project-id>" },
      "concurrency": {
        "keys": [{ "key": "turn-findings-into-tickets", "limit": 1 }]
      }
    }
  }
}
```

`windowDays` is how many days of runs Learn from agent runs reads, from 1 to 30. Keep it
equal to the days between runs.
