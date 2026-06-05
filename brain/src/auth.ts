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
  issueToken(principalId: string): string {
    const token = "cph_" + randomBytes(24).toString("hex");
    this.store.addToken(hashToken(token), principalId);
    return token;
  }

  authenticate(token: string | undefined): Principal | undefined {
    if (!token) return undefined;
    const pid = this.store.principalIdByToken(hashToken(token));
    return pid ? this.store.getPrincipal(pid) : undefined;
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
