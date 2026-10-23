// The site is static: `npm run build` writes every page into dist/, which is
// what gets deployed. `format: "file"` keeps the page names the plain HTML
// version had (tools.html, not tools/index.html), so old links still work.
// `site` is the published address, which the link preview tags in Page.astro
// build their absolute URLs from.
import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  site: "https://message-cp.vercel.app",
  output: "static",
  build: { format: "file" },
  vite: { plugins: [tailwindcss()] },
});
