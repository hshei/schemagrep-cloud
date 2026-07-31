import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const MEBIBYTE = 1024 * 1024;

export interface WorkOSConfig {
  apiKey: string;
  clientId: string;
  authorizationServerUrl: string;
  cookiePassword: string;
  csrfSecret: string;
}

export type WorkerSandboxMode = "bwrap" | "disabled";

export interface ServiceConfig {
  host: string;
  port: number;
  schemagrepBinary: string;
  storageBaseDirectory: string;
  fileTtlMs: number;
  processTimeoutMs: number;
  maxUploadBytes: number;
  maxArtifactBytes: number;
  maxSchemaBytes: number;
  maxQueryOutputBytes: number;
  authDisabled: boolean;
  workos?: WorkOSConfig;
  rateLimitMax: number;
  rateLimitWindowMs: number;
  maxTenantStorageBytes: number;
  maxTotalStorageBytes: number;
  maxActiveFilesPerTenant: number;
  maxActiveFilesTotal: number;
  minFreeStorageBytes: number;
  maxActiveWorkers: number;
  maxQueuedWorkers: number;
  workerSandbox: WorkerSandboxMode;
  bubblewrapBinary: string;
  mcpAllowedHostnames: readonly string[];
  trustedProxyClientIpHeader?: string;
  publicBaseUrl?: string;
  productTelemetryPath?: string;
  productTelemetryHashKey?: string;
  feedbackPath?: string;
  feedbackRetentionMs?: number;
}

function parseInteger(
  name: string,
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}; received ${value}`);
  }

  return parsed;
}

function parseBoolean(name: string, value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false; received ${value}`);
}

function parseSandboxMode(value: string | undefined): WorkerSandboxMode {
  if (value === undefined || value === "bwrap") return "bwrap";
  if (value === "disabled") return "disabled";
  throw new Error(`WORKER_SANDBOX must be bwrap or disabled; received ${value}`);
}

