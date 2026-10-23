// Copies the pages in src/ into dist/, which is what gets deployed. There is
// nothing to compile: the pages are plain HTML and CSS.
import { cpSync, rmSync } from "node:fs";

const src = new URL("./src/", import.meta.url);
const dist = new URL("./dist/", import.meta.url);

rmSync(dist, { recursive: true, force: true });
cpSync(src, dist, { recursive: true });
console.log("built dist/");
