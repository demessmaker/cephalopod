// Identity, tokens, and role-based access control (05 §1–2). Tokens are random
// secrets; only their hash is stored. Roles are per-space; capability scoping
// (tag/path) is deferred (05 §2.2, OQ).
import { randomBytes } from "node:crypto";
import { blake3 } from "@noble/hashes/blake3";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";
import { toAsync, type AsyncStore, type Principal, type Role, type Store } from "./store/store.js";

const RANK: Record<Role, number> = { viewer: 1, editor: 2, admin: 3 };
export type Action = "read" | "write" | "admin";

export function can(role: Role | undefined, need: Action): boolean {
  if (!role) return false;
  return RANK[role] >= (need === "read" ? 1 : need === "write" ? 2 : 3);
}

// Per-token capability constraints (05 §2.2). They INTERSECT with the role —
// they only ever narrow it, never widen. Empty = full access for the role.
export interface Capabilities {
  mode?: "read" | "write"; // "read" = read-only token (no writes anywhere)
  writeTags?: string[]; // may only write notes carrying at least one of these tags
  pathPrefix?: string; // may only write notes whose props.path starts with this
}

const hashToken = (token: string) => bytesToHex(blake3(utf8ToBytes(token)));
const newId = (prefix: string) => prefix + randomBytes(12).toString("hex");

export class Auth {
  private store: AsyncStore;
  constructor(store: Store | AsyncStore) {
    this.store = toAsync(store);
  }

  async createPrincipal(kind: "user" | "agent", name: string): Promise<Principal> {
    const p: Principal = { id: newId(kind === "user" ? "u_" : "a_"), kind, name };
    await this.store.addPrincipal(p);
    return p;
  }

  // Returns the plaintext token ONCE; only its hash is persisted.
  async issueToken(principalId: string, capabilities: Capabilities = {}): Promise<string> {
    const token = "cph_" + randomBytes(24).toString("hex");
    await this.store.addToken(hashToken(token), principalId, JSON.stringify(capabilities));
    return token;
  }

  async authenticate(token: string | undefined): Promise<Principal | undefined> {
    if (!token) return undefined;
    const pid = await this.store.principalIdByToken(hashToken(token));
    return pid ? this.store.getPrincipal(pid) : undefined;
  }

  // The capability constraints attached to a token (empty = full for its role).
  async capabilities(token: string | undefined): Promise<Capabilities> {
    if (!token) return {};
    const raw = await this.store.getCapabilities(hashToken(token));
    try {
      return raw ? (JSON.parse(raw) as Capabilities) : {};
    } catch {
      return {};
    }
  }

  getPrincipalById(id: string): Promise<Principal | undefined> {
    return this.store.getPrincipal(id);
  }
  roleOf(space: string, principalId: string): Promise<Role | undefined> {
    return this.store.getRole(space, principalId);
  }
  setRole(space: string, principalId: string, role: Role): Promise<void> {
    return this.store.setRole(space, principalId, role);
  }
  memberships(principalId: string) {
    return this.store.listMemberships(principalId);
  }

  // First-run bootstrap: create an admin user + token if none exist.
  async bootstrapAdmin(): Promise<{ principal: Principal; token: string } | undefined> {
    if ((await this.store.principalCount()) > 0) return undefined;
    const principal = await this.createPrincipal("user", "admin");
    const token = await this.issueToken(principal.id);
    return { principal, token };
  }
}
