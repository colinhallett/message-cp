# Testing the factory

Test only the parts the user set up. Pick a test the user is comfortable
with. If they have a real ticket or job in mind and it is small, use that.
If not, propose a small, safe change, such as a README fix. Ask before you
create each issue or comment, because people on the repo will see them.

Before each wait, tell the user how long it usually takes (a run starts
about 90 seconds after the event and takes 5 to 10 minutes), and where to
watch it: the run in the loop's page in the Tessl web app. If the web app and
these checks disagree, trust the web app and say so.

1. **Check the loops exist.** Ask the user to open the project's Loops tab in
   the Tessl web app and confirm the new loops are there. If they are missing,
   check that the merge was to the default branch and that the environment
   name in `tessl.json` matches the environment you created.
2. **Ship tickets.** Use the ticket you agreed on. Then:
   - GitHub Issues: `gh issue create` with that change, then
     `gh issue edit <n> --add-label tessl`.
   - Linear: create the issue in the routed team, delegate it to Tessl, and
     leave it in Todo.

   Within a few minutes the issue gets a "Tessl is working on this" comment,
   then a pull request on a `tessl/` branch with the `tessl` label.

3. **Keep pull requests moving.** On that pull request, leave a review comment that asks
   for one small change. Within a few minutes the shepherd replies, pushes the
   change, and resolves the thread.
4. **Code Review.** Confirm the review appears on the pull request.
5. **Own skill or schedule.** For a trigger, make the event happen once, for
   example file a test ticket. For a schedule, run it once now with
   `tessl schedule trigger <id>`, with the id from `tessl schedule list`.
   Then show the user what the agent did.

To wait, run one of these commands once a minute. Tessl's own comments end
with `<!-- tessl-factory -->`, so match on that, not on the author. Do not
write a polling script.

- **Started:** the issue has a comment that contains `tessl-factory`.
- **Pull request opened:**
  `gh pr list --state all --search "head:tessl/issue-<n>" --json number,url`.
  For Linear, the branch is `tessl/<identifier in lowercase>`.
- **Shepherd replied:** a review comment on the pull request
  (`gh api repos/<owner>/<repo>/pulls/<pr>/comments`) or a pull request
  comment whose body contains `tessl-factory`. Comments from Code Review do
  not count.
- **Shepherd pushed:** the pull request has a new commit.

Report the issue and pull request links to the user. If nothing happens after
10 minutes, ask the user to open the loop in the web app and check its runs.
