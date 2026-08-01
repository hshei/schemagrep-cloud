import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { InvalidQueryError, SchemagrepProcessError } from "../files/errors";
import { FILE_ID_PATTERN } from "../files/id";
import type { FileService } from "../files/types";
import {
  parseStructuredQueryRequest,
  type StructuredQueryResponse,
} from "../query/contract";

const canonicalPathSchema = z.string()
  .min(1)
  .regex(
    /^(?:\/(?:\*|(?:[^~/%\u0000-\u001f\u007f:*]|~[01]|%[0-9A-F]{2})*))+$/u,
    "Use the canonical path from the manifest, such as /payload/size",
  )
  .describe("Exact field coordinate.path copied from the selected file manifest.");

const queryFieldSchema = z.strictObject({ path: canonicalPathSchema });

const exactValueSchema = z.union([
  z.string().max(4096),
  z.number().finite(),
  z.null(),
]);

const queryFilterSchema = z.discriminatedUnion("op", [
  z.strictObject({
    field: queryFieldSchema,
    op: z.enum(["eq", "ne"]),
    value: exactValueSchema,
  }),
  z.strictObject({
    field: queryFieldSchema,
    op: z.enum(["gt", "ge", "lt", "le"]),
    value: z.number().finite(),
  }),
  z.strictObject({
    field: queryFieldSchema,
    op: z.literal("between"),
    value: z.tuple([z.number().finite(), z.number().finite()]),
  }),
]);

const fileIdSchema = z.string().regex(FILE_ID_PATTERN);
const primerIdSchema = z.literal("schemagrep-manifest/v1");
const schemaIdSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const filtersSchema = z.array(queryFilterSchema).max(8);
const templateSchema = z.number().int().min(0).max(1_000_000).optional();
const grepLimitSchema = z.number().int().min(1).max(100).optional()
  .describe('Only for mode "grep".');
const MAX_QUERY_BATCH_SIZE = 20;
const MAX_QUERY_BATCH_OUTPUT_BYTES = 1024 * 1024;

const queryRequestToolSchema = z.union([
  z.strictObject({
    mode: z.literal("rows"),
    target: z.null(),
    filters: z.array(queryFilterSchema).max(0),
  }),
  z.strictObject({
    mode: z.enum(["min", "max", "distinct", "const"]),
    target: queryFieldSchema,
    filters: z.array(queryFilterSchema).max(0),
    template: templateSchema,
  }),
  z.strictObject({
    mode: z.enum(["sum", "avg", "argmax", "argmin"]),
    target: queryFieldSchema,
    filters: filtersSchema,
    template: templateSchema,
  }),
  z.strictObject({
    mode: z.literal("count"),
    target: queryFieldSchema,
    filters: filtersSchema,
    value: exactValueSchema,
    template: templateSchema,
  }),
  z.strictObject({
    mode: z.literal("count"),
    target: z.null(),
    filters: filtersSchema.min(1),
    template: templateSchema,
  }),
  z.strictObject({
    mode: z.literal("grep"),
    target: queryFieldSchema,
    filters: filtersSchema,
    value: exactValueSchema,
    limit: grepLimitSchema,
    template: templateSchema,
  }),
  z.strictObject({
    mode: z.literal("grep"),
    target: z.null(),
    filters: filtersSchema.min(1),
    limit: grepLimitSchema,
    template: templateSchema,
  }),
]);

const queryToolInputSchema = z.strictObject({
  fileId: fileIdSchema,
  queries: z.array(z.strictObject({
    name: z.string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z][A-Za-z0-9_-]*$/),
    request: queryRequestToolSchema,
  })).min(1).max(MAX_QUERY_BATCH_SIZE),
});

const fileRecordSchema = z.strictObject({
  id: z.string(),
  status: z.literal("ready"),
  codec: z.enum(["csv", "json", "jsonl", "log"]),
  originalName: z.string(),
  sourceBytes: z.number(),
  schemaBytes: z.number(),
  primerId: primerIdSchema,
  schemaId: schemaIdSchema,
  createdAt: z.string(),
  expiresAt: z.string(),
});
const listFilesOutputSchema = z.strictObject({
  files: z.array(fileRecordSchema),
});
const primerToolOutputSchema = z.strictObject({
  primerId: primerIdSchema,
  primer: z.string(),
});

