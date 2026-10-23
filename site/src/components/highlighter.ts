// One Shiki highlighter for the whole build, rather than one per code block.
import { createCssVariablesTheme, createHighlighter } from "shiki";

export const theme = createCssVariablesTheme({ name: "site", variablePrefix: "--code-", fontStyle: true });

export const highlighter = createHighlighter({
  themes: [theme],
  langs: ["shellscript", "json", "javascript", "nginx"],
});
