import { createClient } from "@libsql/client";
import { expect, test, vi } from "vitest";
import { ensureLedgerTable, hashInput, ledgerResource, libsqlSink, recentCalls, withLedger, type LedgerEntry } from "./index.js";

const ok = (text: string) => ({ content: [{ type: "text", text }] });

test("records ok, error results and throws; raw input only when asked; a failing sink is harmless", async () => {
  const seen: LedgerEntry[] = [];
  const sink = (e: LedgerEntry) => void seen.push(e);
  await withLedger("echo", async (a: { q: string }) => ok(`hi ${a.q}`), { sink, tenant: "h1" })({ q: "x" });
  await withLedger("bad", async () => ({ ...ok("nope"), isError: true }), { sink })({});
  await expect(withLedger("boom", async () => { throw new TypeError("x"); }, { sink })({})).rejects.toThrow(TypeError);
  await withLedger("raw", async () => ok("yes"), { sink, recordInput: true, summaryChars: 1 })({ q: "x" });

  expect(seen.map((e) => [e.tool, e.ok, e.output_summary, e.error, e.tenant])).toEqual([
    ["echo", true, "hi x", undefined, "h1"], ["bad", false, "nope", undefined, undefined],
    ["boom", false, "", "TypeError", undefined], ["raw", true, "y", undefined, undefined],
  ]);
  expect(seen[0]).not.toHaveProperty("input");
  expect(seen[3].input).toEqual({ q: "x" });
  expect(hashInput({ a: 1, b: [2, { c: 3 }] })).toBe(hashInput({ b: [2, { c: 3 }], a: 1 }));

  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  expect(await withLedger("t", async () => ok("still fine"), { sink: () => { throw new Error("db down"); } })({})).toEqual(ok("still fine"));
  expect(err).toHaveBeenCalledOnce();
});

test("libsql sink round-trips, the resource scopes by tenant, table names are checked", async () => {
  const client = createClient({ url: ":memory:" });
  await ensureLedgerTable(client);
  const sink = libsqlSink(client);
  await withLedger("a", async () => ok("1"), { sink, tenant: "h1" })({});
  await withLedger("b", async () => ok("2"), { sink, tenant: "h2" })({});

  expect((await recentCalls(client)).map((r) => (r as { tool: string }).tool)).toEqual(["b", "a"]);
  const res = await ledgerResource({ client, tenant: "h1" })(new URL("ledger://recent"));
  expect(JSON.parse(res.contents[0].text).calls).toMatchObject([{ tool: "a", tenant: "h1", ok: 1 }]);
  expect(() => libsqlSink(client, "calls; --")).toThrow(/bad table name/);
});