const schemaToolOutputSchema = z.discriminatedUnion("unchanged", [
  z.strictObject({
    fileId: fileIdSchema,
    primerId: primerIdSchema,
    schemaId: schemaIdSchema,
    unchanged: z.literal(false),
    schema: z.record(z.string(), z.unknown()),
  }),
  z.strictObject({
    fileId: fileIdSchema,
    primerId: primerIdSchema,
    schemaId: schemaIdSchema,
    unchanged: z.literal(true),
  }),
]);
const queryErrorSchema = z.strictObject({
  code: z.string(),
  message: z.string(),
});
const queryToolOutputSchema = z.strictObject({
  fileId: z.string(),
  results: z.array(z.union([
    z.strictObject({
      name: z.string(),
      result: z.record(z.string(), z.unknown()),
    }),
    z.strictObject({
      name: z.string(),
      error: queryErrorSchema,
    }),
  ])),
});

type NamedQueryResult =
  | { name: string; result: StructuredQueryResponse }
  | { name: string; error: { code: string; message: string } };

function errorResult(code: string, message: string) {
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: JSON.stringify({ error: { code, message } }) }],
  };
}

function successfulResult<T extends Record<string, unknown>>(value: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function queryFailure(error: unknown): { code: string; message: string } {
  if (error instanceof InvalidQueryError) {
    return { code: "invalid_query", message: error.message };
  }
  if (error instanceof SchemagrepProcessError) {
    if (error.kind === "output_limit") {
      return { code: "query_output_too_large", message: "Query output exceeds the service limit" };
    }
    if (error.kind === "timeout") {
      return { code: "query_timeout", message: "Query exceeded its execution timeout" };
    }
    if (error.kind === "spawn") {
      return { code: "processor_unavailable", message: "Query processor is unavailable" };
    }
    return { code: "query_failed", message: "The query could not be executed" };
  }
  return { code: "internal_error", message: "The query could not be completed" };
}

function createTenantServer(
  fileService: FileService,
  tenantId: string,
  reportError: (error: Error) => void,
): McpServer {
  const server = new McpServer(
    { name: "schemagrep-cloud", version: "0.0.0" },
    {
      instructions:
        "Use schemagrep_list_files when the user has not provided a file ID. File records advertise immutable primerId and content-addressed schemaId values. Read each primer once with schemagrep_get_primer before interpreting manifests, then cache it by primerId for the conversation. Before the first data query for a selected file, call schemagrep_get_schema. Cache full schema responses by schemaId; when that schemaId is already cached, send it as knownSchemaId so an unchanged response avoids retransmission. Do not fetch a selected file's schema again during follow-up questions unless the earlier call failed or its advertised schemaId changed. Put every independent source operation needed for the current answer into one schemagrep_query call. Every field coordinate is an exact path copied from the manifest: JSON/JSONL paths such as /payload/size, CSV /columns/N paths, or log /fields/N paths. Guesses, leaf keys, and dotted paths are unsupported. Use manifest facts directly when conclusive; otherwise use schemagrep_query. For filter-only count or grep, target must be null. grep returns complete matching records, not a projected target field. Use argmax or argmin directly when both the extremum and its count are requested. Set limit only for grep. Never infer a total count from limited grep evidence.",
    },
  );

  server.registerTool(
    "schemagrep_list_files",
    {
      title: "List uploaded files",
      description:
        "List the authenticated tenant's active uploaded files with IDs, names, codecs, sizes, and expiration times. Use this when the user refers to a file by name or has not supplied a file ID.",
      inputSchema: z.strictObject({}),
      outputSchema: listFilesOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      try {
        return successfulResult({ files: await fileService.list(tenantId) });
      } catch (error) {
        reportError(error instanceof Error ? error : new Error(String(error)));
        return errorResult("internal_error", "Files could not be listed");
      }
    },
  );
  server.registerTool(
    "schemagrep_get_primer",
    {
      title: "Read schemagrep query primer",
      description:
        "Read one immutable, versioned query-protocol primer by the primerId supplied in a file manifest. Cache the successful result by primerId for the conversation; call again only after failure or when a manifest names a different primerId.",
      inputSchema: z.strictObject({ primerId: primerIdSchema }),
      outputSchema: primerToolOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ primerId }) => {
      try {
        return successfulResult({
          primerId,
          primer: await fileService.readPrimer(primerId),
        });
      } catch (error) {
        reportError(error instanceof Error ? error : new Error(String(error)));
        return errorResult("internal_error", "The query primer could not be read");
      }
    },
  );


  server.registerTool(
    "schemagrep_get_schema",
    {
      title: "Read schemagrep schema",
      description:
        "Read a tenant-owned file's compact manifest. Cache full responses by schemaId. If knownSchemaId is already cached, supply it to receive unchanged=true without retransmitting the schema.",
      inputSchema: z.strictObject({
        fileId: fileIdSchema,
        knownSchemaId: schemaIdSchema.optional(),
      }),
      outputSchema: schemaToolOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ fileId, knownSchemaId }) => {
      try {
        const file = await fileService.get(fileId, tenantId);
        if (file === undefined) {
          return errorResult("file_not_found", "File does not exist or has expired");
        }
        const identity = {
          fileId,
          primerId: file.primerId,
          schemaId: file.schemaId,
        };
        if (knownSchemaId === file.schemaId) {
          return successfulResult({ ...identity, unchanged: true as const });
        }
        const schema = await fileService.readSchema(fileId, tenantId);
        if (schema === undefined) {
          return errorResult("file_not_found", "File does not exist or has expired");
        }
        return successfulResult({
          ...identity,
          unchanged: false as const,
          schema: JSON.parse(schema) as Record<string, unknown>,
        });
      } catch (error) {
        reportError(error instanceof Error ? error : new Error(String(error)));
        return errorResult("internal_error", "The schema could not be read");
      }
    },
  );

  server.registerTool(
    "schemagrep_query",
    {
      title: "Query an uploaded file",
      description:
        "Run 1-20 named deterministic queries in one call; group every independent operation needed for the current answer into this batch. Each request supports: rows for the total; count/grep with target+value or target=null plus filters; min/max/distinct/const with an unfiltered target; and sum/avg/argmax/argmin with a target and optional ANDed filters. argmax/argmin return the extremum and count together. Copy every target or filter path exactly from its manifest field coordinate: JSON/JSONL paths such as /payload/size, CSV /columns/N paths, or log /fields/N paths. Never guess from a name or pattern. limit is legal only for grep. A failed operation returns an error beside its name without discarding successful sibling results. Combined result data is capped at 1 MiB.",
      inputSchema: queryToolInputSchema,
      outputSchema: queryToolOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ fileId, queries }) => {
      try {
        if (new Set(queries.map(({ name }) => name)).size !== queries.length) {
          throw new InvalidQueryError("Query names must be unique within one batch");
        }
        const planned = queries.map(({ name, request }) => ({
          name,
          query: parseStructuredQueryRequest(request),
        }));
        const results: NamedQueryResult[] = [];
        let outputBytes = 0;
        for (const { name, query } of planned) {
          let result: StructuredQueryResponse | undefined;
          try {
            result = await fileService.query(fileId, tenantId, query);
          } catch (error) {
            if (!(error instanceof InvalidQueryError)) {
              reportError(error instanceof Error ? error : new Error(String(error)));
            }
            results.push({ name, error: queryFailure(error) });
            continue;
          }
          if (result === undefined) {
            return errorResult("file_not_found", "File does not exist or has expired");
          }
          outputBytes += result.outputBytes;
          if (outputBytes > MAX_QUERY_BATCH_OUTPUT_BYTES) {
            return errorResult(
              "query_output_too_large",
              "Combined query output exceeds the 1 MiB MCP batch limit",
            );
          }
          results.push({ name, result });
        }
        return successfulResult({ fileId, results });
      } catch (error) {
        if (!(error instanceof InvalidQueryError)) {
          reportError(error instanceof Error ? error : new Error(String(error)));
        }
        const failure = queryFailure(error);
        return errorResult(failure.code, failure.message);
      }
    },
  );

  return server;
}

export function createSchemagrepMcpHandler(
  fileService: FileService,
  reportError: (error: Error) => void,
) {
  return createMcpHandler(
    ({ authInfo }) => {
      if (authInfo === undefined) throw new Error("MCP authentication context is missing");
      return createTenantServer(fileService, authInfo.clientId, reportError);
    },
    {
      legacy: "stateless",
      onerror: reportError,
    },
  );
}
