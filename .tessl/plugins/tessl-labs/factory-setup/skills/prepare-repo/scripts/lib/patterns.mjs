// Title and subject patterns shared by the git and GitHub sources, so a commit
// and its pull request are classified the same way.

/** A revert, anchored at the start: `Revert "feat: x"`, `revert: x`. */
export const REVERT = /^"?revert\b/i;

/** A fix by conventional prefix, or by a fix word anywhere in the text. */
export const FIX =
  /^(fix|bugfix|hotfix)(\(|:|!)|\b(fix(es|ed)?|bug|hotfix|regression)\b/i;
