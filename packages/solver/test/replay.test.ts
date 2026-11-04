/**
 * Replays real QuoterV2 answers recorded by scripts/replay-quotes.ts. Checks that the solver reproduces the
 * recorded results bit-for-bit offline (determinism on real data) and prints savings vs the naive route.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { solve } from "../src/index";
import { REPLAY_CAP_USD, REPLAY_NOW, fixtureQuoter, fromJson, type ReplayFixture } from "../scripts/replay-lib";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "real-quotes.json");
const fixture = existsSync(FIXTURE) ? fromJson<ReplayFixture>(readFileSync(FIXTURE, "utf8")) : null;

describe.skipIf(!fixture)("replay of real Celo QuoterV2 quotes", () => {
  it("reproduces every recorded result offline and reports savings", async () => {
    const f = fixture!;
    const rows: string[] = [];
    for (const s of f.scenarios) {
      const q = fixtureQuoter(f.quotes);
      const r = await solve(s.input, { quoter: q, capUsd: REPLAY_CAP_USD, now: () => REPLAY_NOW, maxConcurrentQuotes: 4 });
      expect(q.misses, s.name).toEqual([]);
      // refusedCostBps is a diagnostic added after the fixture was recorded (cost of the route a price guard refused).
      const { refusedCostBps, ...core } = r as typeof r & { refusedCostBps?: number };
      expect(core, s.name).toEqual(f.results[s.name]);
      if (!r.ok && r.reason === "price_guard" && r.detail?.startsWith("implied price")) expect(typeof refusedCostBps, s.name).toBe("number");
      if (r.ok) {
        const sumOut = r.plan.legs.reduce((a, l) => a + l.quotedOut, 0n);
        expect(sumOut).toBeGreaterThanOrEqual(s.input.invoice.amountOut);
        for (const l of r.plan.legs) {
          expect(l.amountIn).toBeLessThanOrEqual(s.input.balances.find((b) => b.token === l.token)!.amount);
        }
      }
      rows.push(
        `${s.name.padEnd(42)} ${
          r.ok
            ? `legs=${r.plan.legs.length} cost=${r.plan.costBps.toFixed(2)} naive=${r.plan.naiveCostBps?.toFixed(2) ?? "n/a"} savings=${r.plan.savingsBps.toFixed(2)} bps`
            : `${r.reason}`
        }`,
      );
    }
    console.log(`block ${f.meta.blockNumber} (${f.meta.recordedAt})\n${rows.join("\n")}`);
  });
});
