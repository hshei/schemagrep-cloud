import { WorkOS } from "@workos-inc/node";
import type { AuthInfo } from "@modelcontextprotocol/server";
import { createRemoteJWKSet, jwtVerify, type RemoteJWKSet } from "jose";
import type { WorkOSConfig } from "../config";
import {
  CLI_CLIENT_METADATA_PATH,
  CLI_REDIRECT_URI,
  OAUTH_SCOPES,
  RESOURCE_PERMISSIONS,
} from "./constants";

const METADATA_CACHE_MS = 5 * 60 * 1000;
const SESSION_COOKIE_NAME = "sg_session";
const LOGIN_STATE_COOKIE_NAME = "sg_login_state";

export { LOGIN_STATE_COOKIE_NAME, SESSION_COOKIE_NAME };

export interface AuthenticatedIdentity {
  tenantId: string;
  authInfo: AuthInfo;
  email?: string;
  name?: string;
}

export interface BrowserAuthentication {
  identity: AuthenticatedIdentity;
  sealedSession?: string;
}

export interface BrowserCodeAuthentication {
  identity: AuthenticatedIdentity;
  sealedSession: string;
}

export interface ManagedOAuthService {
  readonly issuer: string;
  readonly resourceUrl: string;
  readonly resourceMetadataUrl: string;
  readonly publicBaseUrl: string;
  readonly secureCookies: boolean;
  authenticateBearer(token: string): Promise<AuthenticatedIdentity | undefined>;
  authenticateBrowserSession(sealedSession: string): Promise<BrowserAuthentication | undefined>;
  authorizationUrl(state: string): string;
  exchangeAuthorizationCode(code: string): Promise<BrowserCodeAuthentication>;
  logoutUrl(sealedSession: string): Promise<string>;
  protectedResourceMetadata(): Record<string, unknown>;
  authorizationServerMetadata(): Promise<Record<string, unknown>>;
  cliClientMetadata(): Record<string, unknown>;
}

function identity(
  tenantId: string,
  profile: { email?: string; name?: string } = {},
): AuthenticatedIdentity {
  return {
    tenantId,
    authInfo: {
      token: "[validated-and-redacted]",
      clientId: tenantId,
      scopes: [...RESOURCE_PERMISSIONS],
    },
    ...(profile.email === undefined ? {} : { email: profile.email }),
    ...(profile.name === undefined ? {} : { name: profile.name }),
  };
}


export class WorkOSOAuthService implements ManagedOAuthService {
  readonly issuer: string;
  readonly resourceUrl: string;
  readonly resourceMetadataUrl: string;
  readonly publicBaseUrl: string;
  readonly secureCookies: boolean;

  private readonly workos: WorkOS;
  private readonly jwks: RemoteJWKSet;
  private authorizationMetadataCache?: {
    value: Record<string, unknown>;
    expiresAt: number;
  };

  constructor(publicBaseUrl: string, private readonly config: WorkOSConfig) {
    this.publicBaseUrl = publicBaseUrl.replace(/\/+$/u, "");
    this.issuer = config.authorizationServerUrl.replace(/\/+$/u, "");
    this.resourceUrl = `${this.publicBaseUrl}/mcp`;
    this.resourceMetadataUrl = `${this.publicBaseUrl}/.well-known/oauth-protected-resource/mcp`;
    this.secureCookies = new URL(this.publicBaseUrl).protocol === "https:";
    this.workos = new WorkOS(config.apiKey, { clientId: config.clientId });
    this.jwks = createRemoteJWKSet(new URL(`${this.issuer}/oauth2/jwks`));
  }

  async authenticateBearer(token: string): Promise<AuthenticatedIdentity | undefined> {
    try {
      const { payload } = await jwtVerify(token, this.jwks, {
        issuer: this.issuer,
        audience: this.resourceUrl,
        algorithms: ["RS256"],
        requiredClaims: ["sub"],
        clockTolerance: 5,
      });
      return typeof payload.sub === "string" && payload.sub.length > 0 && payload.sub.length <= 512
        ? identity(payload.sub)
        : undefined;
    } catch {
      return undefined;
    }
  }

