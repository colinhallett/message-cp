# Adopting the lenses

A repository with no `.tessl-code-review.yml` on its default branch is reviewed with the default lenses from the registry, so there is nothing in the repository to tune. The adoption finding proposes copying them in.

## What to find out first

- **Which lenses, from which plugin and version.** Decode the `lenses:v1` refs on recent review comments, such as `tessl/code-review@0.5.0#review-scale-and-resilience`: the part before `#` is the plugin and version, the part after is the lens. List every lens the reviews used.
- **How to route them.** Install that plugin outside the repository, as [What to read](../SKILL.md#what-to-read) says, and read its `code-review` skill's `references/repository-profile.md`: it gives the profile's schema and how it recommends routing each lens. Use the lens names and routing it gives, not names remembered from elsewhere.
- **The repository's layout.** Which directories hold agent plugins (a `.tessl-plugin/` directory), where Markdown lives, and what is installed rather than written here (such as `.tessl/plugins/`).
- **Who can merge without the owner.** Read `CODEOWNERS`, branch rules if you can, and the repository's agent guidance for files only people may change.

## The finding

- `title`: "Adopt the default code review lenses so they can be tuned".
- `tags`: `["code-review-lens", "adopt-lenses"]`.
- `analysis`: why tuning is worth it: the counts per lens, and the clearest pattern you found.
- `recommendation`, concretely:
  1. Copy each lens the reviews use, unchanged, from `<workspace>/<plugin>@<version>` into `review-lenses/<lens name>/`: its `SKILL.md` and anything beside it.
  2. Add `.tessl-code-review.yml` with `schemaVersion: 1`, an `ignore` list that keeps installed plugins out (such as `.tessl/plugins/**`), and one `lenses` entry per lens with its local `ref` (`./review-lenses/<lens name>/SKILL.md`) and the `globs` the plugin's reference recommends for it, written for this repository's directories, with `!` globs so each file has one owner per concern. Leave out `requestChangesAt` and `effort`, so reviews behave as they do now.
  3. Before merging, check it: `tessl code review --profile ./.tessl-code-review.yml --base <a recent commit>~1 --head <that commit> --json` reports `"status": "ok"` and lists every local lens.
  4. Make the profile and `review-lenses/` the owner's: once the profile is on the default branch, a pull request from an author with write access, or a GitHub App, is reviewed with its own copy of them, so anything that can merge without the owner's review, such as an automation or an agent, must not change them. Name the repository's way of enforcing it, such as `CODEOWNERS` with required code owner reviews.
  5. The first lens edits the evidence supports, to make after the copy as separate changes, so reviews match today's right after adoption.
- `expectedImprovement`: lens edits become possible, and the first ones should reduce the declined findings named in the analysis.
