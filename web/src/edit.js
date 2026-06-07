// Browser-side collaborative note session: mirrors the arm replica's Yjs sync
// handshake against the brain WS, plus ephemeral awareness (presence). The brain is
// the authority; this just produces/consumes CRDT deltas and relays awareness.
//
// Kept DOM- and socket-agnostic so it unit-tests in Node: construct with a `send`
// function and feed server frames to `receive`. `bindTextarea` wires a real <textarea>.
import * as Y from "yjs";
import * as awarenessProtocol from "y-protocols/awareness";
import { b64enc, b64dec, applyTextChange } from "./yutil.js";

const REMOTE = Symbol("remote"); // origin tag: deltas we applied from the server (don't echo)

export class NoteSession {
  // send: (msg) => void ; opts: { space, note, user? }
  constructor(send, { space, note, user } = {}) {
    this.send = send;
    this.space = space;
    this.note = note;
    this.doc = new Y.Doc();
    this.body = this.doc.getText("body"); // matches the brain's note schema (body = Y.Text)
    this.awareness = new awarenessProtocol.Awareness(this.doc);
    if (user) this.awareness.setLocalStateField("user", user);

    this.doc.on("update", (update, origin) => {
      if (origin === REMOTE) return; // came from the server — already applied there
      this.send({ t: "update", space, note, update: b64enc(update) });
    });
    this.awareness.on("update", ({ added, updated, removed }, origin) => {
      if (origin === REMOTE) return;
      const changed = [...added, ...updated, ...removed];
      this.send({ t: "awareness", space, note, state: b64enc(awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed)) });
    });
  }

  // Begin syncing: declare interest, then offer our state vector.
  start() {
    this.send({ t: "open", space: this.space, note: this.note });
    this.send({ t: "sync1", space: this.space, note: this.note, sv: b64enc(Y.encodeStateVector(this.doc)) });
  }

  // Feed a server frame (already JSON-parsed) for this note.
  receive(msg) {
    if (msg.note !== this.note || msg.space !== this.space) return;
    switch (msg.t) {
      case "sync1": // server's state vector -> send what it's missing from us
        this.send({ t: "sync2", space: this.space, note: this.note, update: b64enc(Y.encodeStateAsUpdate(this.doc, b64dec(msg.sv))) });
        break;
      case "sync2":
      case "update":
        Y.applyUpdate(this.doc, b64dec(msg.update), REMOTE);
        break;
      case "awareness":
        awarenessProtocol.applyAwarenessUpdate(this.awareness, b64dec(msg.state), REMOTE);
        break;
    }
  }

  // Other participants' presence states (excluding us).
  peers() {
    const out = [];
    for (const [clientId, state] of this.awareness.getStates()) {
      if (clientId === this.doc.clientID) continue;
      if (state && state.user) out.push({ clientId, ...state.user });
    }
    return out;
  }

  setCursor(anchor) {
    this.awareness.setLocalStateField("cursor", anchor);
  }

  destroy() {
    awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], "local");
    this.awareness.destroy();
    this.doc.destroy();
  }
}

// Two-way bind a <textarea> to the session's body Y.Text. Returns a disposer.
export function bindTextarea(session, el) {
  const LOCAL = "textarea";
  el.value = session.body.toString();

  const onRemote = (_evt, origin) => {
    if (origin === LOCAL) return; // our own edit — the DOM already has it
    const sel = [el.selectionStart, el.selectionEnd];
    const next = session.body.toString();
    // keep the caret stable across a remote insert/delete before it
    const delta = next.length - el.value.length;
    el.value = next;
    if (sel[0] != null) {
      el.selectionStart = sel[0] + (sel[0] >= 0 && delta ? delta : 0);
      el.selectionEnd = sel[1] + (sel[1] >= 0 && delta ? delta : 0);
    }
  };
  session.body.observe(onRemote);

  const onInput = () => {
    applyTextChange(session.body, el.value, LOCAL);
    session.setCursor(el.selectionStart);
  };
  el.addEventListener("input", onInput);

  return () => {
    session.body.unobserve(onRemote);
    el.removeEventListener("input", onInput);
  };
}
