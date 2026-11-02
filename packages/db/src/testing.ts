/**
 * In-memory Postgres (PGlite) for tests — no server needed. Applies the real migrations.
 *   const db = await createTestDb();
 */
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "./schema";
import type { Db } from "./client";

export async function createTestDb(): Promise<Db> {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: resolve(import.meta.dirname, "../drizzle") });
  // PGlite and postgres-js drizzle instances share the query-builder API used across the repo.
  return db as unknown as Db;
}
