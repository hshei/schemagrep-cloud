import { describe, expect, test } from "bun:test";
import { InvalidQueryError } from "../src/files/errors";
import {
  parseStructuredQueryRequest,
  type StructuredQueryRequest,
} from "../src/query/contract";
import {
  buildSchemagrepQueryArgs,
  formatStructuredQueryResponse,
} from "../src/query/execution";

describe("structured query contract", () => {
  test("normalizes a bounded grep request and emits fixed schemagrep arguments", () => {
    const query = parseStructuredQueryRequest({
      mode: "grep",
      target: null,
      filters: [
        { field: { path: "/country_code" }, op: "eq", value: "EU" },
        { field: { path: "/status" }, op: "between", value: [200, 399] },
      ],
    });

    expect(query).toEqual({
      mode: "grep",
      target: null,
      filters: [
        { field: { path: "/country_code" }, op: "eq", value: "EU" },
        { field: { path: "/status" }, op: "between", value: [200, 399] },
      ],
      limit: 20,
    });
    expect(buildSchemagrepQueryArgs(query, 21)).toEqual([
      "--grep",
      "--where",
      "path=/country_code:eq:EU",
      "--where",
      "path=/status:between:200..399",
      "--limit",
      "21",
    ]);
  });

  test("routes numeric exact values through numeric predicate semantics", () => {
    const numeric = parseStructuredQueryRequest({
      mode: "count",
      target: { path: "/status" },
      filters: [],
      value: 404,
    });
    const nullFilter = parseStructuredQueryRequest({
      mode: "count",
      target: null,
      filters: [{ field: { path: "/latency" }, op: "eq", value: null }],
    });

    expect(numeric.value).toBe(404);
    expect(buildSchemagrepQueryArgs(numeric)).toEqual([
      "--count", "--where", "path=/status:eq:404",
    ]);
    expect(nullFilter.filters[0]?.value).toBe("null");
    expect(buildSchemagrepQueryArgs(nullFilter)).toEqual([
      "--count", "--where", "path=/latency:eq:null",
    ]);
  });

  test("detects one additional grep record without returning it", () => {
    const query = {
      mode: "grep",
      target: null,
      filters: [{ field: { path: "/type" }, op: "eq", value: "push" }],
      limit: 2,
    } satisfies StructuredQueryRequest;

    expect(formatStructuredQueryResponse(query, "first\nsecond\nthird\n")).toEqual({
      query,
      records: ["first", "second"],
      recordCount: 2,
      truncated: true,
      outputBytes: 13,
    });
  });

  test("rejects ambiguous, unbounded, and option-injection-shaped requests", () => {
    const invalidRequests: unknown[] = [
      { mode: "rows", target: null, filters: [], command: "cat" },
      { mode: "count", target: { path: "/type" }, filters: [], value: "--rows" },
      { mode: "count", target: { path: "--rows" }, filters: [], value: "push" },
      { mode: "count", target: { path: "payload.size" }, filters: [], value: 10 },
      { mode: "count", target: { col: 0 }, filters: [], value: "push" },
      { mode: "count", target: { slot: 1 }, filters: [], value: "push" },
      { mode: "count", target: { key: "type" }, filters: [], value: "push" },
      { mode: "count", target: null, filters: [{ field: { col: 0 }, op: "eq", value: "push" }] },
      { mode: "count", target: null, filters: [] },
      { mode: "grep", target: null, filters: [{ field: { path: "/id" }, op: "eq", value: "1" }], limit: 101 },
      { mode: "rows", target: null, filters: [{ field: { path: "/id" }, op: "eq", value: "1" }] },
      { mode: "count", target: null, filters: [{ field: { path: "/id" }, op: "between", value: [10, 1] }] },
      {
        mode: "count",
        target: null,
        filters: Array.from({ length: 9 }, () => ({
          field: { path: "/id" },
          op: "eq",
          value: "1",
        })),
      },
    ];

    for (const request of invalidRequests) {
      expect(() => parseStructuredQueryRequest(request)).toThrow(InvalidQueryError);
    }
  });

  test("accepts canonical manifest paths without a nesting-depth cap", () => {
    const deepPath = "/segment".repeat(600);
    for (const path of ["/payload/size", "/columns/0", "/fields/7", deepPath]) {
      expect(parseStructuredQueryRequest({
        mode: "count",
        target: { path },
        filters: [],
        value: "present",
      }).target).toEqual({ path });
    }

    expect(() => parseStructuredQueryRequest({
      mode: "count",
      target: null,
      filters: [{ field: { path: "payload.size" }, op: "ge", value: 10 }],
    })).toThrow("filters[0].field.path must be a canonical manifest path");
  });
});
