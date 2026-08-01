import { afterEach, describe, expect, test } from "bun:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import type { FileService, PublicFileRecord, UploadSource } from "../src/files/types";
import type { StructuredQueryRequest, StructuredQueryResponse } from "../src/query/contract";
import { testConfig } from "./support/config";
import { TestManagedOAuthService } from "./support/managed-oauth";

const FILE_ID = "file_0123456789abcdef0123456789abcdef";
const ALPHA_KEY = "alpha-secret-0123456789abcdef0123456789";
const BETA_KEY = "beta-secret-0123456789abcdef01234567890";
const RECORD: PublicFileRecord = {
  id: FILE_ID,
  status: "ready",
  codec: "jsonl",
  originalName: "events.jsonl",
  sourceBytes: 9,
  schemaBytes: 9,
  primerId: "schemagrep-manifest/v1",
  schemaId: `sha256:${"0".repeat(64)}`,
  createdAt: "2026-07-29T00:00:00.000Z",
  expiresAt: "2026-07-29T01:00:00.000Z",
};
const SCHEMA = {
  format: "schemagrep-manifest/v1",
  primerId: "schemagrep-manifest/v1",
  codec: "jsonl",
  records: 1,
  fields: [],
};
const CONFIG = testConfig({
  storageBaseDirectory: "/tmp/schemagrep-cloud-mcp-tests",
});
const OAUTH = new TestManagedOAuthService(
  "http://127.0.0.1:3199",
  { [ALPHA_KEY]: "alpha", [BETA_KEY]: "beta" },
);

class McpFileService implements FileService {
  async ingest(_source: UploadSource, _ownerId: string): Promise<PublicFileRecord> {
    return RECORD;
  }

  async list(ownerId: string): Promise<PublicFileRecord[]> {
    return ownerId === "alpha" ? [RECORD] : [];
  }

  async usage(ownerId: string) {
    return {
      activeFiles: ownerId === "alpha" ? 1 : 0,
      sourceBytes: ownerId === "alpha" ? RECORD.sourceBytes : 0,
      retainedBytes: ownerId === "alpha" ? RECORD.schemaBytes : 0,
      maxRetainedBytes: 4096,
    };
  }

  async get(id: string, ownerId: string): Promise<PublicFileRecord | undefined> {
    return id === FILE_ID && ownerId === "alpha" ? RECORD : undefined;
  }

  async readPrimer(primerId: string): Promise<string> {
    return `primer:${primerId}`;
  }

  async readSchema(id: string, ownerId: string): Promise<string | undefined> {
    return id === FILE_ID && ownerId === "alpha" ? JSON.stringify(SCHEMA) : undefined;
  }

  async query(
    id: string,
    ownerId: string,
    query: StructuredQueryRequest,
  ): Promise<StructuredQueryResponse | undefined> {
    if (query.target !== null && "path" in query.target && query.target.path === "/failure") {
      throw new Error("simulated query failure");
    }
    return id === FILE_ID && ownerId === "alpha"
      ? { query, answer: "5", outputBytes: 1 }
      : undefined;
  }

  async delete(_id: string, _ownerId: string): Promise<boolean> {
    return false;
  }

  async close(): Promise<void> {}
}

let app: FastifyInstance | undefined;
const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await app?.close();
  app = undefined;
});

