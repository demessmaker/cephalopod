// Identity, tokens, and role-based access control (05 §1–2). Tokens are random
// secrets; only their hash is stored. Roles are per-space; capability scoping
// (tag/path) is deferred (05 §2.2, OQ).
import { randomBytes } from "node:crypto";
import { blake3 } from "@noble/hashes/blake3";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";
import type { Principal, Role, Store } from "./store/store.js";

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
  constructor(private store: Store) {}

  createPrincipal(kind: "user" | "agent", name: string): Principal {
    const p: Principal = { id: newId(kind === "user" ? "u_" : "a_"), kind, name };
    this.store.addPrincipal(p);
    return p;
  }

  // Returns the plaintext token ONCE; only its hash is persisted.
  issueToken(principalId: string, capabilities: Capabilities = {}): string {
    const token = "cph_" + randomBytes(24).toString("hex");
    this.store.addToken(hashToken(token), principalId, JSON.stringify(capabilities));
    return token;
  }

  authenticate(token: string | undefined): Principal | undefined {
    if (!token) return undefined;
    const pid = this.store.principalIdByToken(hashToken(token));
    return pid ? this.store.getPrincipal(pid) : undefined;
  }

  // The capability constraints attached to a token (empty = full for its role).
  capabilities(token: string | undefined): Capabilities {
    if (!token) return {};
    const raw = this.store.getCapabilities(hashToken(token));
    try {
      return raw ? (JSON.parse(raw) as Capabilities) : {};
    } catch {
      return {};
    }
  }

  getPrincipalById(id: string): Principal | undefined {
    return this.store.getPrincipal(id);
  }
  roleOf(space: string, principalId: string): Role | undefined {
    return this.store.getRole(space, principalId);
  }
  setRole(space: string, principalId: string, role: Role): void {
    this.store.setRole(space, principalId, role);
  }
  memberships(principalId: string) {
    return this.store.listMemberships(principalId);
  }

  // First-run bootstrap: create an admin user + token if none exist.
  bootstrapAdmin(): { principal: Principal; token: string } | undefined {
    if (this.store.principalCount() > 0) return undefined;
    const principal = this.createPrincipal("user", "admin");
    const token = this.issueToken(principal.id);
    return { principal, token };
  }
}
