import { resolve } from "node:path";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb } from "./client";

// Migrations need a direct (non-pooled) connection: PgBouncer transaction pooling breaks session state.
// Neon exposes it as DATABASE_URL_UNPOOLED; fall back to DATABASE_URL for plain Postgres.
const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL_UNPOOLED or DATABASE_URL is required");
await migrate(createDb(url), { migrationsFolder: resolve(import.meta.dirname, "../drizzle") });
console.log("migrations applied");
process.exit(0);
