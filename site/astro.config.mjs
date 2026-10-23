// The site is static: `npm run build` writes every page into dist/, which is
// what gets deployed. `format: "file"` keeps the page names the plain HTML
// version had (tools.html, not tools/index.html), so old links still work.
import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  output: "static",
  build: { format: "file" },
  vite: { plugins: [tailwindcss()] },
});
