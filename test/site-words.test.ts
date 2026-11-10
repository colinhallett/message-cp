import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const LIMIT = 6000;

// The same count as `cat site/src/pages/*.astro site/public/setup.md site/public/llms.txt | sed -e "s/<[^>]*>//g" | wc -w`:
// the files joined as `cat` joins them, tags stripped line by line as `sed` does, and words split on ASCII whitespace
// as `wc -w` does in the C locale (some `wc` builds also split on Unicode spaces, which the site has none of).
function siteWords(): number {
  const pages = readdirSync(join(root, "site/src/pages"))
    .filter((f) => f.endsWith(".astro"))
    .sort()
    .map((f) => join("site/src/pages", f));
  const text = [...pages, "site/public/setup.md", "site/public/llms.txt"].map((f) => readFileSync(join(root, f), "utf8")).join("");
  const stripped = text
    .split("\n")
    .map((line) => line.replace(/<[^>]*>/g, ""))
    .join("\n");
  return stripped.split(/[ \t\n\v\f\r]+/).filter(Boolean).length;
}

it(`keeps the site, setup.md and llms.txt under ${LIMIT} words together (DIRECTION.md)`, () => {
  const total = siteWords();
  expect(total, `the site, setup.md and llms.txt come to ${total} words, over the limit of ${LIMIT}`).toBeLessThanOrEqual(LIMIT);
});
