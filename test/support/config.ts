import type { ServiceConfig } from "../../src/config";

const BASE_CONFIG: ServiceConfig = {
  host: "127.0.0.1",
  port: 3000,
  schemagrepBinary: "schemagrep",
  storageBaseDirectory: "/tmp/schemagrep-cloud-tests",
  fileTtlMs: 3_600_000,
  processTimeoutMs: 30_000,
  maxUploadBytes: 1024,
  maxArtifactBytes: 4096,
  maxSchemaBytes: 4096,
  maxQueryOutputBytes: 4096,
  authDisabled: false,
  rateLimitMax: 100,
  rateLimitWindowMs: 60_000,
  maxTenantStorageBytes: 4096,
  maxTotalStorageBytes: 65_536,
  maxActiveFilesPerTenant: 20,
  maxActiveFilesTotal: 100,
  minFreeStorageBytes: 0,
  maxActiveWorkers: 4,
  maxQueuedWorkers: 16,
  workerSandbox: "disabled",
  mcpAllowedHostnames: ["localhost", "127.0.0.1"],
  bubblewrapBinary: "/usr/bin/bwrap",
};

export function testConfig(overrides: Partial<ServiceConfig> = {}): ServiceConfig {
  return { ...BASE_CONFIG, ...overrides };
}