  async authenticateBrowserSession(
    sealedSession: string,
  ): Promise<BrowserAuthentication | undefined> {
    try {
      const session = this.workos.userManagement.loadSealedSession({
        sessionData: sealedSession,
        cookiePassword: this.config.cookiePassword,
      });
      const authenticated = await session.authenticate();
      if (authenticated.authenticated) {
        return {
          identity: identity(authenticated.user.id, {
            email: authenticated.user.email,
            ...(authenticated.user.firstName === null ? {} : { name: authenticated.user.firstName }),
          }),
        };
      }
      if (authenticated.reason === "no_session_cookie_provided") return undefined;
      const refreshed = await session.refresh({ cookiePassword: this.config.cookiePassword });
      if (!refreshed.authenticated || refreshed.sealedSession === undefined) return undefined;
      return {
        identity: identity(refreshed.user.id, {
          email: refreshed.user.email,
          ...(refreshed.user.firstName === null ? {} : { name: refreshed.user.firstName }),
        }),
        sealedSession: refreshed.sealedSession,
      };
    } catch {
      return undefined;
    }
  }

  authorizationUrl(state: string): string {
    return this.workos.userManagement.getAuthorizationUrl({
      provider: "authkit",
      clientId: this.config.clientId,
      redirectUri: `${this.publicBaseUrl}/callback`,
      state,
    });
  }

  async exchangeAuthorizationCode(code: string): Promise<BrowserCodeAuthentication> {
    const result = await this.workos.userManagement.authenticateWithCode({
      clientId: this.config.clientId,
      code,
      session: {
        sealSession: true,
        cookiePassword: this.config.cookiePassword,
      },
    });
    if (result.sealedSession === undefined) {
      throw new Error("WorkOS did not return a sealed browser session");
    }
    return {
      identity: identity(result.user.id, {
        email: result.user.email,
        ...(result.user.firstName === null ? {} : { name: result.user.firstName }),
      }),
      sealedSession: result.sealedSession,
    };
  }

  async logoutUrl(sealedSession: string): Promise<string> {
    const session = this.workos.userManagement.loadSealedSession({
      sessionData: sealedSession,
      cookiePassword: this.config.cookiePassword,
    });
    return session.getLogoutUrl({ returnTo: this.publicBaseUrl });
  }

  protectedResourceMetadata(): Record<string, unknown> {
    return {
      resource: this.resourceUrl,
      authorization_servers: [this.issuer],
      bearer_methods_supported: ["header"],
      scopes_supported: [...OAUTH_SCOPES],
    };
  }

  async authorizationServerMetadata(): Promise<Record<string, unknown>> {
    const now = Date.now();
    if (
      this.authorizationMetadataCache !== undefined &&
      this.authorizationMetadataCache.expiresAt > now
    ) {
      return { ...this.authorizationMetadataCache.value };
    }
    const response = await fetch(`${this.issuer}/.well-known/oauth-authorization-server`, {
      signal: AbortSignal.timeout(10_000),
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(`WorkOS authorization metadata request failed with ${response.status}`);
    }
    const metadataValue: unknown = await response.json();
    if (
      typeof metadataValue !== "object" ||
      metadataValue === null ||
      Array.isArray(metadataValue)
    ) {
      throw new Error("WorkOS authorization metadata is invalid");
    }
    const metadata = metadataValue as Record<string, unknown>;
    if (metadata.issuer !== this.issuer) {
      throw new Error("WorkOS authorization metadata issuer does not match configuration");
    }
    this.authorizationMetadataCache = {
      value: { ...metadata },
      expiresAt: now + METADATA_CACHE_MS,
    };
    return { ...metadata };
  }

  cliClientMetadata(): Record<string, unknown> {
    const clientId = `${this.publicBaseUrl}${CLI_CLIENT_METADATA_PATH}`;
    return {
      client_id: clientId,
      client_name: "schemagrep terminal",
      client_uri: this.publicBaseUrl,
      redirect_uris: [CLI_REDIRECT_URI],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: OAUTH_SCOPES.join(" "),
    };
  }
}
