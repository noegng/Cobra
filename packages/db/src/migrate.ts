import { resolve } from "node:path";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb } from "./client";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
await migrate(createDb(url), { migrationsFolder: resolve(import.meta.dirname, "../drizzle") });
console.log("migrations applied");
process.exit(0);
