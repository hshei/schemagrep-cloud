import type { AuthInfo } from "@modelcontextprotocol/server";
import type {
  AuthenticatedIdentity,
  BrowserAuthentication,
  BrowserCodeAuthentication,
  ManagedOAuthService,
} from "../../src/oauth/provider";
import { OAUTH_SCOPES } from "../../src/oauth/constants";

function identity(tenantId: string, profile: { email?: string; name?: string } = {}): AuthenticatedIdentity {
  const authInfo: AuthInfo = {
    token: "[test-token]",
    clientId: tenantId,
    scopes: [...OAUTH_SCOPES],
  };
  return { tenantId, authInfo, ...profile };
}

export class TestManagedOAuthService implements ManagedOAuthService {
  readonly issuer = "https://identity.example";
  readonly resourceMetadataUrl: string;
  readonly resourceUrl: string;
  readonly secureCookies = false;
  readonly publicBaseUrl: string;

  constructor(
    publicBaseUrl = "http://127.0.0.1:3199",
    private readonly bearerIdentities: Readonly<Record<string, string>> = {},
  ) {
    this.publicBaseUrl = publicBaseUrl;
    this.resourceUrl = `${publicBaseUrl}/mcp`;
    this.resourceMetadataUrl = `${publicBaseUrl}/.well-known/oauth-protected-resource/mcp`;
  }

  async authenticateBearer(token: string): Promise<AuthenticatedIdentity | undefined> {
    const tenantId = this.bearerIdentities[token];
    return tenantId === undefined ? undefined : identity(tenantId);
  }

  async authenticateBrowserSession(
    sealedSession: string,
  ): Promise<BrowserAuthentication | undefined> {
    return sealedSession === "session:browser"
      ? {
        identity: identity("browser-tenant", {
          email: "browser@example.com",
          name: "Browser User",
        }),
      }
      : undefined;
  }

  authorizationUrl(state: string): string {
    return `https://identity.example/authorize?state=${encodeURIComponent(state)}`;
  }

  async exchangeAuthorizationCode(code: string): Promise<BrowserCodeAuthentication> {
    if (code !== "valid-code") throw new Error("Invalid authorization code");
    return {
      identity: identity("browser-tenant"),
      sealedSession: "session:browser",
    };
  }

  async logoutUrl(sealedSession: string): Promise<string> {
    if (sealedSession !== "session:browser") throw new Error("Invalid session");
    return "https://identity.example/logout";
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
    return {
      issuer: this.issuer,
      authorization_endpoint: `${this.issuer}/authorize`,
      token_endpoint: `${this.issuer}/token`,
      client_id_metadata_document_supported: true,
      scopes_supported: [...OAUTH_SCOPES],
    };
  }

  cliClientMetadata(): Record<string, unknown> {
    return {
      client_id: `${this.publicBaseUrl}/oauth/client/schemagrep-cli`,
      redirect_uris: ["http://127.0.0.1:47831/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }
}
