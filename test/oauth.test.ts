import { afterEach, describe, expect, test } from "bun:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import type { FileService, PublicFileRecord, UploadSource } from "../src/files/types";
import type { StructuredQueryRequest, StructuredQueryResponse } from "../src/query/contract";
import { testConfig } from "./support/config";
import { TestManagedOAuthService } from "./support/managed-oauth";

const FILE: PublicFileRecord = {
  id: "file_0123456789abcdef0123456789abcdef",
  status: "ready",
  codec: "jsonl",
  originalName: "events.jsonl",
  sourceBytes: 100,
  schemaBytes: 50,
  primerId: "schemagrep-manifest/v1",
  schemaId: `sha256:${"0".repeat(64)}`,
  createdAt: "2026-07-30T00:00:00.000Z",
  expiresAt: "2026-07-30T01:00:00.000Z",
};

class ManagedIdentityFileService implements FileService {
  async ingest(_source: UploadSource, _ownerId: string): Promise<PublicFileRecord> { return FILE; }
  async list(ownerId: string): Promise<PublicFileRecord[]> {
    return ["oauth-tenant", "browser-tenant"].includes(ownerId) ? [FILE] : [];
  }
  async usage(ownerId: string) {
    const active = ["oauth-tenant", "browser-tenant"].includes(ownerId);
    return {
      activeFiles: active ? 1 : 0,
      sourceBytes: active ? 100 : 0,
      retainedBytes: active ? 150 : 0,
      maxRetainedBytes: 4096,
    };
  }
  async get(id: string, ownerId: string): Promise<PublicFileRecord | undefined> {
    return id === FILE.id && ["oauth-tenant", "browser-tenant"].includes(ownerId)
      ? FILE
      : undefined;
  }
  async readPrimer(primerId: string): Promise<string> {
    return `primer:${primerId}`;
  }

  async readSchema(id: string, ownerId: string): Promise<string | undefined> {
    return id === FILE.id && ["oauth-tenant", "browser-tenant"].includes(ownerId)
      ? "[schema]\n"
      : undefined;
  }
  async query(
    id: string,
    ownerId: string,
    query: StructuredQueryRequest,
  ): Promise<StructuredQueryResponse | undefined> {
    return id === FILE.id && ["oauth-tenant", "browser-tenant"].includes(ownerId)
      ? { query, answer: "8", outputBytes: 1 }
      : undefined;
  }
  async delete(_id: string, _ownerId: string): Promise<boolean> { return false; }
  async close(): Promise<void> {}
}

class CookieJar {
  private readonly cookies = new Map<string, string>();

  async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.cookies.size > 0) {
      headers.set("cookie", [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; "));
    }
    const response = await fetch(url, { ...init, headers, redirect: "manual" });
    const cookieHeaders = response.headers as Headers & { getSetCookie?: () => string[] };
    const fallback = response.headers.get("set-cookie");
    const values = cookieHeaders.getSetCookie?.() ?? (fallback === null ? [] : [fallback]);
    for (const value of values) {
      const pair = value.split(";", 1)[0];
      if (pair === undefined) continue;
      const separator = pair.indexOf("=");
      if (separator <= 0) continue;
      const name = pair.slice(0, separator);
      const cookieValue = pair.slice(separator + 1);
      if (cookieValue.length === 0) this.cookies.delete(name);
      else this.cookies.set(name, cookieValue);
    }
    return response;
  }
}

let app: FastifyInstance | undefined;
let client: Client | undefined;

afterEach(async () => {
  await client?.close();
  client = undefined;
  await app?.close();
  app = undefined;
});

