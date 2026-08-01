import { afterEach, describe, expect, test } from "bun:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { loadConfig } from "../src/config";
import type { FileService, PublicFileRecord, UploadSource } from "../src/files/types";
import type { StructuredQueryRequest, StructuredQueryResponse } from "../src/query/contract";
import { testConfig } from "./support/config";
import { TestManagedOAuthService } from "./support/managed-oauth";

const ALPHA_KEY = "alpha-secret-0123456789abcdef0123456789";
const BETA_KEY = "beta-secret-0123456789abcdef01234567890";
const FILE_ID = "file_abcdef0123456789abcdef0123456789";

const CONFIG = testConfig({
  storageBaseDirectory: "/tmp/schemagrep-cloud-access-tests",
});
const OAUTH = new TestManagedOAuthService(
  "http://127.0.0.1:3199",
  { [ALPHA_KEY]: "alpha", [BETA_KEY]: "beta" },
);

interface OwnedRecord {
  ownerId: string;
  record: PublicFileRecord;
}

class TenantFileService implements FileService {
  private readonly files = new Map<string, OwnedRecord>();

  async ingest(source: UploadSource, ownerId: string): Promise<PublicFileRecord> {
    for await (const _chunk of source.stream) {
      // Consume the multipart stream before responding.
    }
    const record: PublicFileRecord = {
      id: FILE_ID,
      status: "ready",
      codec: "jsonl",
      originalName: source.filename,
      sourceBytes: 9,
      schemaBytes: 9,
      primerId: "schemagrep-manifest/v1",
      schemaId: `sha256:${"0".repeat(64)}`,
      createdAt: "2026-07-29T00:00:00.000Z",
      expiresAt: "2026-07-29T01:00:00.000Z",
    };
    this.files.set(record.id, { ownerId, record });
    return record;
  }

  async list(ownerId: string): Promise<PublicFileRecord[]> {
    return [...this.files.values()]
      .filter((owned) => owned.ownerId === ownerId)
      .map((owned) => owned.record);
  }

  async usage(ownerId: string) {
    const records = await this.list(ownerId);
    return {
      activeFiles: records.length,
      sourceBytes: records.reduce((total, record) => total + record.sourceBytes, 0),
      retainedBytes: records.reduce((total, record) => total + record.schemaBytes, 0),
      maxRetainedBytes: 4096,
    };
  }

  async get(id: string, ownerId: string): Promise<PublicFileRecord | undefined> {
    const owned = this.files.get(id);
    return owned?.ownerId === ownerId ? owned.record : undefined;
  }

  async readPrimer(primerId: string): Promise<string> {
    return `primer:${primerId}`;
  }

  async readSchema(id: string, ownerId: string): Promise<string | undefined> {
    const owned = this.files.get(id);
    return owned?.ownerId === ownerId ? "[schema]\n" : undefined;
  }

  async query(
    id: string,
    ownerId: string,
    query: StructuredQueryRequest,
  ): Promise<StructuredQueryResponse | undefined> {
    const owned = this.files.get(id);
    return owned?.ownerId === ownerId
      ? { query, answer: "1", outputBytes: 1 }
      : undefined;
  }

  async delete(id: string, ownerId: string): Promise<boolean> {
    const owned = this.files.get(id);
    if (owned?.ownerId !== ownerId) return false;
    this.files.delete(id);
    return true;
  }

