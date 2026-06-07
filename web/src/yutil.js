// Browser/Node helpers for the Yjs editor: base64 (no Buffer) and a minimal text
// diff so a textarea edit maps to the smallest Y.Text delete+insert (preserving
// other collaborators' offsets and our own CRDT granularity).

// Uint8Array <-> base64 using btoa/atob (present in browsers and modern Node).
export function b64enc(u8) {
  let s = "";
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s);
}
export function b64dec(str) {
  const s = atob(str);
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
}

const isHigh = (cc) => cc >= 0xd800 && cc <= 0xdbff;
const isLow = (cc) => cc >= 0xdc00 && cc <= 0xdfff;

// Smallest single-range edit between two strings: the length of the shared prefix,
// how many old chars to delete, and the inserted slice. Good enough for a textarea
// (one contiguous change per keystroke/paste); falls back to a full replace if both
// ends differ, which is still correct.
//
// Surrogate-safe: the prefix/suffix scan counts UTF-16 code units, so a boundary can
// land between an emoji's two halves. We snap both ends OFF any pair so a delete/
// insert never begins or ends mid-character — otherwise a concurrent collaborator's
// op at that sub-character index could wedge a lone surrogate the doc converges to.
export function diffRange(oldStr, newStr) {
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
  // if `start` split a pair (it sits on a low surrogate whose high is in the prefix),
  // back it up by one so the whole character is inside the edit
  if (start > 0 && isLow(oldStr.charCodeAt(start)) && isHigh(oldStr.charCodeAt(start - 1))) start--;
  // if the suffix begins mid-pair (its first kept char is a low surrogate whose high
  // is in the edit), push both boundaries forward so the pair stays together
  if (endOld < oldStr.length && isLow(oldStr.charCodeAt(endOld)) && isHigh(oldStr.charCodeAt(endOld - 1))) {
    endOld++;
    endNew++;
  }
  return { index: start, remove: endOld - start, insert: newStr.slice(start, endNew) };
}

// Apply the diff between the Y.Text's current value and `newStr` as one transaction.
export function applyTextChange(ytext, newStr, origin) {
  const cur = ytext.toString();
  const d = diffRange(cur, newStr);
  if (!d) return;
  const doc = ytext.doc;
  const run = () => {
    if (d.remove) ytext.delete(d.index, d.remove);
    if (d.insert) ytext.insert(d.index, d.insert);
  };
  doc ? doc.transact(run, origin) : run();
}
