import type { Db } from "./database";

/** 已经加密过的字节（safeStorage 的输出）。这个仓库本身不做加密，也不认识明文。 */
export class SecretsRepo {
  constructor(private readonly db: Db) {}

  get(name: string): Uint8Array | null {
    const r = this.db.prepare(`SELECT value FROM secrets WHERE name = ?`).get(name) as { value: Uint8Array } | undefined;
    return r ? new Uint8Array(r.value) : null;
  }

  set(name: string, value: Uint8Array, at: number): void {
    this.db
      .prepare(`INSERT INTO secrets (name, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .run(name, value, at);
  }

  delete(name: string): void {
    this.db.prepare(`DELETE FROM secrets WHERE name = ?`).run(name);
  }
}
