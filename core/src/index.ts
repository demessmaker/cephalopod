// @cephalopod/core — single source of truth for the note schema, ids, wikilink
// derivation, and wire protocol. Consumed by `brain` and `arm` (each re-exports
// these from its own src/core/* shims).
export * from "./ids.js";
export * from "./note.js";
export * from "./wikilinks.js";
export * from "./protocol.js";