  async close(): Promise<void> {
    this.files.clear();
  }
}

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("API access control", () => {
  test("leaves health public but requires a bearer key for file routes", async () => {
    app = buildApp({ config: CONFIG, fileService: new TenantFileService(), oauthService: OAUTH });

    const health = await app.inject({ method: "GET", url: "/health" });
    const missing = await app.inject({ method: "GET", url: `/v1/files/${FILE_ID}` });
    const invalid = await app.inject({
      method: "GET",
      url: `/v1/files/${FILE_ID}`,
      headers: { authorization: "Bearer incorrect-key" },
    });
    const lowercaseScheme = await app.inject({
      method: "GET",
      url: `/v1/files/${FILE_ID}`,
      headers: { authorization: `bearer ${ALPHA_KEY}` },
    });

    expect(health.statusCode).toBe(200);
    expect(missing.statusCode).toBe(401);
    expect(missing.headers["www-authenticate"]).toContain("resource_metadata=");
    expect(invalid.statusCode).toBe(401);
    expect(lowercaseScheme.statusCode).toBe(404);
  });

  test("isolates uploaded files by authenticated tenant", async () => {
    app = buildApp({ config: CONFIG, fileService: new TenantFileService(), oauthService: OAUTH });
    const boundary = "tenant-upload-boundary";
    const payload = Buffer.from(
      `--${boundary}\r\n` +
        'Content-Disposition: form-data; name="file"; filename="events.jsonl"\r\n' +
        "Content-Type: application/octet-stream\r\n\r\n" +
        '{"id":1}\n' +
        `\r\n--${boundary}--\r\n`,
    );

    const uploaded = await app.inject({
      method: "POST",
      url: "/v1/files",
      headers: {
        authorization: `Bearer ${ALPHA_KEY}`,
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      payload,
    });
    const alphaRead = await app.inject({
      method: "GET",
      url: `/v1/files/${FILE_ID}`,
      headers: { authorization: `Bearer ${ALPHA_KEY}` },
    });
    const betaRead = await app.inject({
      method: "GET",
      url: `/v1/files/${FILE_ID}`,
      headers: { authorization: `Bearer ${BETA_KEY}` },
    });
    const alphaQuery = await app.inject({
      method: "POST",
      url: `/v1/files/${FILE_ID}/query`,
      headers: {
        authorization: `Bearer ${ALPHA_KEY}`,
        "content-type": "application/json",
      },
      payload: { mode: "rows", target: null, filters: [] },
    });
    const betaQuery = await app.inject({
      method: "POST",
      url: `/v1/files/${FILE_ID}/query`,
      headers: {
        authorization: `Bearer ${BETA_KEY}`,
        "content-type": "application/json",
      },
      payload: { mode: "rows", target: null, filters: [] },
    });
    const betaDelete = await app.inject({
      method: "DELETE",
      url: `/v1/files/${FILE_ID}`,
      headers: { authorization: `Bearer ${BETA_KEY}` },
    });
    const alphaDelete = await app.inject({
      method: "DELETE",
      url: `/v1/files/${FILE_ID}`,
      headers: { authorization: `Bearer ${ALPHA_KEY}` },
    });

    expect(uploaded.statusCode).toBe(201);
    expect(alphaRead.statusCode).toBe(200);
    expect(betaRead.statusCode).toBe(404);
    expect(alphaQuery.statusCode).toBe(200);
    expect(betaQuery.statusCode).toBe(404);
    expect(betaDelete.statusCode).toBe(404);
    expect(alphaDelete.statusCode).toBe(204);
  });

  test("limits each authenticated tenant independently", async () => {
    app = buildApp({
      config: { ...CONFIG, rateLimitMax: 2 },
      fileService: new TenantFileService(),
      oauthService: OAUTH,
    });

    const alphaStatuses: number[] = [];
    for (let requestNumber = 0; requestNumber < 3; requestNumber += 1) {
      const response = await app.inject({
        method: "GET",
        url: `/v1/files/${FILE_ID}`,
        headers: { authorization: `Bearer ${ALPHA_KEY}` },
      });
      alphaStatuses.push(response.statusCode);
    }
    const beta = await app.inject({
      method: "GET",
      url: `/v1/files/${FILE_ID}`,
      headers: { authorization: `Bearer ${BETA_KEY}` },
    });

    expect(alphaStatuses).toEqual([404, 404, 429]);
    expect(beta.statusCode).toBe(404);
    expect(beta.headers["ratelimit-remaining"]).toBe("1");
  });

  test("isolates unauthenticated limits by an explicitly trusted proxy header", async () => {
    app = buildApp({
      config: {
        ...CONFIG,
        rateLimitMax: 1,
        trustedProxyClientIpHeader: "x-real-ip",
      },
      fileService: new TenantFileService(),
      oauthService: OAUTH,
    });
    const first = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { "x-real-ip": "198.51.100.1" },
    });
    const second = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { "x-real-ip": "198.51.100.2" },
    });
    const repeated = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { "x-real-ip": "198.51.100.1" },
    });
    expect([first.statusCode, second.statusCode, repeated.statusCode]).toEqual([401, 401, 429]);
  });
});

describe("managed authentication configuration", () => {
  test("requires managed identity unless authentication is explicitly disabled", () => {
    expect(() => loadConfig({})).toThrow("Managed authentication is required");
    expect(loadConfig({ AUTH_DISABLED: "true" }).authDisabled).toBe(true);
    expect(() => loadConfig({ AUTH_DISABLED: "true", HOST: "0.0.0.0" }))
      .toThrow("loopback-only");
  });

  test("requires every managed identity setting", () => {
    expect(() => loadConfig({ PUBLIC_BASE_URL: "https://app.example.com" })).toThrow(
      "WORKOS_API_KEY is required",
    );
  });

  test("normalizes MCP Host allowlists and rejects URL-shaped entries", () => {
    expect(
      loadConfig({
        AUTH_DISABLED: "true",
        MCP_ALLOWED_HOSTS: "API.EXAMPLE.COM,localhost,api.example.com",
      }).mcpAllowedHostnames,
    ).toEqual(["api.example.com", "localhost"]);
    expect(() =>
      loadConfig({
        AUTH_DISABLED: "true",
        MCP_ALLOWED_HOSTS: "https://api.example.com",
      }),
    ).toThrow("comma-separated hostnames");
  });

  test("accepts only an explicit valid proxy client-IP header", () => {
    expect(loadConfig({
      AUTH_DISABLED: "true",
      TRUSTED_PROXY_CLIENT_IP_HEADER: " CF-Connecting-IP ",
    }).trustedProxyClientIpHeader).toBe("cf-connecting-ip");
    expect(() => loadConfig({
      AUTH_DISABLED: "true",
      TRUSTED_PROXY_CLIENT_IP_HEADER: "x-forwarded-for: spoofed",
    })).toThrow("valid HTTP header name");
  });
  test("requires complete and secure WorkOS configuration", () => {
    const managed = {
      PUBLIC_BASE_URL: "https://app.example.com",
      WORKOS_API_KEY: "sk_test_example",
      WORKOS_CLIENT_ID: "client_example",
      WORKOS_AUTHKIT_URL: "https://example.authkit.app",
      WORKOS_COOKIE_PASSWORD: "cookie-password-0123456789abcdef",
      CSRF_SECRET: "csrf-secret-0123456789abcdef0123",
    };
    expect(loadConfig(managed).publicBaseUrl).toBe("https://app.example.com");
    expect(() => loadConfig({ ...managed, PUBLIC_BASE_URL: "http://app.example.com" }))
      .toThrow("must be HTTPS");
    expect(() => loadConfig({ ...managed, WORKOS_AUTHKIT_URL: "http://localhost:3000" }))
      .toThrow("must be HTTPS");
    expect(() => loadConfig({ ...managed, WORKOS_COOKIE_PASSWORD: "too-short" }))
      .toThrow("32 to 512 UTF-8 bytes");
    expect(loadConfig({ ...managed, PUBLIC_BASE_URL: "http://[::1]:3000" }).publicBaseUrl)
      .toBe("http://[::1]:3000");
  });

});
