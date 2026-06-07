// VS Code glue for Cephalopod. Notes are surfaced through a virtual file system
// (scheme `cephalopod:`) so each note opens as an ordinary editable markdown
// buffer; saving writes the buffer through EditorSession.setBody (a minimal CRDT
// edit), and a remote delta refreshes the open buffer via onDidChangeFile. The
// sync engine itself (session.ts) holds no vscode dependency — this file is the
// only part that needs a running editor host, which is why the tests cover the
// session and diff, not this module.
import * as vscode from "vscode";
import { EditorSession } from "./session.js";

const SCHEME = "cephalopod";
const enc = new TextEncoder();
const dec = new TextDecoder();

// cephalopod:/<noteId>.md  <->  noteId
const noteUri = (id: string) => vscode.Uri.parse(`${SCHEME}:/${id}.md`);
const idFromUri = (uri: vscode.Uri) => uri.path.replace(/^\/+/, "").replace(/\.md$/, "");

// A note appears as a single .md file at the FS root. The session is the backing
// store; reads/writes go straight through it. mtime advances on every change so
// VS Code treats a refreshed buffer as new content.
class NoteFS implements vscode.FileSystemProvider {
  private mtimes = new Map<string, number>();
  private readonly _emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this._emitter.event;

  constructor(private session: EditorSession) {
    session.onRemoteChange = (id) => {
      this.mtimes.set(id, Date.now());
      this._emitter.fire([{ type: vscode.FileChangeType.Changed, uri: noteUri(id) }]);
    };
  }

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => {});
  }

  stat(uri: vscode.Uri): vscode.FileStat {
    const id = idFromUri(uri);
    if (!id) return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 };
    const mtime = this.mtimes.get(id) ?? 0;
    return { type: vscode.FileType.File, ctime: 0, mtime, size: enc.encode(this.session.bodyText(id)).length };
  }

  readDirectory(): [string, vscode.FileType][] {
    return this.session.workingSet().map((id) => [`${id}.md`, vscode.FileType.File]);
  }

  readFile(uri: vscode.Uri): Uint8Array {
    const id = idFromUri(uri);
    if (!this.session.has(id)) this.session.openNote(id);
    return enc.encode(this.session.bodyText(id));
  }

  writeFile(uri: vscode.Uri, content: Uint8Array): void {
    this.session.setBody(idFromUri(uri), dec.decode(content));
  }

  // A remote refresh fired onDidChangeFile; surface that as a fresh mtime read.
  touch(id: string): void {
    this.mtimes.set(id, Date.now());
    this._emitter.fire([{ type: vscode.FileChangeType.Changed, uri: noteUri(id) }]);
  }

  createDirectory(): void {}
  delete(): void {
    throw vscode.FileSystemError.NoPermissions("notes are deleted on the brain, not the file system");
  }
  rename(): void {
    throw vscode.FileSystemError.NoPermissions("rename a note via its title, not the file path");
  }
}

