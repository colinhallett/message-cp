

# Agent Rules <!-- tessl-managed -->

@.tessl/RULES.md follow the [instructions](.tessl/RULES.md)

## Design constraints

memory-cp is a small server for a few people's agents, reached over stdio on its own machine or over HTTPS, with a handful to a few dozen agents per account. Agents and messages belong to accounts, and nothing may cross between accounts: a finding that one account can see or affect another account's data is always blocking. Other scale, paging or permission concerns are weighed against that scale:

- Broadcast (`send_message` to `all`) reaches every registered agent in the sender's account; do not cap recipients.
- Paged tools (`list_agents`, `read_inbox`) use `limit` plus `offset`; keyset/cursor paging is out of scope unless a ticket asks for it.
- `openDb` creates a missing directory 0700 and database file 0600; it does not change permissions on existing user-created or configured locations.
- Small, contained bounds (an input-length cap, an index for an existing query) are welcome. A change to a documented contract, the config schema or all paging tools belongs in a follow-up issue: decline in the thread with the reason instead of pushing it.
