import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { summarizeProductTelemetry } from "../src/telemetry/product";
import { testConfig } from "./support/config";
import { TestManagedOAuthService } from "./support/managed-oauth";

const MANAGED_TOKEN = "managed-dashboard-access-token";
const temporaryDirectories: string[] = [];
let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })));
});

describe("hosted managed application", () => {
  test("reports service readiness", async () => {
    app = buildApp({ config: testConfig({ authDisabled: true }) });

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    const body: unknown = JSON.parse(response.body);
    expect(body).toEqual({
      service: "schemagrep-cloud",
      status: "ok",
    });
  });

  test("serves a public dashboard with isolated browser assets", async () => {
    app = buildApp({
      config: testConfig(),
      oauthService: new TestManagedOAuthService(),
    });

    const page = await app.inject({ method: "GET", url: "/" });
    const stylesheet = await app.inject({ method: "GET", url: "/assets/dashboard.css" });
    const script = await app.inject({ method: "GET", url: "/assets/dashboard.js" });
    const font = await app.inject({ method: "GET", url: "/assets/manrope-latin-wght-normal.woff2" });

    expect(page.statusCode).toBe(200);
    expect(page.headers["content-type"]).toContain("text/html");
    expect(page.headers["cache-control"]).toBe("no-store");
    expect(page.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(page.headers["x-frame-options"]).toBe("DENY");
    expect(page.body).toContain("Sign in to your workspace");
    expect(page.body).toContain("Raw upload");
    expect(stylesheet.statusCode).toBe(200);
    expect(stylesheet.headers["content-type"]).toContain("text/css");
    expect(script.statusCode).toBe(200);
    expect(script.headers["content-type"]).toContain("text/javascript");
    expect(font.statusCode).toBe(200);
    expect(font.headers["content-type"]).toContain("font/woff2");
    expect(font.headers["cache-control"]).toContain("immutable");
  });

  test("reports managed session status without exposing the tenant and records aggregate use", async () => {
    const directory = await mkdtemp(join(tmpdir(), "schemagrep-cloud-app-test-"));
    temporaryDirectories.push(directory);
    const telemetryPath = join(directory, "metrics", "product.jsonl");
    const oauthService = new TestManagedOAuthService(
      "http://127.0.0.1:3199",
      { [MANAGED_TOKEN]: "managed-user-subject" },
    );
    app = buildApp({
      config: testConfig({
        productTelemetryPath: telemetryPath,
        productTelemetryHashKey: "dashboard-telemetry-test-0123456789abcdef",
      }),
      oauthService,
    });

    const unauthorized = await app.inject({ method: "GET", url: "/v1/session" });
    const authorized = await app.inject({
      method: "GET",
      url: "/v1/session",
      headers: { authorization: `Bearer ${MANAGED_TOKEN}` },
    });
    await app.close();
    app = undefined;

    expect(unauthorized.statusCode).toBe(200);
    expect(JSON.parse(unauthorized.body)).toEqual({ authenticated: false, oauth: true });
    expect(authorized.statusCode).toBe(200);
    expect(JSON.parse(authorized.body)).toEqual({ authenticated: true, oauth: true });
    expect(authorized.body).not.toContain("managed-user-subject");
    expect(await summarizeProductTelemetry(telemetryPath)).toMatchObject({
      events: 1,
      activeTenants: 1,
      byAction: { session: 1 },
      byOutcome: { ok: 1 },
    });
  });
});
