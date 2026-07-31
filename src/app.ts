import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";
import Fastify, {
  type FastifyInstance,
  type HookHandlerDoneFunction,
} from "fastify";
import cookie from "@fastify/cookie";
import csrfProtection from "@fastify/csrf-protection";
import multipart from "@fastify/multipart";
import type { AuthInfo } from "@modelcontextprotocol/server";
import { loadConfig, type ServiceConfig } from "./config";
import { registerFileRoutes } from "./files/routes";
import { createFileService } from "./files/service";
import type { FileService } from "./files/types";
import { FixedWindowRateLimiter } from "./security/rate-limit";
import { registerMcpRoutes } from "./mcp/routes";
import { registerDashboardRoutes } from "./web/routes";
import {
  ProductTelemetry,
  type ProductTelemetryInput,
} from "./telemetry/product";
import { registerFeedbackRoutes } from "./feedback/routes";
import { FeedbackStore } from "./feedback/store";
import {
  SESSION_COOKIE_NAME,
  WorkOSOAuthService,
  type AuthenticatedIdentity,
  type ManagedOAuthService,
} from "./oauth/provider";
import {
  CLI_CLIENT_METADATA_PATH,
  OAUTH_SCOPES,
  RESOURCE_PERMISSIONS,
} from "./oauth/constants";
import { registerOAuthRoutes } from "./oauth/routes";

const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface BuildAppOptions {
  logger?: boolean;
  config?: ServiceConfig;
  fileService?: FileService;
  productTelemetry?: ProductTelemetry;
  feedbackStore?: FeedbackStore;
  oauthService?: ManagedOAuthService;
}

function productAction(method: string, route: string): ProductTelemetryInput["action"] | undefined {
  if (method === "GET" && route === "/v1/session") return "session";
  if (method === "POST" && route === "/v1/files") return "upload";
  if (method === "GET" && route === "/v1/files/:id") return "metadata";
  if (method === "GET" && route === "/v1/files/:id/schema") return "schema";
  if (method === "POST" && route === "/v1/files/:id/query") return "query";
  if (method === "DELETE" && route === "/v1/files/:id") return "delete";
  if (method === "POST" && route === "/v1/feedback") return "feedback";
  return undefined;
}

function statusClass(statusCode: number): ProductTelemetryInput["status"] {
  if (statusCode < 300) return "2xx";
  if (statusCode < 400) return "3xx";
  if (statusCode < 500) return "4xx";
  return "5xx";
}

function bearerToken(authorization: string | undefined): string | undefined {
  const match = /^Bearer[ \t]+([^ \t]+)[ \t]*$/iu.exec(authorization ?? "");
  return match?.[1];
}

function clientAddress(
  request: IncomingMessage,
  trustedProxyClientIpHeader: string | undefined,
): string {
  const remoteAddress = request.socket.remoteAddress ?? "unknown";
  const trustedLoopback = remoteAddress === "127.0.0.1" ||
    remoteAddress === "::1" ||
    remoteAddress === "::ffff:127.0.0.1";
  if (!trustedLoopback || trustedProxyClientIpHeader === undefined) return remoteAddress;
  const forwarded = request.headers[trustedProxyClientIpHeader];
  if (Array.isArray(forwarded)) return remoteAddress;
  const candidate = forwarded?.trim();
  return candidate !== undefined && isIP(candidate) !== 0 ? candidate : remoteAddress;
}

