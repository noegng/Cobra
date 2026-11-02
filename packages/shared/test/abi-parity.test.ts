import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { formatAbiItem } from "viem/utils";
import type { Abi } from "viem";
import { cobraRouterAbi } from "../src/abi";

const root = resolve(import.meta.dirname, "../../../contracts/out");
const artifacts = ["ICobraRouter.sol/ICobraRouter.json", "CobraRouter.sol/CobraRouter.json"];

// Parameter names are not ABI-significant (public mapping getters have none): strip them recursively.
const stripNames = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(stripNames)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.entries(v)
            .filter(([k]) => k !== "internalType" && !(k === "name" && "type" in v && (v as { type: string }).type !== "function" && (v as { type: string }).type !== "event" && (v as { type: string }).type !== "error"))
            .map(([k, x]) => [k, stripNames(x)]),
        )
      : v;

const sigs = (abi: Abi) =>
  abi
    .filter((i) => i.type === "function" || i.type === "event" || i.type === "error")
    .map((i) => formatAbiItem(stripNames(i) as never))
    .sort();

describe("router ABI parity (run `forge build` in contracts/ first)", () => {
  for (const rel of artifacts) {
    const p = resolve(root, rel);
    it.skipIf(!existsSync(p))(`${rel} matches packages/shared/src/abi.ts`, () => {
      const art = JSON.parse(readFileSync(p, "utf8")) as { abi: Abi };
      const expected = sigs(cobraRouterAbi as Abi);
      const actual = sigs(art.abi).filter((s) => !s.startsWith("constructor"));
      // The implementation may expose extra items only if they are also added to the shared ABI.
      expect(actual).toEqual(expected);
    });
  }
});