// Sidebar tree of the open working set (title -> open note).
class NotesTree implements vscode.TreeDataProvider<string> {
  private readonly _changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._changed.event;
  constructor(private session: EditorSession) {}
  refresh(): void {
    this._changed.fire();
  }
  getTreeItem(id: string): vscode.TreeItem {
    const item = new vscode.TreeItem(this.session.title(id) || id);
    item.description = id;
    item.resourceUri = noteUri(id);
    item.command = { command: "cephalopod.openNote", title: "Open", arguments: [id] };
    item.contextValue = "cephalopodNote";
    return item;
  }
  getChildren(): string[] {
    return this.session
      .workingSet()
      .sort((a, b) => (this.session.title(a) || a).localeCompare(this.session.title(b) || b));
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const cfg = () => vscode.workspace.getConfiguration("cephalopod");
  const space = cfg().get<string>("space") ?? "";
  const token =
    (await context.secrets.get("cephalopod.token")) ?? cfg().get<string>("token") ?? process.env.CEPH_TOKEN ?? "";

  const session = new EditorSession({
    wsUrl: cfg().get<string>("wsUrl") ?? "ws://localhost:7700",
    httpUrl: cfg().get<string>("httpUrl") ?? "http://localhost:7701",
    token,
    space,
  });

  const fs = new NoteFS(session);
  const tree = new NotesTree(session);
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = "cephalopod.reconnect";

  const render = () => {
    const s = session.status();
    const dot = s.connected ? "$(cloud)" : "$(cloud-offline)";
    const dirty = s.dirty.length ? ` · ${s.dirty.length} unsynced` : "";
    status.text = `${dot} Cephalopod${space ? ` (${space})` : ""} · ${s.open}${dirty}`;
    status.tooltip = s.connected ? "Connected to the brain" : "Offline — edits queue until reconnect";
    status.show();
    tree.refresh();
  };
  session.onModelChange = render;

  const connect = async () => {
    if (!space || !token) {
      vscode.window.showWarningMessage("Set cephalopod.space and a token (Cephalopod: Set Token) first.");
      return;
    }
    try {
      await session.connect();
    } catch (e) {
      vscode.window.showWarningMessage(`Cephalopod offline: ${(e as Error).message}`);
    }
    render();
  };

  const openNote = async (id: string) => {
    session.openNote(id);
    await session.waitIdle();
    const doc = await vscode.workspace.openTextDocument(noteUri(id));
    await vscode.languages.setTextDocumentLanguage(doc, "markdown");
    await vscode.window.showTextDocument(doc, { preview: false });
  };

  context.subscriptions.push(
    status,
    vscode.workspace.registerFileSystemProvider(SCHEME, fs, { isCaseSensitive: true }),
    vscode.window.registerTreeDataProvider("cephalopodNotes", tree),

    vscode.commands.registerCommand("cephalopod.reconnect", connect),

    vscode.commands.registerCommand("cephalopod.openNote", async (arg?: string) => {
      if (typeof arg === "string") return openNote(arg);
      const q = await vscode.window.showInputBox({ prompt: "Search notes" });
      if (q === undefined) return;
      try {
        const hits = await session.search(q);
        if (!hits.length) return vscode.window.showInformationMessage("No matching notes.");
        const pick = await vscode.window.showQuickPick(
          hits.map((h) => ({ label: h.title || h.id, description: h.id, detail: h.tags.join(", "), id: h.id })),
          { placeHolder: "Open a note" },
        );
        if (pick) await openNote(pick.id);
      } catch (e) {
        vscode.window.showErrorMessage((e as Error).message);
      }
    }),

    vscode.commands.registerCommand("cephalopod.newNote", async () => {
      const title = await vscode.window.showInputBox({ prompt: "New note title" });
      if (!title) return;
      const id = session.newNote({ title });
      await openNote(id);
    }),

    vscode.commands.registerCommand("cephalopod.setTitle", async (arg?: string) => {
      const id = arg ?? (vscode.window.activeTextEditor && idFromUri(vscode.window.activeTextEditor.document.uri));
      if (!id) return;
      const title = await vscode.window.showInputBox({ prompt: "Note title", value: session.title(id) });
      if (title !== undefined) session.setTitle(id, title);
    }),

    vscode.commands.registerCommand("cephalopod.pullScope", async (arg?: string) => {
      const focus = arg ?? (await vscode.window.showInputBox({ prompt: "Focus note id" }));
      if (!focus) return;
      try {
        const ids = await session.pullScope(focus, 1);
        vscode.window.showInformationMessage(`Pulled ${ids.length} notes into the working set.`);
      } catch (e) {
        vscode.window.showErrorMessage((e as Error).message);
      }
    }),

    vscode.commands.registerCommand("cephalopod.setToken", async () => {
      const t = await vscode.window.showInputBox({ prompt: "Cephalopod API token", password: true });
      if (t === undefined) return;
      await context.secrets.store("cephalopod.token", t);
      vscode.window.showInformationMessage("Token saved. Reload the window to reconnect.");
    }),
  );

  // Saving an open note writes the buffer through the session (it already does on
  // FS writeFile, but VS Code's save also triggers this — keep them aligned).
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.uri.scheme === SCHEME) session.setBody(idFromUri(doc.uri), doc.getText());
    }),
  );

  render();
  await connect();
}

export function deactivate(): void {}
