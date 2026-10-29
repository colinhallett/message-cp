# Agent context

How to change the repository's agent context files for the candidates routed
to context, without overwriting what the team already wrote. Context holds
knowledge an agent needs before it opens other files: the build, test, and
lint commands, a short map of the modules, hazards, and the picked rules that
are knowledge rather than a check.

Each section belongs to one step of the skill:

- **Steps 3 to 5 (propose):** "Read what is there", "What a context item
  adds", the questions in "Forwarders" and "Layout items", and the choice of
  file in "Monorepos" and "Project memory". Ask and plan only; write nothing.
- **Step 6 (apply):** "Edit an existing file", "Create a file that is
  missing", "Links", the files "Forwarders", "Monorepos", and "Project memory"
  say to create or edit, and "Before you finish", only for the items the user
  confirmed in step 5.

## Read what is there

Before you propose a change, read every context file step 1 listed, and the
files they include. Note for each one:

- whether it exists: `AGENTS.md`, `CLAUDE.md`, and any per-area copies;
- whether it is a symlink to the other; a symlinked pair counts as one file;
- whether one forwards to or includes the other, such as a `CLAUDE.md` whose
  only line is `@AGENTS.md`, or one that has its own instructions and also
  includes `@AGENTS.md`;
- its length in lines;
- its headings, and which sections a tool manages, such as the section
  `tessl install` marks `<!-- tessl-managed -->`;
- the commands it names, and whether each one still exists in the package
  scripts, `Makefile`, or CI.

Read the dev container and setup scripts too, and note each command they run
that no longer works.

Pick one canonical file, the file new items go into:

