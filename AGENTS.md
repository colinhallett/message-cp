

# Agent Rules <!-- tessl-managed -->

@.tessl/RULES.md follow the [instructions](.tessl/RULES.md)

## Design constraints

memory-cp is a single-user server, reached over stdio on its own machine or over HTTPS by the same owner's agents elsewhere, with a handful to a few dozen agents. When review raises scale, paging or permission concerns, weigh them against that scale:

- Broadcast (`send_message` to `all`) reaches every registered agent; do not cap recipients.
- Paged tools (`list_agents`, `read_inbox`) use `limit` plus `offset`; keyset/cursor paging is out of scope unless a ticket asks for it.
- `openDb` creates a missing directory 0700 and database file 0600; it does not change permissions on existing user-created or configured locations.
- Small, contained bounds (an input-length cap, an index for an existing query) are welcome. A change to a documented contract, the config schema or all paging tools belongs in a follow-up issue: decline in the thread with the reason instead of pushing it.
