import { describe, expect, it } from "vitest";
import { HttpRequestError, LimitExceededRpcError, RpcRequestError, TimeoutError, UnknownRpcError } from "viem";
import { isRangeError } from "../src/rpc-errors";

const rpc = (code: number, message: string) => new RpcRequestError({ body: {}, url: "http://x", error: { code, message } });

describe("isRangeError", () => {
  it.each([
    ["block range is too wide", -32000],
    ["query returned more than 10000 results", -32602],
    ["eth_getLogs is limited to a 10,000 range", -32005],
    ["exceed maximum block range: 5000", -32000],
    ["Log response size exceeded. You can make eth_getLogs requests with up to a 2K block range", -32602],
    ["requested too many blocks from 1 to 100000, maximum is set to 2048", -32602],
  ])("%s", (message, code) => {
    expect(isRangeError(new UnknownRpcError(rpc(code, message)))).toBe(true);
  });

  it("timeouts and LimitExceeded count as range errors", () => {
    expect(isRangeError(new TimeoutError({ body: {}, url: "http://x" }))).toBe(true);
    expect(isRangeError(new LimitExceededRpcError(rpc(-32005, "limit")))).toBe(true);
    expect(isRangeError(new HttpRequestError({ url: "http://x", status: 504 }))).toBe(true);
  });

  it("rate limits and plain failures do not", () => {
    expect(isRangeError(new HttpRequestError({ url: "http://x", status: 429 }))).toBe(false);
    expect(isRangeError(new UnknownRpcError(rpc(-32005, "rate limit exceeded")))).toBe(false);
    expect(isRangeError(new HttpRequestError({ url: "http://x", status: 502, details: "bad gateway" }))).toBe(false);
    expect(isRangeError(new Error("ECONNREFUSED"))).toBe(false);
    expect(isRangeError(undefined)).toBe(false);
  });
});