async function connectClient(endpoint: URL, token: string, name: string): Promise<Client> {
  const client = new Client({ name, version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(endpoint, {
    authProvider: { token: async () => token },
  });
  await client.connect(transport);
  clients.push(client);
  return client;
}

describe("schemagrep MCP endpoint", () => {
  test("authenticates a real Streamable HTTP client and isolates every tool by tenant", async () => {
    app = buildApp({ config: CONFIG, fileService: new McpFileService(), oauthService: OAUTH });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const endpoint = new URL("/mcp", address);

    const unauthenticated = new Client({ name: "unauthenticated", version: "1.0.0" });
    await expect(
      unauthenticated.connect(new StreamableHTTPClientTransport(endpoint)),
    ).rejects.toThrow();

    const alpha = await connectClient(endpoint, ALPHA_KEY, "alpha-client");
    const tools = await alpha.listTools();
    const listing = await alpha.callTool({
      name: "schemagrep_list_files",
      arguments: {},
    });
    const primer = await alpha.callTool({
      name: "schemagrep_get_primer",
      arguments: { primerId: "schemagrep-manifest/v1" },
    });
    const schema = await alpha.callTool({
      name: "schemagrep_get_schema",
      arguments: { fileId: FILE_ID },
    });
    const unchangedSchema = await alpha.callTool({
      name: "schemagrep_get_schema",
      arguments: { fileId: FILE_ID, knownSchemaId: RECORD.schemaId },
    });
    const batch = await alpha.callTool({
      name: "schemagrep_query",
      arguments: {
        fileId: FILE_ID,
        queries: [
          {
            name: "push_count",
            request: {
              mode: "count",
              target: { path: "/type" },
              filters: [],
              value: "push",
            },
          },
          {
            name: "failed_metric",
            request: {
              mode: "argmax",
              target: { path: "/failure" },
              filters: [],
            },
          },
          {
            name: "status_count",
            request: {
              mode: "count",
              target: { path: "/status" },
              filters: [],
              value: 404,
            },
          },
        ],
      },
    });
    const malformedProjection = await alpha.callTool({
      name: "schemagrep_query",
      arguments: {
        fileId: FILE_ID,
        queries: [{
          name: "malformed_projection",
          request: {
            mode: "grep",
            target: { path: "/status" },
            filters: [{ field: { path: "/status" }, op: "ge", value: 400 }],
            limit: 3,
          },
        }],
      },
    });

    const beta = await connectClient(endpoint, BETA_KEY, "beta-client");
    const hidden = await beta.callTool({
      name: "schemagrep_get_schema",
      arguments: { fileId: FILE_ID },
    });

    expect(tools.tools.map((tool) => tool.name)).toEqual([
      "schemagrep_list_files",
      "schemagrep_get_primer",
      "schemagrep_get_schema",
      "schemagrep_query",
    ]);
    expect(tools.tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
    expect(tools.tools.find((tool) => tool.name === "schemagrep_get_schema")?.description).toContain(
      "knownSchemaId",
    );
    expect(tools.tools.find((tool) => tool.name === "schemagrep_get_primer")?.description).toContain(
      "primerId",
    );
    expect(tools.tools.find((tool) => tool.name === "schemagrep_query")?.description).toContain(
      "1-20 named deterministic queries in one call",
    );
    expect(tools.tools.find((tool) => tool.name === "schemagrep_query")?.description).toContain(
      "/payload/size",
    );
    expect(tools.tools.find((tool) => tool.name === "schemagrep_query")?.description).toContain(
      "/columns/N",
    );
    expect(tools.tools.find((tool) => tool.name === "schemagrep_query")?.description).toContain(
      "/fields/N",
    );
    const queryInputSchema = JSON.stringify(
      tools.tools.find((tool) => tool.name === "schemagrep_query")?.inputSchema,
    );
    expect(queryInputSchema).toContain('"path"');
    expect(queryInputSchema).not.toContain('"col"');
    expect(queryInputSchema).not.toContain('"slot"');
    expect(queryInputSchema).not.toContain('"key"');
    expect(listing.structuredContent).toEqual({ files: [RECORD] });
    expect(schema.structuredContent).toEqual({
      fileId: FILE_ID,
      primerId: RECORD.primerId,
      schemaId: RECORD.schemaId,
      unchanged: false,
      schema: SCHEMA,
    });
    expect(unchangedSchema.structuredContent).toEqual({
      fileId: FILE_ID,
      primerId: RECORD.primerId,
      schemaId: RECORD.schemaId,
      unchanged: true,
    });
    expect(primer.structuredContent).toEqual({
      primerId: "schemagrep-manifest/v1",
      primer: "primer:schemagrep-manifest/v1",
    });
    expect(batch.structuredContent).toEqual({
      fileId: FILE_ID,
      results: [
        {
          name: "push_count",
          result: {
            query: {
              mode: "count",
              target: { path: "/type" },
              filters: [],
              value: "push",
            },
            answer: "5",
            outputBytes: 1,
          },
        },
        {
          name: "failed_metric",
          error: {
            code: "internal_error",
            message: "The query could not be completed",
          },
        },
        {
          name: "status_count",
          result: {
            query: {
              mode: "count",
              target: { path: "/status" },
              filters: [],
              value: 404,
            },
            answer: "5",
            outputBytes: 1,
          },
        },
      ],
    });
    expect(malformedProjection.isError).toBe(true);
    expect(hidden.isError).toBe(true);
  });

  test("rejects unapproved Host headers before MCP dispatch", async () => {
    app = buildApp({ config: CONFIG, fileService: new McpFileService(), oauthService: OAUTH });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });

    const response = await fetch(new URL("/mcp", address), {
      headers: {
        authorization: `Bearer ${ALPHA_KEY}`,
        host: "evil.example",
      },
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { message: "Invalid Host: evil.example" },
    });
  });
});
