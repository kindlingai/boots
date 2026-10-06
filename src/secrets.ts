// The in-memory password store. Nothing here ever touches disk.
//
// Secrets are keyed by the hop path that needs them, so they form a tree:
//
//   local > sudo
//   admin@gpu-1 > ssh
//   admin@gpu-1 > sudo
//   admin@gpu-1 > root@10.0.0.7 > ssh
//
// A sudo prompt on a box falls back to that box's ssh password, which is
// usually the same.

import { ask, askSecret, confirm, dim, say, warn } from "./ui.ts";

export type SecretKind = "ssh" | "sudo" | "apikey";

/** A request for a secret (or a yes/no) from wherever it was needed. */
export interface AskRequest {
  kind: SecretKind | "confirm";
  /** Hops from the local machine to the one asking. [] is local. */
  path: string[];
  prompt: string;
  /** 0 on the first try; higher after the previous answer was rejected. */
  attempt: number;
}

export type Asker = (req: AskRequest) => Promise<string | null>;

export function where(path: string[]): string {
  return path.length ? path.join(" > ") : "local";
}

export class SecretStore {
  private m = new Map<string, string>();

  private key(path: string[], kind: SecretKind): string {
    return `${where(path)} > ${kind}`;
  }

  get(path: string[], kind: SecretKind): string | undefined {
    return this.m.get(this.key(path, kind));
  }

  /** sudo falls back to the same box's ssh password. */
  lookup(path: string[], kind: SecretKind): string | undefined {
    return this.get(path, kind) ?? (kind === "sudo" ? this.get(path, "ssh") : undefined);
  }

  set(path: string[], kind: SecretKind, value: string): void {
    this.m.set(this.key(path, kind), value);
  }

  delete(path: string[], kind: SecretKind): boolean {
    return this.m.delete(this.key(path, kind));
  }

  /** Forgets one key, or everything at and below a path prefix. */
  forget(prefix: string): number {
    let n = 0;
    for (const k of [...this.m.keys()]) {
      if (k === prefix || k.startsWith(prefix + " > ")) {
        this.m.delete(k);
        n++;
      }
    }
    return n;
  }

  clear(): void {
    this.m.clear();
  }

  keys(): string[] {
    return [...this.m.keys()].sort();
  }

  /** The secret values themselves, to scrub them from anything written to disk. */
  values(): string[] {
    return [...this.m.values()];
  }
}

export const secrets = new SecretStore();

/**
 * The near-side asker: answers from the store, else prompts the user and
 * offers to remember the answer for this session.
 */
export function makeNearAsker(store: SecretStore = secrets): Asker {
  return async (req) => {
    const loc = where(req.path);
    if (req.kind === "confirm") {
      // Host-key questions are not secret; show what is typed.
      say(`${req.prompt.trim()} ${dim(`(${loc})`)}`);
      return await ask(/yes\/no/.test(req.prompt) ? "  answer (yes/no): " : "  answer: ");
    }
    if (req.attempt === 0) {
      const v = store.lookup(req.path, req.kind);
      if (v !== undefined) return v;
    } else {
      if (store.delete(req.path, req.kind)) {
        warn(`  stored ${req.kind} password for ${loc} was rejected`);
      }
    }
    const label = req.prompt.trim().replace(/:\s*$/, "");
    const pw = await askSecret(`${label} ${dim(`[${loc}]`)}: `);
    if (pw === null) return null;
    if (await confirm(dim(`  remember for this session?`), true)) store.set(req.path, req.kind, pw);
    return pw;
  };
}