- One file forwards to the other: the file it forwards to.
- `CLAUDE.md` holds the team's instructions and includes `@AGENTS.md`, and
  `AGENTS.md` holds only a tool-managed section. This is the layout
  `tessl install` leaves when `CLAUDE.md` already existed. `AGENTS.md` is
  canonical: add new items there, outside the managed section. Propose moving
  the instructions already in `CLAUDE.md` as a
  [layout item](#layout-items), as for a `CLAUDE.md` with no `AGENTS.md`.
- Both hold the team's instructions and neither forwards: flag what they
  disagree on as a contradiction, following
  [routing](routing.md#contradictions). Decide the layout yourself and propose
  it as a [layout item](#layout-items): merge the other file's instructions
  into `AGENTS.md` and replace the other file with its
  [forwarder](#forwarders). When merging would lose instructions that only
  one agent should see, keep both instead, and add each item to both files,
  under the heading it fits in each.

## What a context item adds

Each confirmed context item becomes one of these, and nothing else:

- **Commands:** one line for each of install, build, test, and lint. Look
  for each in CI, the task runner and package config, the contributing guide,
  and the dev container or setup scripts, and use the one CI runs when CI
  runs one. Leave out a category only when no place has it; do not invent a
  command for it. Name the fast check an agent runs before each commit, when
  there is one.
- **Broken setup:** a dev container or setup script that runs a command that
  no longer works, such as one installing from a file that no longer exists,
  is its own item: fix it to run the install command above.
- **Module map:** one line per top-level module or area, saying what lives
  there and when to open it. Link to a deeper doc rather than describing it.
- **Hazards:** generated or vendored files, each paired with the command that
  regenerates it; concerns owned by one place, linked to that place; and
  boundaries not to cross, linked to the check that enforces them, when one
  exists.
- **Exemplars:** for a common change type, the file to copy, such as "a new
  route: copy `src/routes/users.ts`".
- **A picked rule:** the rule in one sentence, under the heading it belongs
  to.

Keep a line only if deleting it would cause an agent to make a mistake. Do not
add general advice, language or framework conventions, history, or plans.

## Edit an existing file

Change the canonical file in place:

- Keep the team's headings, wording, and order. Add each item under the
  heading it fits. Add a heading only when none fits.
- Do not rewrite, reword, or move lines you were not asked to change. Remove a
  line only when the picked item is that removal, as
  [routing](routing.md#one-home-per-rule) describes.
- Leave sections a tool manages exactly as they are.
- Skip an item the file already states, and tell the user.

Keep the file within a budget of 150 lines. When an addition would take it
over, put the detail in a doc under the area's documentation and add a
one-line link to it. When the file is already over the budget, add only
one-line links and tell the user how long it is.

## Create a file that is missing

When the repository has neither `AGENTS.md` nor `CLAUDE.md`, create
`AGENTS.md` with only the sections the picked items fill, in this order:

1. a title and one to three sentences on what the repository is;
2. essential knowledge: the working directory, the stack, and anything an
   agent must know before it opens another file;
3. do not touch: hazards, generated files first;
4. commands;
5. map: one-line links to deeper docs.

Do not copy placeholders or template comments into the file.

## Links

Use plain Markdown links, `[text](path)`, for docs an agent opens when it
needs them. Claude Code loads any `@path` outside a code span into every
session, whether it sits on its own line or inside a sentence, so count inline
`@path` mentions as includes when you read a file. Use `@path` only for
includes the team already has and for `@AGENTS.md` in a forwarder.

## Forwarders

Make both harnesses read the same file:

- `AGENTS.md` but no `CLAUDE.md`: create `CLAUDE.md` with the single line
  `@AGENTS.md`.
- `CLAUDE.md` but no `AGENTS.md`: `AGENTS.md` has no include line, so a
  forwarder there is only a link an agent may not follow. Propose, as a
  layout item, moving the instructions from `CLAUDE.md` into a new
  `AGENTS.md` and making `CLAUDE.md` the `@AGENTS.md` forwarder. If the user
  drops that item, create `AGENTS.md` with the single line
  `Before you start, read [CLAUDE.md](CLAUDE.md); it holds this repository's agent instructions.`
  instead.
- Neither: create `AGENTS.md` as above, and the `CLAUDE.md` forwarder.

A forwarder has that one line and nothing else. Move the team's instructions
from one file to the other only through a layout item the user kept.

### Layout items

Creating a forwarder, merging two files, and moving instructions from one file
to another are each their own numbered item in the agent context group of the
step 5 list. The item says which files it creates or replaces, for example
"creates `CLAUDE.md` with `@AGENTS.md`" or "moves 40 lines from `CLAUDE.md`
into a new `AGENTS.md` and replaces `CLAUDE.md` with `@AGENTS.md`". Like any
item, it is applied unless the user drops it, whether or not they drop other
context items.

## Monorepos

When the repository holds several projects or packages:

- Keep the root file a short map: one line per area, linking to its file,
  plus the rules that apply to every area.
- Put a rule in the file of the narrowest area its evidence comes from,
  `<area>/AGENTS.md`.
- Treat each area's files as you treat the root's: read what is there, pick
  the canonical file, and handle forwarders the same way. Propose a new
  `<area>/AGENTS.md` with its `CLAUDE.md` forwarder only when the area has
  neither file.
- Put the area's commands in the area's file, run from that directory.

## Project memory

Preferences about how the team works, such as its agents, CI and secrets,
issue tracker, and goals, belong in project memory under `.tessl/memory/`, not
in context files. Decide how to handle them when you route, before step 5:

Propose each memory item as a one-line edit to the matching file, and show
that line in the step 5 item: goals go in `.tessl/memory/goals.md`, and other
preferences in the matching file under `.tessl/memory/preferences/`. Write the
line directly; do not hand it to `setup-memory`, which is in the private
`tessl/harness-engineering` plugin and cannot be installed. When the file does
not exist yet, the item creates it with only that line, and also adds a link
to it under `## Active Memory Files` in `.tessl/memory/index.md`, creating the
index with that heading if needed, so agents that read the index find the
file. The step 5 item shows both edits.

## Before you finish

Check the files you changed:

- every link points at a file that exists;
- every command you added runs, or appears in CI or the package scripts;
- the canonical file and its forwarder agree, and no confirmed rule contradicts
  another context file;
- every file you edited is within the budget, or was already over it and
  gained only one-line links.
