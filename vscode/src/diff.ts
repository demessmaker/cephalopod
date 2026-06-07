// Minimal single-range text diff, ported from the build-less web editor
// (web/src/yutil.js) into TypeScript. An editor save hands us the whole new
// document; we map it to the smallest Y.Text delete+insert so concurrent
// collaborators' offsets and our own CRDT granularity are preserved.
import type * as Y from "yjs";

const isHigh = (cc: number) => cc >= 0xd800 && cc <= 0xdbff;
const isLow = (cc: number) => cc >= 0xdc00 && cc <= 0xdfff;

export interface TextEdit {
  index: number;
  remove: number;
  insert: string;
}

// Smallest single-range edit between two strings: the shared-prefix length, how
// many old chars to delete, and the inserted slice. One contiguous change covers
// the common case (a keystroke, a paste, a block reformat); when both ends differ
// it degrades to a full replace, which is still correct.
//
// Surrogate-safe: the prefix/suffix scan counts UTF-16 code units, so a boundary
// can fall between an emoji's two halves. We snap both ends OFF any pair so a
// delete/insert never begins or ends mid-character — otherwise a concurrent op at
// that sub-character index could wedge a lone surrogate the doc converges to.
export function diffRange(oldStr: string, newStr: string): TextEdit | null {
  if (oldStr === newStr) return null;
  let start = 0;
  const max = Math.min(oldStr.length, newStr.length);
  while (start < max && oldStr[start] === newStr[start]) start++;
  let endOld = oldStr.length;
  let endNew = newStr.length;
  while (endOld > start && endNew > start && oldStr[endOld - 1] === newStr[endNew - 1]) {
    endOld--;
    endNew--;
  }
  // if `start` split a pair (it sits on a low surrogate whose high is in the
  // prefix), back it up by one so the whole character is inside the edit
  if (start > 0 && isLow(oldStr.charCodeAt(start)) && isHigh(oldStr.charCodeAt(start - 1))) start--;
  // if the suffix begins mid-pair (its first kept char is a low surrogate whose
  // high is in the edit), push both boundaries forward so the pair stays together
  if (endOld < oldStr.length && isLow(oldStr.charCodeAt(endOld)) && isHigh(oldStr.charCodeAt(endOld - 1))) {
    endOld++;
    endNew++;
  }
  return { index: start, remove: endOld - start, insert: newStr.slice(start, endNew) };
}

// Apply the diff between a Y.Text's current value and `newStr` as one transaction
// tagged with `origin` (so the doc's own update handler can tell local edits from
// applied remote ones). No-op when the text already matches.
export function applyTextChange(ytext: Y.Text, newStr: string, origin: unknown): void {
  const d = diffRange(ytext.toString(), newStr);
  if (!d) return;
  const run = () => {
    if (d.remove) ytext.delete(d.index, d.remove);
    if (d.insert) ytext.insert(d.index, d.insert);
  };
  const doc = ytext.doc;
  doc ? doc.transact(run, origin) : run();
}
