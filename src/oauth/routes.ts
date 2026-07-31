import { randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { CLI_CLIENT_METADATA_PATH } from "./constants";
import {
  LOGIN_STATE_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  type ManagedOAuthService,
} from "./provider";

const LOGIN_STATE_TTL_SECONDS = 10 * 60;
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

interface OAuthRouteOptions {
  oauth: ManagedOAuthService;
}

interface CallbackQuery {
  code?: string;
  error?: string;
  state?: string;
}

function clearCookie(reply: FastifyReply, name: string, secure: boolean): void {
  reply.clearCookie(name, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure,
  });
}

function validState(actual: string | undefined, expected: string | undefined): boolean {
  if (actual === undefined || expected === undefined) return false;
  const actualBuffer = Buffer.from(actual, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  return actualBuffer.byteLength === expectedBuffer.byteLength &&
    timingSafeEqual(actualBuffer, expectedBuffer);
}

function authenticationError(reply: FastifyReply): FastifyReply {
  return reply
    .code(400)
    .headers({
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    })
    .type("text/html; charset=utf-8")
    .send("<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><title>Sign-in failed · schemagrep</title><body><h1>Sign-in could not be completed</h1><p>Return to schemagrep and try again.</p></body></html>");
}

export async function registerOAuthRoutes(
  app: FastifyInstance,
  options: OAuthRouteOptions,
): Promise<void> {
  const resourceMetadata = options.oauth.protectedResourceMetadata();
  for (const path of [
    "/.well-known/oauth-protected-resource/mcp",
    "/.well-known/oauth-protected-resource",
  ]) {
    app.get(path, async (_request, reply) => reply
      .header("access-control-allow-origin", "*")
      .header("cache-control", "public, max-age=300")
      .send(resourceMetadata));
  }

  app.get("/.well-known/oauth-authorization-server", async (_request, reply) => {
    try {
      return reply
        .header("access-control-allow-origin", "*")
        .header("cache-control", "public, max-age=300")
        .send(await options.oauth.authorizationServerMetadata());
    } catch (error) {
      app.log.error({ err: error }, "Authorization metadata proxy failed");
      return reply.code(502).send({
        error: { code: "authorization_server_unavailable", message: "Authorization metadata is unavailable" },
      });
    }
  });

  app.get(CLI_CLIENT_METADATA_PATH, async (_request, reply) => reply
    .header("access-control-allow-origin", "*")
    .header("cache-control", "public, max-age=300")
    .send(options.oauth.cliClientMetadata()));

  app.get("/csrf-token", async (_request, reply) => reply
    .header("cache-control", "no-store")
    .send({ csrfToken: await reply.generateCsrf() }));

  app.get("/login", async (_request, reply) => {
    const state = randomBytes(32).toString("base64url");
    reply.setCookie(LOGIN_STATE_COOKIE_NAME, state, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: options.oauth.secureCookies,
      maxAge: LOGIN_STATE_TTL_SECONDS,
    });
    return reply.header("cache-control", "no-store").redirect(options.oauth.authorizationUrl(state));
  });

  app.get<{ Querystring: CallbackQuery }>("/callback", async (request, reply) => {
    const expectedState = request.cookies[LOGIN_STATE_COOKIE_NAME];
    clearCookie(reply, LOGIN_STATE_COOKIE_NAME, options.oauth.secureCookies);
    if (
      request.query.error !== undefined ||
      request.query.code === undefined ||
      !validState(request.query.state, expectedState)
    ) {
      return authenticationError(reply);
    }
    try {
      const authenticated = await options.oauth.exchangeAuthorizationCode(request.query.code);
      reply.setCookie(SESSION_COOKIE_NAME, authenticated.sealedSession, {
        path: "/",
        httpOnly: true,
        sameSite: "lax",
        secure: options.oauth.secureCookies,
        maxAge: SESSION_TTL_SECONDS,
      });
      return reply.header("cache-control", "no-store").redirect("/");
    } catch (error) {
      app.log.warn({ err: error }, "WorkOS authorization code exchange failed");
      return authenticationError(reply);
    }
  });

  app.post("/logout", async (request, reply) => {
    const sealedSession = request.cookies[SESSION_COOKIE_NAME];
    clearCookie(reply, SESSION_COOKIE_NAME, options.oauth.secureCookies);
    let redirect = "/";
    if (sealedSession !== undefined) {
      try {
        redirect = await options.oauth.logoutUrl(sealedSession);
      } catch (error) {
        app.log.warn({ err: error }, "WorkOS logout URL generation failed");
      }
    }
    if (request.headers.accept?.includes("application/json")) {
      return reply.header("cache-control", "no-store").send({ redirect });
    }
    return reply.redirect(redirect);
  });
}
