export const OAUTH_SCOPES = ["openid", "offline_access"] as const;
export const RESOURCE_PERMISSIONS = ["files:read", "files:write", "files:delete"] as const;
export const CLI_CLIENT_METADATA_PATH = "/oauth/client/schemagrep-cli";
export const CLI_REDIRECT_URI = "http://127.0.0.1:47831/callback";