function localDevelopmentIdentity(): AuthenticatedIdentity {
  const tenantId = "local-development";
  return {
    tenantId,
    authInfo: {
      token: "[authentication-disabled]",
      clientId: tenantId,
      scopes: [...RESOURCE_PERMISSIONS],
    },
    name: "Local development",
  };
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const config = options.config ?? loadConfig();
  const fileService = options.fileService ?? createFileService(config);
  const app = Fastify({ logger: options.logger ?? false });

  const productTelemetry = options.productTelemetry
    ?? (config.productTelemetryPath !== undefined && config.productTelemetryHashKey !== undefined
      ? new ProductTelemetry(
        config.productTelemetryPath,
        config.productTelemetryHashKey,
        (error) => app.log.error({ err: error }, "Product telemetry write failed"),
      )
      : undefined);
  const feedbackStore = options.feedbackStore
    ?? (config.feedbackPath !== undefined && config.feedbackRetentionMs !== undefined
      ? new FeedbackStore(config.feedbackPath, config.feedbackRetentionMs)
      : undefined);

  let oauth = options.oauthService;
  if (!config.authDisabled && oauth === undefined) {
    if (config.publicBaseUrl === undefined || config.workos === undefined) {
      throw new Error("Managed WorkOS authentication is not configured");
    }
    oauth = new WorkOSOAuthService(config.publicBaseUrl, config.workos);
  }

  const cookieSecret = config.workos?.csrfSecret ?? randomBytes(32).toString("base64url");
  app.register(cookie, { secret: cookieSecret, hook: "onRequest" });
  app.register(csrfProtection, {
    cookieKey: "sg_csrf",
    cookieOpts: {
      path: "/",
      httpOnly: true,
      sameSite: "strict",
      secure: oauth?.secureCookies ?? false,
      signed: true,
    },
    getToken: (request) => {
      const value = request.headers["x-csrf-token"];
      return Array.isArray(value) ? undefined : value;
    },
  });
  const rateLimiter = new FixedWindowRateLimiter(config.rateLimitMax, config.rateLimitWindowMs);
  const oauthRateLimiter = new FixedWindowRateLimiter(config.rateLimitMax, config.rateLimitWindowMs);
  const publicRoutes = new Set([
    "/",
    "/health",
    "/ready",
    "/login",
    "/callback",
    "/logout",
    "/csrf-token",
    "/v1/session",
    "/assets/dashboard.css",
    "/assets/dashboard.js",
    "/assets/manrope-latin-wght-normal.woff2",
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/mcp",
    "/.well-known/oauth-authorization-server",
    CLI_CLIENT_METADATA_PATH,
  ]);
  app.decorateRequest("tenantId", "");
  app.decorateRequest("authInfo", null);
  app.decorateRequest("authMethod", null);
  app.decorateRequest("userEmail", "");
  app.decorateRequest("userName", "");

  app.register(registerDashboardRoutes);
  if (oauth !== undefined) app.register(registerOAuthRoutes, { oauth });

  app.get("/health", async () => ({
    service: "schemagrep-cloud",
    status: "ok",
  }));
  app.get("/ready", async (_request, reply) => {
    try {
      await fileService.ready?.();
      return { service: "schemagrep-cloud", status: "ready" };
    } catch (error) {
      app.log.error({ err: error }, "Readiness check failed");
      return reply.code(503).send({ service: "schemagrep-cloud", status: "unavailable" });
    }
  });

  app.register(multipart, {
    limits: {
      fileSize: config.maxUploadBytes,
      files: 1,
      fields: 0,
      parts: 1,
    },
    throwFileSizeLimit: true,
  });

  app.addHook("onRequest", async (request, reply) => {
    const route = request.routeOptions.url ?? "";
    const requestPath = request.url.split("?", 1)[0] ?? "";
    let authenticated: AuthenticatedIdentity | undefined;
    let authMethod: "disabled" | "bearer" | "session" | undefined;

    if (config.authDisabled) {
      authenticated = localDevelopmentIdentity();
      authMethod = "disabled";
    } else if (oauth !== undefined) {
      const token = bearerToken(request.headers.authorization);
      if (token !== undefined) {
        authenticated = await oauth.authenticateBearer(token);
        if (authenticated !== undefined) authMethod = "bearer";
      }
      if (authenticated === undefined) {
        const sealedSession = request.cookies[SESSION_COOKIE_NAME];
        if (sealedSession !== undefined) {
          const browser = await oauth.authenticateBrowserSession(sealedSession);
          if (browser !== undefined) {
            authenticated = browser.identity;
            authMethod = "session";
            if (browser.sealedSession !== undefined) {
              reply.setCookie(SESSION_COOKIE_NAME, browser.sealedSession, {
                path: "/",
                httpOnly: true,
                sameSite: "lax",
                secure: oauth.secureCookies,
                maxAge: SESSION_TTL_SECONDS,
              });
            }
          }
        }
      }
    }

    if (authenticated !== undefined && authMethod !== undefined) {
      request.tenantId = authenticated.tenantId;
      request.authInfo = authenticated.authInfo;
      request.authMethod = authMethod;
      request.userEmail = authenticated.email ?? "";
      request.userName = authenticated.name ?? "";
    }

    const publicRequest = publicRoutes.has(route);
    if (publicRequest) {
      if (["/login", "/callback"].includes(requestPath)) {
        const decision = oauthRateLimiter.consume(
          `oauth:${clientAddress(request.raw, config.trustedProxyClientIpHeader)}`,
        );
        const resetSeconds = Math.max(1, Math.ceil((decision.resetAt - Date.now()) / 1000));
        reply.headers({
          "ratelimit-limit": decision.limit,
          "ratelimit-remaining": decision.remaining,
          "ratelimit-reset": resetSeconds,
        });
        if (!decision.allowed) {
          await reply
            .header("retry-after", resetSeconds)
            .code(429)
            .send({ error: { code: "rate_limit_exceeded", message: "Authentication request limit exceeded" } });
          return reply;
        }
      }
      return;
    }

    const decision = rateLimiter.consume(
      authenticated?.tenantId ??
        `unauthenticated:${clientAddress(request.raw, config.trustedProxyClientIpHeader)}`,
    );
    const resetSeconds = Math.max(1, Math.ceil((decision.resetAt - Date.now()) / 1000));
    reply.headers({
      "ratelimit-limit": decision.limit,
      "ratelimit-remaining": decision.remaining,
      "ratelimit-reset": resetSeconds,
    });
    if (!decision.allowed) {
      await reply
        .header("retry-after", resetSeconds)
        .code(429)
        .send({ error: { code: "rate_limit_exceeded", message: "Request limit exceeded" } });
      return reply;
    }
    if (authenticated === undefined) {
      const challenge = oauth === undefined
        ? "Bearer"
        : `Bearer resource_metadata="${oauth.resourceMetadataUrl}", scope="${OAUTH_SCOPES.join(" ")}"`;
      await reply
        .header("www-authenticate", challenge)
        .code(401)
        .send({ error: { code: "unauthorized", message: "A valid managed identity is required" } });
      return reply;
    }
  });

  app.addHook(
    "preHandler",
    (request, reply, done: HookHandlerDoneFunction) => {
      const unsafeMethod = !["GET", "HEAD", "OPTIONS"].includes(request.method);
      if (request.authMethod !== "session" || !unsafeMethod) {
        done();
        return;
      }
      app.csrfProtection(request, reply, done);
    },
  );

  app.addHook("onResponse", (request, reply, done) => {
    const action = productAction(request.method, request.routeOptions.url ?? "");
    if (action !== undefined && request.tenantId.length > 0) {
      productTelemetry?.record({
        tenantId: request.tenantId,
        action,
        outcome: reply.statusCode < 400 ? "ok" : "error",
        status: statusClass(reply.statusCode),
        durationMs: reply.elapsedTime,
      });
    }
    done();
  });

  app.get("/v1/session", async (request, reply) => reply
    .header("cache-control", "no-store")
    .send({
      authenticated: request.authInfo !== null,
      oauth: oauth !== undefined,
      ...(request.userEmail.length === 0 ? {} : { email: request.userEmail }),
      ...(request.userName.length === 0 ? {} : { name: request.userName }),
    }));
  app.get("/v1/usage", async (request, reply) => {
    const [storage, activity] = await Promise.all([
      fileService.usage(request.tenantId),
      productTelemetry?.summarizeTenant(request.tenantId) ?? Promise.resolve({
        events: 0,
        successfulUploads: 0,
        queries: 0,
        schemaReads: 0,
        mcpRequests: 0,
        errors: 0,
      }),
    ]);
    return reply.header("cache-control", "no-store").send({ storage, activity });
  });
  app.register(registerFeedbackRoutes, {
    ...(feedbackStore === undefined ? {} : { feedbackStore }),
  });
  app.register(registerFileRoutes, { fileService });
  app.register(registerMcpRoutes, {
    fileService,
    allowedHostnames: config.mcpAllowedHostnames,
    ...(productTelemetry === undefined ? {} : { productTelemetry }),
  });
  app.addHook("onClose", async () => {
    await productTelemetry?.flush();
    await feedbackStore?.flush();
    await fileService.close();
  });

  return app;
}
