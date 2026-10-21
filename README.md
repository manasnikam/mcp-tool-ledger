# mcp-tool-ledger

Know what your MCP server's tools are actually doing: every call recorded with tool name, a sha256 of the input, the first 200 characters of the output, latency, success, and an optional tenant id.

MCP servers have no standard observability. This is the smallest useful piece: one wrapper, zero runtime dependencies, works with `@modelcontextprotocol/sdk`'s `registerTool` as is. Extracted from Rasoi, an Alexa+ household kitchen planner, during the Amazon "Build, Ship, Shape" hackathon (Oct 2026).

## Use

```ts
import { createClient } from "@libsql/client";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ensureLedgerTable, ledgerResource, libsqlSink, withLedger } from "mcp-tool-ledger";
import { z } from "zod";

const client = createClient({ url: "file:ledger.db" });
await ensureLedgerTable(client);
const sink = libsqlSink(client);

const server = new McpServer({ name: "demo", version: "1.0.0" });
server.registerTool("echo", { description: "Echo text", inputSchema: { text: z.string() } },
  withLedger("echo", async ({ text }) => ({ content: [{ type: "text", text }] }), { sink }));

// Recent calls as an MCP resource
server.registerResource("ledger", "ledger://recent", { mimeType: "application/json" }, ledgerResource({ client, limit: 100 }));
```

Any function works as a sink, so you can log to the console, insert through your ORM, or forward to OpenTelemetry:

```ts
withLedger("echo", handler, { sink: (e) => console.log(JSON.stringify(e)) });
```

## What gets recorded

| field | |
|---|---|
| `tool` | tool name |
| `tenant` | optional caller id, e.g. the household or user behind the token |
| `input_sha256` | sha256 of the input as key-sorted JSON; the same input always gives the same hash |
| `input` | the raw input, **only** with `recordInput: true` (tool inputs are user text) |
| `output_summary` | the first `summaryChars` (default 200) of the text content |
| `ms` | latency |
| `ok` | `false` when the result has `isError` or the handler threw |
| `error` | the thrown error's name; the error is rethrown unchanged |
| `at` | unix ms |

A failing sink is logged with `console.error` and never fails the tool call.

## Multi-tenant servers

Pass `tenant` per request and scope reads with it, so one caller never sees another's calls:

```ts
ledgerResource({ client, tenant: householdId });
```

## API

- `withLedger(name, handler, { sink, tenant?, recordInput?, summaryChars? })`
- `libsqlSink(client, table = "mcp_tool_ledger")`: any object with libsql's `execute({ sql, args })`
- `ensureLedgerTable(client, table?)`
- `recentCalls(client, { table?, limit?, tenant? })`
- `ledgerResource({ client, table?, limit?, tenant? })`
- `hashInput(input)`

## Licence

MIT
