import { drizzle as drizzlePg } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type Db = ReturnType<typeof drizzlePg<typeof schema>>;

/** Production/dev client (Neon or Supabase via standard Postgres URL). */
export function createDb(url: string): Db {
  const client = postgres(url, { max: 5, prepare: false });
  return drizzlePg(client, { schema });
}

export { schema };
