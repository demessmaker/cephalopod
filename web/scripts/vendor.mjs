// Regenerate the same-origin vendored browser bundles for the explorer's CRDT
// engine (issue #18 — no third-party CDN / SRI gap). Run after bumping the pinned
// yjs / y-protocols versions in package.json:  npm run vendor
//
// Yjs is bundled standalone; y-protocols/awareness is bundled with `yjs` left
// EXTERNAL, so the import map resolves BOTH (edit.js's import and awareness's
// internal import) to the ONE vendored Yjs — a second copy would break Yjs's
// constructor/instanceof checks (the "Yjs was already imported" footgun).
import { build } from "esbuild";
import { mkdirSync } from "node:fs";

mkdirSync("src/vendor", { recursive: true });

const bundle = (contents, outfile, external = []) =>
  build({
    stdin: { contents, resolveDir: ".", loader: "js" }, // resolve bare specifiers from ./node_modules
    bundle: true,
    format: "esm",
    legalComments: "none",
    external,
    outfile,
  });

await bundle('export * from "yjs";', "src/vendor/yjs.js");
await bundle('export * from "y-protocols/awareness";', "src/vendor/y-protocols-awareness.js", ["yjs"]);
console.log("vendored Yjs + y-protocols/awareness -> src/vendor/ (same-origin)");