describe("managed WorkOS identity integration", () => {
  test("publishes OAuth discovery and stable CLI client metadata", async () => {
    const oauth = new TestManagedOAuthService("https://service.example");
    app = buildApp({
      config: testConfig(),
      fileService: new ManagedIdentityFileService(),
      oauthService: oauth,
    });

    const resource = await app.inject({
      method: "GET",
      url: "/.well-known/oauth-protected-resource/mcp",
    });
    const authorization = await app.inject({
      method: "GET",
      url: "/.well-known/oauth-authorization-server",
    });
    const clientMetadata = await app.inject({
      method: "GET",
      url: "/oauth/client/schemagrep-cli",
    });
    const challenge = await app.inject({ method: "POST", url: "/mcp" });

    expect(resource.statusCode).toBe(200);
    expect(resource.json()).toMatchObject({
      resource: "https://service.example/mcp",
      authorization_servers: ["https://identity.example"],
    });
    expect(authorization.statusCode).toBe(200);
    expect(authorization.json()).toMatchObject({
      issuer: "https://identity.example",
      client_id_metadata_document_supported: true,
    });
    expect(clientMetadata.statusCode).toBe(200);
    expect(clientMetadata.json()).toMatchObject({
      client_id: "https://service.example/oauth/client/schemagrep-cli",
      token_endpoint_auth_method: "none",
    });
    expect(challenge.statusCode).toBe(401);
    expect(challenge.headers["www-authenticate"]).toContain("resource_metadata=");
  });

  test("completes browser login and enforces CSRF on cookie mutations", async () => {
    const oauth = new TestManagedOAuthService();
    app = buildApp({
      config: testConfig(),
      fileService: new ManagedIdentityFileService(),
      oauthService: oauth,
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const jar = new CookieJar();

    const login = await jar.fetch(`${address}/login`);
    expect(login.status).toBe(302);
    const authorization = new URL(login.headers.get("location") as string);
    const state = authorization.searchParams.get("state");
    expect(state).toBeString();

    const invalidCallback = await jar.fetch(
      `${address}/callback?code=valid-code&state=wrong-state`,
    );
    expect(invalidCallback.status).toBe(400);

    const retryLogin = await jar.fetch(`${address}/login`);
    const retryAuthorization = new URL(retryLogin.headers.get("location") as string);
    const retryState = retryAuthorization.searchParams.get("state");
    const callback = await jar.fetch(
      `${address}/callback?code=valid-code&state=${encodeURIComponent(retryState as string)}`,
    );
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("/");

    const session = await jar.fetch(`${address}/v1/session`);
    expect(session.status).toBe(200);
    expect(await session.json()).toMatchObject({
      authenticated: true,
      oauth: true,
      email: "browser@example.com",
      name: "Browser User",
    });

    const queryBody = JSON.stringify({ mode: "rows", target: null, filters: [] });
    const rejected = await jar.fetch(`${address}/v1/files/${FILE.id}/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: queryBody,
    });
    expect(rejected.status).toBe(403);

    const csrfResponse = await jar.fetch(`${address}/csrf-token`);
    const { csrfToken } = await csrfResponse.json() as { csrfToken: string };
    const accepted = await jar.fetch(`${address}/v1/files/${FILE.id}/query`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-csrf-token": csrfToken,
      },
      body: queryBody,
    });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ answer: "8" });

    const logout = await jar.fetch(`${address}/logout`, {
      method: "POST",
      headers: { accept: "application/json", "x-csrf-token": csrfToken },
    });
    expect(logout.status).toBe(200);
    expect(await logout.json()).toEqual({ redirect: "https://identity.example/logout" });
    const signedOut = await jar.fetch(`${address}/v1/session`);
    expect(await signedOut.json()).toMatchObject({ authenticated: false });
  });

  test("authenticates a real MCP client with a managed bearer token", async () => {
    const oauth = new TestManagedOAuthService(
      "http://127.0.0.1:3199",
      { "managed-access-token": "oauth-tenant" },
    );
    app = buildApp({
      config: testConfig(),
      fileService: new ManagedIdentityFileService(),
      oauthService: oauth,
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    client = new Client({ name: "managed-oauth-test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", address), {
      authProvider: { token: async () => "managed-access-token" },
    }));

    const listing = await client.callTool({
      name: "schemagrep_list_files",
      arguments: {},
    });
    expect(listing.structuredContent).toEqual({ files: [FILE] });
  });
});