function parseMcpAllowedHostnames(value: string | undefined, serviceHost: string): string[] {
  const candidates =
    value === undefined
      ? [serviceHost, "localhost", "127.0.0.1", "[::1]"]
      : value.split(",").map((hostname) => hostname.trim());
  const hostnames = [...new Set(candidates.map((hostname) => hostname.toLowerCase()))];
  const validHostname = /^(?:\[[0-9a-f:]+\]|[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?)$/u;
  if (
    hostnames.length === 0 ||
    hostnames.length > 20 ||
    hostnames.some(
      (hostname) =>
        hostname.length === 0 ||
        hostname.length > 253 ||
        !validHostname.test(hostname) ||
        hostname.includes(".."),
    )
  ) {
    throw new Error("MCP_ALLOWED_HOSTS must contain 1 to 20 comma-separated hostnames");
  }
  return hostnames;
}

function parseTrustedProxyClientIpHeader(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const header = value.trim().toLowerCase();
  if (header.length === 0 || header.length > 128 || !/^[!#$%&'*+\-.^_`|~0-9a-z]+$/u.test(header)) {
    throw new Error("TRUSTED_PROXY_CLIENT_IP_HEADER must be one valid HTTP header name");
  }
  return header;
}

function parseOrigin(
  name: string,
  value: string,
  allowLoopbackHttp: boolean,
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute URL`);
  }
  const loopbackHttp = allowLoopbackHttp &&
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !loopbackHttp) ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error(`${name} must be HTTPS${allowLoopbackHttp ? ", except for loopback development" : ""}`);
  }
  if (url.pathname !== "/") throw new Error(`${name} must not contain a path`);
  return url.href.replace(/\/$/u, "");
}

function requiredSecret(
  name: string,
  value: string | undefined,
  minimumBytes = 1,
): string {
  if (
    value === undefined ||
    Buffer.byteLength(value, "utf8") < minimumBytes ||
    Buffer.byteLength(value, "utf8") > 512
  ) {
    throw new Error(`${name} must contain ${minimumBytes} to 512 UTF-8 bytes`);
  }
  return value;
}

function parseWorkOSConfig(
  env: NodeJS.ProcessEnv,
  authDisabled: boolean,
): { publicBaseUrl?: string; workos?: WorkOSConfig } {
  const names = [
    "PUBLIC_BASE_URL",
    "WORKOS_API_KEY",
    "WORKOS_CLIENT_ID",
    "WORKOS_AUTHKIT_URL",
    "WORKOS_COOKIE_PASSWORD",
    "CSRF_SECRET",
  ] as const;
  const configured = names.some((name) => env[name] !== undefined);
  if (!configured && authDisabled) return {};
  if (!configured) {
    throw new Error(
      "Managed authentication is required unless AUTH_DISABLED=true; configure " +
      names.join(", "),
    );
  }
  for (const name of names) {
    if (env[name] === undefined) throw new Error(`${name} is required for managed authentication`);
  }
  return {
    publicBaseUrl: parseOrigin("PUBLIC_BASE_URL", env.PUBLIC_BASE_URL!, true),
    workos: {
      apiKey: requiredSecret("WORKOS_API_KEY", env.WORKOS_API_KEY),
      clientId: requiredSecret("WORKOS_CLIENT_ID", env.WORKOS_CLIENT_ID),
      authorizationServerUrl: parseOrigin("WORKOS_AUTHKIT_URL", env.WORKOS_AUTHKIT_URL!, false),
      cookiePassword: requiredSecret("WORKOS_COOKIE_PASSWORD", env.WORKOS_COOKIE_PASSWORD, 32),
      csrfSecret: requiredSecret("CSRF_SECRET", env.CSRF_SECRET, 32),
    },
  };
}

function parseProductTelemetry(env: NodeJS.ProcessEnv): {
  productTelemetryPath?: string;
  productTelemetryHashKey?: string;
} {
  const path = env.PRODUCT_TELEMETRY_PATH;
  const hashKey = env.PRODUCT_TELEMETRY_HASH_KEY;
  if (path === undefined && hashKey === undefined) return {};
  if (path === undefined || path.length === 0 || path.length > 4096) {
    throw new Error("PRODUCT_TELEMETRY_PATH is required and must contain 1 to 4096 characters");
  }
  if (
    hashKey === undefined ||
    Buffer.byteLength(hashKey, "utf8") < 32 ||
    Buffer.byteLength(hashKey, "utf8") > 512
  ) {
    throw new Error("PRODUCT_TELEMETRY_HASH_KEY is required and must contain 32 to 512 UTF-8 bytes");
  }
  return { productTelemetryPath: path, productTelemetryHashKey: hashKey };
}

function parseFeedbackConfig(env: NodeJS.ProcessEnv): {
  feedbackPath?: string;
  feedbackRetentionMs?: number;
} {
  const path = env.FEEDBACK_PATH;
  if (path === undefined) {
    if (env.FEEDBACK_RETENTION_DAYS !== undefined) {
      throw new Error("FEEDBACK_PATH is required when FEEDBACK_RETENTION_DAYS is configured");
    }
    return {};
  }
  if (path.length === 0 || path.length > 4096) {
    throw new Error("FEEDBACK_PATH must contain 1 to 4096 characters");
  }
  return {
    feedbackPath: path,
    feedbackRetentionMs:
      parseInteger("FEEDBACK_RETENTION_DAYS", env.FEEDBACK_RETENTION_DAYS, 30, 1, 365)
      * 24 * 60 * 60 * 1000,
  };
}


export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  const authDisabled = parseBoolean("AUTH_DISABLED", env.AUTH_DISABLED, false);
  const managedAuthConfig = parseWorkOSConfig(env, authDisabled);
  const host = env.HOST ?? "127.0.0.1";
  if (
    authDisabled &&
    host !== "127.0.0.1" &&
    host !== "::1" &&
    host.toLowerCase() !== "localhost"
  ) {
    throw new Error("AUTH_DISABLED=true requires HOST to be loopback-only");
  }
  const productTelemetry = parseProductTelemetry(env);
  const feedbackConfig = parseFeedbackConfig(env);
  const workosConfig = managedAuthConfig;
  const trustedProxyClientIpHeader = parseTrustedProxyClientIpHeader(
    env.TRUSTED_PROXY_CLIENT_IP_HEADER,
  );
  const maxUploadBytes = parseInteger(
    "MAX_UPLOAD_BYTES",
    env.MAX_UPLOAD_BYTES,
    25 * MEBIBYTE,
    1,
    1024 * MEBIBYTE,
  );
  const maxTenantStorageBytes = parseInteger(
    "MAX_TENANT_STORAGE_BYTES",
    env.MAX_TENANT_STORAGE_BYTES,
    512 * MEBIBYTE,
    1,
    100 * 1024 * MEBIBYTE,
  );
  const maxTotalStorageBytes = parseInteger(
    "MAX_TOTAL_STORAGE_BYTES",
    env.MAX_TOTAL_STORAGE_BYTES,
    Math.max(16 * 1024 * MEBIBYTE, maxTenantStorageBytes),
    1,
    1024 * 1024 * MEBIBYTE,
  );
  if (maxTotalStorageBytes < maxTenantStorageBytes) {
    throw new Error("MAX_TOTAL_STORAGE_BYTES must be at least MAX_TENANT_STORAGE_BYTES");
  }

  return {
    host,
    port: parseInteger("PORT", env.PORT, 3000, 1, 65_535),
    schemagrepBinary:
      env.SCHEMAGREP_BIN ??
      fileURLToPath(new URL("../vendor/schemagrep/schemagrep", import.meta.url)),
    storageBaseDirectory: env.STORAGE_DIR ?? join(tmpdir(), "schemagrep-cloud"),
    fileTtlMs: parseInteger("FILE_TTL_SECONDS", env.FILE_TTL_SECONDS, 3600, 1, 86_400) * 1000,
    processTimeoutMs: parseInteger(
      "PROCESS_TIMEOUT_MS",
      env.PROCESS_TIMEOUT_MS,
      30_000,
      100,
      300_000,
    ),
    maxUploadBytes,
    maxArtifactBytes: parseInteger(
      "MAX_ARTIFACT_BYTES",
      env.MAX_ARTIFACT_BYTES,
      Math.min(maxUploadBytes * 4, 2 * 1024 * MEBIBYTE),
      1,
      2 * 1024 * MEBIBYTE,
    ),
    maxSchemaBytes: parseInteger(
      "MAX_SCHEMA_BYTES",
      env.MAX_SCHEMA_BYTES,
      4 * MEBIBYTE,
      1,
      64 * MEBIBYTE,
    ),
    maxQueryOutputBytes: parseInteger(
      "MAX_QUERY_OUTPUT_BYTES",
      env.MAX_QUERY_OUTPUT_BYTES,
      1 * MEBIBYTE,
      1024,
      64 * MEBIBYTE,
    ),
    authDisabled,
    ...workosConfig,
    rateLimitMax: parseInteger("RATE_LIMIT_MAX", env.RATE_LIMIT_MAX, 60, 1, 10_000),
    rateLimitWindowMs: parseInteger(
      "RATE_LIMIT_WINDOW_MS",
      env.RATE_LIMIT_WINDOW_MS,
      60_000,
      1000,
      3_600_000,
    ),
    maxTenantStorageBytes,
    maxTotalStorageBytes,
    maxActiveFilesPerTenant: parseInteger(
      "MAX_ACTIVE_FILES_PER_TENANT",
      env.MAX_ACTIVE_FILES_PER_TENANT,
      20,
      1,
      10_000,
    ),
    maxActiveFilesTotal: parseInteger(
      "MAX_ACTIVE_FILES_TOTAL",
      env.MAX_ACTIVE_FILES_TOTAL,
      1000,
      1,
      100_000,
    ),
    minFreeStorageBytes: parseInteger(
      "MIN_FREE_STORAGE_BYTES",
      env.MIN_FREE_STORAGE_BYTES,
      1024 * MEBIBYTE,
      0,
      100 * 1024 * MEBIBYTE,
    ),
    maxActiveWorkers: parseInteger(
      "MAX_ACTIVE_WORKERS",
      env.MAX_ACTIVE_WORKERS,
      4,
      1,
      128,
    ),
    maxQueuedWorkers: parseInteger(
      "MAX_QUEUED_WORKERS",
      env.MAX_QUEUED_WORKERS,
      16,
      0,
      10_000,
    ),
    workerSandbox: parseSandboxMode(env.WORKER_SANDBOX),
    bubblewrapBinary: env.BWRAP_BIN ?? "/usr/bin/bwrap",
    mcpAllowedHostnames: parseMcpAllowedHostnames(env.MCP_ALLOWED_HOSTS, host),
    ...(trustedProxyClientIpHeader === undefined ? {} : { trustedProxyClientIpHeader }),
    ...productTelemetry,
    ...feedbackConfig,
  };
}
