---
name: review-scale-and-resilience
description: Review a code change for load, data-volume, concurrency, retry, rollout, dependency-failure, latency, throughput, timeout, and fault-tolerance risks. Use when reviewing for performance under load, scalability, resilience, or failure handling.
---

# Review lens: Scale and Resilience

Review what the change costs as load, data volume, and concurrency grow, and what it does when something it depends on fails.

## Scope

- **Performance** What the change does repeatedly that it could do once, and what it costs per unit of work.
- **Scalability** How that cost grows with the size of the input, the number of callers, or the depth of the data.
- **Stability** How the change behaves under realistic failure and rollout conditions: slow dependencies, duplicate execution, and deployments where old and new code run concurrently.
- **Availability** Whether a failure stays bounded, visible and recoverable, or turns a transient fault into a persistent or expanding one.

## Method

Prioritize work on request paths, fan-out operations, and batch processing.

Derive failure cases from the operations the change performs, including external calls, writes, and retries. Check behavior for delayed, duplicate, and missing responses.

Expected workload, and what counts as adequate failure coverage or a safe rollout, are often written project rules rather than judgment calls. Read the `AGENTS.md` or `CLAUDE.md` chain governing the changed files, from the repository root down, for the scale the project targets and for the storage, paging and concurrency trade-offs it has already decided.

## Threshold

Report costs that grow materially with expected workload, or failures that can affect work beyond the original request or operation. Measure growth against the scale the project documents, not an unbounded one. Do not report a cost that stays small at that scale, or a trade-off the project has written down as decided, unless the change departs from it or the decision does not cover the case. When a cost is real but bounded at the documented scale, report it as minor at most and say what bound holds it.

Do not report cold-path inefficiencies or scenarios that depend on several unlikely failures occurring together.

## Reporting

- Name what scales the cost, per request, per row, per user or per tenant, and its realistic upper bound at the scale the project documents; if you claim a scan or sort, check it against any query plan the change provides.
- For fan-out to dependencies, say whether one slow or failed dependency call can time out or fail the whole operation; do not present concurrency limiting as sufficient when the operation can be batched.
- For a failure, name the fault that triggers it and what breaks when it does.
- State what would contain it: the bound, the timeout, the checkpoint, the signal an operator would need.
