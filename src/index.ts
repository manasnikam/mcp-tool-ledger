import { createHash } from "node:crypto";

/** One recorded tool call. */
export type LedgerEntry = {
  tool: string;
  tenant?: string;
  input_sha256: string;
  input?: unknown; // only with recordInput: true
  output_summary: string;
  ms: number;
  ok: boolean;
  error?: string; // thrown error name, when the handler threw
  at: number; // unix ms
};

export type Sink = (entry: LedgerEntry) => unknown;

/** The subset of an MCP CallToolResult the ledger reads. */
export type ToolResult = { content: { type: string; text?: string }[]; isError?: boolean };

export type LedgerOptions = {
  sink: Sink;
  tenant?: string;
  /** Store the raw input next to its hash. Off by default: tool inputs are user text. */
  recordInput?: boolean;
  summaryChars?: number;
};

/**
 * Wraps an MCP tool callback (as passed to `server.registerTool`) so every call is timed and
 * handed to `sink`. The result is returned unchanged; a throw is recorded and rethrown.
 * A failing sink is logged and never fails the tool.
 */
export function withLedger<A extends unknown[], R extends ToolResult>(
  tool: string,
  handler: (...args: A) => R | Promise<R>,
  opts: LedgerOptions,
): (...args: A) => Promise<R> {
  return async (...args: A) => {
    const start = performance.now();
    const record = async (ok: boolean, output_summary: string, error?: string) => {
      const entry: LedgerEntry = {
        tool, tenant: opts.tenant, input_sha256: hashInput(args[0]),
        ...(opts.recordInput ? { input: args[0] } : {}),
        output_summary, ms: Math.round(performance.now() - start), ok, ...(error ? { error } : {}), at: Date.now(),
      };
      try {
        await opts.sink(entry);
      } catch (e) {
        console.error(`mcp-tool-ledger: sink failed for ${tool}`, e);
      }
    };
    let result: R;
    try {
      result = await handler(...args);
    } catch (e) {
      await record(false, "", e instanceof Error ? e.name : "Error");
      throw e;
    }
    const text = result.content.map((c) => c.text ?? `[${c.type}]`).join("\n");
    await record(!result.isError, text.slice(0, opts.summaryChars ?? 200));
    return result;
  };
}

/** sha256 of the input as key-sorted JSON, so {a,b} and {b,a} hash the same. */
export function hashInput(input: unknown): string {
  return createHash("sha256").update(stableJson(input) ?? "undefined").digest("hex");
}

function stableJson(v: unknown): string | undefined {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map((x) => stableJson(x) ?? "null").join(",")}]`;
  const o = v as Record<string, unknown>;
  const parts = Object.keys(o).sort().flatMap((k) => {
    const s = stableJson(o[k]);
    return s === undefined ? [] : [`${JSON.stringify(k)}:${s}`];
  });
  return `{${parts.join(",")}}`;
}

/** Anything with libsql's `execute` (`@libsql/client` Client or Transaction). */
export type SqlClient = { execute(stmt: { sql: string; args: (string | number | null)[] }): Promise<{ rows: unknown[] }> };

const ident = (t: string) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(t)) throw new Error(`mcp-tool-ledger: bad table name ${t}`);
  return t;
};

/** Creates the ledger table if missing. Call once at startup. */
export async function ensureLedgerTable(client: SqlClient, table = "mcp_tool_ledger") {
  await client.execute({ args: [], sql: `CREATE TABLE IF NOT EXISTS ${ident(table)} (
    id INTEGER PRIMARY KEY, tool TEXT NOT NULL, tenant TEXT, input_sha256 TEXT NOT NULL, input TEXT,
    output_summary TEXT NOT NULL, ms INTEGER NOT NULL, ok INTEGER NOT NULL, error TEXT, at INTEGER NOT NULL)` });
}

/** A sink that inserts each entry into a SQLite/libsql table. */
export function libsqlSink(client: SqlClient, table = "mcp_tool_ledger"): Sink {
  const sql = `INSERT INTO ${ident(table)} (tool, tenant, input_sha256, input, output_summary, ms, ok, error, at) VALUES (?,?,?,?,?,?,?,?,?)`;
  return (e) => client.execute({ sql, args: [
    e.tool, e.tenant ?? null, e.input_sha256, e.input === undefined ? null : JSON.stringify(e.input),
    e.output_summary, e.ms, e.ok ? 1 : 0, e.error ?? null, e.at,
  ] });
}

/** Most recent entries first. Pass `tenant` to scope a multi-tenant server to one caller. */
export async function recentCalls(client: SqlClient, opts: { table?: string; limit?: number; tenant?: string } = {}) {
  const where = opts.tenant === undefined ? "" : "WHERE tenant = ?";
  const args = [...(opts.tenant === undefined ? [] : [opts.tenant]), opts.limit ?? 100];
  const { rows } = await client.execute({
    sql: `SELECT tool, tenant, input_sha256, output_summary, ms, ok, error, at FROM ${ident(opts.table ?? "mcp_tool_ledger")} ${where} ORDER BY at DESC, id DESC LIMIT ?`, args,
  });
  return rows;
}

/** Read callback for `server.registerResource("ledger", "ledger://recent", meta, ledgerResource({ client }))`. */
export function ledgerResource(opts: { client: SqlClient; table?: string; limit?: number; tenant?: string }) {
  return async (uri: URL) => ({
    contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({ calls: await recentCalls(opts.client, opts) }) }],
  });
}
