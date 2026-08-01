import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { extname, join } from "node:path";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  statfs,
} from "node:fs/promises";
import { Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ServiceConfig } from "../config";
import { SchemagrepRunner, type SchemagrepProcessor } from "../schemagrep/runner";
import type { QueryField, StructuredQueryRequest, StructuredQueryResponse } from "../query/contract";
import {
  buildSchemagrepQueryArgs,
  formatStructuredQueryResponse,
} from "../query/execution";
import {
  EmptyUploadError,
  InvalidFilenameError,
  InvalidQueryError,
  ServiceStorageCapacityError,
  TenantFileLimitError,
  TenantStorageQuotaError,
  UnsupportedFileTypeError,
  UploadTooLargeError,
} from "./errors";
import { FILE_ID_PATTERN } from "./id";
import type {
  FileService,
  PublicFileRecord,
  StoredFileRecord,
  TenantFileUsage,
  SupportedCodec,
  UploadSource,
} from "./types";

const FILE_RECORD_VERSION = 2;
const MAX_METADATA_BYTES = 64 * 1024;
const FILES_DIRECTORY = "files";
const METADATA_FILENAME = "metadata.json";

const CODECS_BY_EXTENSION: Readonly<Record<string, SupportedCodec>> = {
  ".csv": "csv",
  ".json": "json",
  ".jsonl": "jsonl",
  ".log": "log",
  ".ndjson": "jsonl",
  ".txt": "log",
};
const MANIFEST_FORMAT = "schemagrep-manifest/v1";
const PRIMER_ID = "schemagrep-manifest/v1";
const SCHEMA_ID_PATTERN = /^sha256:[0-9a-f]{64}$/;

interface SchemaIdentity {
  primerId: string;
  schemaId: string;
  bytes: number;
}

async function inspectSchemaManifest(
  schemaPath: string,
  expectedCodec: SupportedCodec,
): Promise<SchemaIdentity> {
  const bytes = await readFile(schemaPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Schemagrep produced an invalid compact manifest");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Schemagrep produced an invalid compact manifest");
  }
  const manifest = parsed as Record<string, unknown>;
  if (
    manifest.format !== MANIFEST_FORMAT ||
    manifest.primerId !== PRIMER_ID ||
    manifest.codec !== expectedCodec ||
    !Number.isSafeInteger(manifest.records) ||
    (manifest.records as number) < 0 ||
    !Array.isArray(manifest.fields)
  ) {
    throw new Error("Schemagrep produced an unsupported compact manifest");
  }
  return {
    primerId: PRIMER_ID,
    schemaId: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    bytes: bytes.byteLength,
  };
}


interface PersistedFileRecord {
  version: typeof FILE_RECORD_VERSION;
  ownerId: string;
  retainedBytes: number;
  id: string;
  status: "ready";
  codec: SupportedCodec;
  originalName: string;
  sourceBytes: number;
  schemaBytes: number;
  primerId: string;
  schemaId: string;
  createdAt: string;
  expiresAt: string;
}

function validateQueryCoordinate(field: QueryField, codec: SupportedCodec): void {
  if (codec === "csv") {
    const match = /^\/columns\/(0|[1-9][0-9]*)$/u.exec(field.path);
    if (match === null || !Number.isSafeInteger(Number(match[1]))) {
      throw new InvalidQueryError("CSV field paths must match /columns/N using a zero-based position");
    }
  }
  if (codec === "log") {
    const match = /^\/fields\/([1-9][0-9]*)$/u.exec(field.path);
    if (match === null || !Number.isSafeInteger(Number(match[1]))) {
      throw new InvalidQueryError("Log field paths must match /fields/N using a one-based position");
    }
  }
}

function validateQueryForCodec(
  request: StructuredQueryRequest,
  codec: SupportedCodec,
): void {
  if (codec === "csv" && request.template !== undefined) {
    throw new InvalidQueryError("template is not supported for csv files");
  }
  if (request.target !== null) validateQueryCoordinate(request.target, codec);
  for (const filter of request.filters) validateQueryCoordinate(filter.field, codec);
}

function validateUploadFilename(filename: string): string {
  const containsUnsafeCharacter = /[\u0000-\u001f\u007f/\\]/u.test(filename);
  if (
    filename.length === 0 ||
    Buffer.byteLength(filename, "utf8") > 255 ||
    filename === "." ||
    filename === ".." ||
    containsUnsafeCharacter
  ) {
    throw new InvalidFilenameError();
  }
  return filename;
}

async function writeAtomic(path: string, content: string): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true });
  }
}

class UploadLimitTransform extends Transform {
  bytesWritten = 0;

  constructor(private readonly limit: number) {
    super();
  }

  override _transform(
    chunk: Buffer,
    encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    this.bytesWritten += buffer.byteLength;
    if (this.bytesWritten > this.limit) {
      callback(new UploadTooLargeError());
      return;
    }
    callback(null, buffer);
  }
}

export interface PersistentFileServiceOptions {
  storageBaseDirectory: string;
  fileTtlMs: number;
  maxUploadBytes: number;
  maxTenantStorageBytes: number;
  maxTotalStorageBytes: number;
  maxActiveFilesPerTenant: number;
  maxActiveFilesTotal: number;
  minFreeStorageBytes: number;
  runner: SchemagrepProcessor;
  now?: () => number;
}

export class PersistentFileService implements FileService {
  private readonly files = new Map<string, StoredFileRecord>();
  private readonly tenantStorageBytes = new Map<string, number>();
  private readonly tenantFileCounts = new Map<string, number>();
  private readonly pendingUploads = new Map<string, number>();
  private readonly filesDirectory: string;
  private readonly now: () => number;
  private readonly sweepTimer: NodeJS.Timeout;
  private initialization: Promise<void> | undefined;
  private totalRetainedBytes = 0;
  private totalPendingUploads = 0;

  constructor(private readonly options: PersistentFileServiceOptions) {
    this.filesDirectory = join(options.storageBaseDirectory, FILES_DIRECTORY);
    this.now = options.now ?? Date.now;
    this.sweepTimer = setInterval(
      () => void this.deleteExpired(),
      Math.min(options.fileTtlMs, 60_000),
    );
    this.sweepTimer.unref();
  }

  async ready(): Promise<void> {
    await this.ensureInitialized();
    if (
      this.totalRetainedBytes > this.options.maxTotalStorageBytes ||
      this.files.size > this.options.maxActiveFilesTotal
    ) {
      throw new ServiceStorageCapacityError();
    }
    await this.assertFreeSpace();
  }

  async ingest(source: UploadSource, ownerId: string): Promise<PublicFileRecord> {
    const safeName = validateUploadFilename(source.filename);
    const extension = extname(safeName).toLowerCase();
    const codec = CODECS_BY_EXTENSION[extension];
    if (codec === undefined) throw new UnsupportedFileTypeError(safeName);

    await this.ensureInitialized();
    await this.deleteExpired();
    this.reserveUpload(ownerId);
    const id = `file_${randomUUID().replaceAll("-", "")}`;
    const directory = join(this.filesDirectory, id);
    const sourcePath = join(directory, `source${extension}`);
    const artifactPath = join(directory, "artifact.sg");
    const schemaPath = join(directory, "schema.json");

    try {
      await mkdir(directory, { mode: 0o700 });
      await this.assertFreeSpace(this.options.maxUploadBytes);
      const limiter = new UploadLimitTransform(this.options.maxUploadBytes);
      await pipeline(
        source.stream,
        limiter,
        createWriteStream(sourcePath, { flags: "wx", mode: 0o600 }),
      );
      if (source.wasTruncated()) throw new UploadTooLargeError();
      if (limiter.bytesWritten === 0) throw new EmptyUploadError();

      const artifactBytes = await this.options.runner.encode(sourcePath, artifactPath);
      await rm(sourcePath, { force: true });
      const schemaBytes = await this.options.runner.schema(artifactPath, schemaPath);
      const schemaIdentity = await inspectSchemaManifest(schemaPath, codec);
      if (schemaIdentity.bytes !== schemaBytes) {
        throw new Error("Schemagrep schema byte count does not match its output");
      }
      const retainedBytes = artifactBytes + schemaBytes;
      await this.assertFreeSpace();

      const tenantUsage = this.tenantStorageBytes.get(ownerId) ?? 0;
      if (tenantUsage + retainedBytes > this.options.maxTenantStorageBytes) {
        throw new TenantStorageQuotaError();
      }
      if (this.totalRetainedBytes + retainedBytes > this.options.maxTotalStorageBytes) {
        throw new ServiceStorageCapacityError();
      }

      const createdAtMs = this.now();
      const record: StoredFileRecord = {
        ownerId,
        retainedBytes,
        id,
        status: "ready",
        codec,
        originalName: safeName,
        sourceBytes: limiter.bytesWritten,
        primerId: schemaIdentity.primerId,
        schemaId: schemaIdentity.schemaId,
        schemaBytes,
        createdAt: new Date(createdAtMs).toISOString(),
        expiresAt: new Date(createdAtMs + this.options.fileTtlMs).toISOString(),
        directory,
        artifactPath,
        schemaPath,
      };

      this.addRecord(record);
      try {
        await this.persistRecord(record);
      } catch (error) {
        this.detachRecord(record);
        throw error;
      }
      return this.toPublicRecord(record);
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    } finally {
      this.releaseUpload(ownerId);
    }
  }

  async list(ownerId: string): Promise<PublicFileRecord[]> {
    await this.ensureInitialized();
    await this.deleteExpired();
    return [...this.files.values()]
      .filter((record) => record.ownerId === ownerId)
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
      .map((record) => this.toPublicRecord(record));
  }

  async usage(ownerId: string): Promise<TenantFileUsage> {
    await this.ensureInitialized();
    await this.deleteExpired();
    let sourceBytes = 0;
    for (const record of this.files.values()) {
      if (record.ownerId === ownerId) sourceBytes += record.sourceBytes;
    }
    return {
      activeFiles: this.tenantFileCounts.get(ownerId) ?? 0,
      sourceBytes,
      retainedBytes: this.tenantStorageBytes.get(ownerId) ?? 0,
      maxRetainedBytes: this.options.maxTenantStorageBytes,
    };
  }

  async get(id: string, ownerId: string): Promise<PublicFileRecord | undefined> {
    await this.ensureInitialized();
    await this.expireIfNeeded(id);
    const record = this.files.get(id);
    return record === undefined || record.ownerId !== ownerId
      ? undefined
      : this.toPublicRecord(record);
  }

  readPrimer(primerId: string): Promise<string> {
    return this.options.runner.primer(primerId);
  }

  async readSchema(id: string, ownerId: string): Promise<string | undefined> {
    await this.ensureInitialized();
    await this.expireIfNeeded(id);
    const record = this.files.get(id);
    if (record === undefined || record.ownerId !== ownerId) return undefined;
    return readFile(record.schemaPath, "utf8");
  }

  async query(
    id: string,
    ownerId: string,
    request: StructuredQueryRequest,
  ): Promise<StructuredQueryResponse | undefined> {
    await this.ensureInitialized();
    await this.expireIfNeeded(id);
    const record = this.files.get(id);
    if (record === undefined || record.ownerId !== ownerId) return undefined;
    validateQueryForCodec(request, record.codec);

    const grepLimit = request.mode === "grep" ? (request.limit ?? 20) + 1 : undefined;
    const output = await this.options.runner.query(
      record.artifactPath,
      buildSchemagrepQueryArgs(request, grepLimit),
    );
    return formatStructuredQueryResponse(request, output);
  }

  async delete(id: string, ownerId: string): Promise<boolean> {
    await this.ensureInitialized();
    const record = this.files.get(id);
    if (record === undefined || record.ownerId !== ownerId) return false;
    await this.remove(record);
    return true;
  }

  async close(): Promise<void> {
    clearInterval(this.sweepTimer);
    if (this.initialization !== undefined) await this.initialization.catch(() => undefined);
    this.files.clear();
    this.tenantStorageBytes.clear();
    this.tenantFileCounts.clear();
    this.pendingUploads.clear();
    this.totalRetainedBytes = 0;
    this.totalPendingUploads = 0;
  }

  private async ensureInitialized(): Promise<void> {
    this.initialization ??= this.initializeStorage();
    await this.initialization;
  }

  private async initializeStorage(): Promise<void> {
    await mkdir(this.options.storageBaseDirectory, { recursive: true, mode: 0o700 });
    await mkdir(this.filesDirectory, { recursive: true, mode: 0o700 });
    await this.migrateLegacyInstances();
    const entries = await readdir(this.filesDirectory, { withFileTypes: true });
    const loaded = await Promise.all(entries.map(async (entry) => {
      const directory = join(this.filesDirectory, entry.name);
      if (!entry.isDirectory() || !FILE_ID_PATTERN.test(entry.name)) {
        await rm(directory, { recursive: true, force: true });
        return undefined;
      }
      try {
        const record = await this.loadRecord(directory, entry.name);
        if (Date.parse(record.expiresAt) <= this.now()) {
          await rm(directory, { recursive: true, force: true });
          return undefined;
        }
        return record;
      } catch {
        await rm(directory, { recursive: true, force: true });
        return undefined;
      }
    }));
    for (const record of loaded) {
      if (record !== undefined) this.addRecord(record);
    }
  }

  private async migrateLegacyInstances(): Promise<void> {
    const entries = await readdir(this.options.storageBaseDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("instance-")) continue;
      const instanceDirectory = join(this.options.storageBaseDirectory, entry.name);
      const children = await readdir(instanceDirectory, { withFileTypes: true });
      for (const child of children) {
        if (!child.isDirectory() || !FILE_ID_PATTERN.test(child.name)) continue;
        const source = join(instanceDirectory, child.name);
        const destination = join(this.filesDirectory, child.name);
        try {
          await rename(source, destination);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          await rm(source, { recursive: true, force: true });
        }
      }
      await rm(instanceDirectory, { recursive: true, force: true });
    }
  }

  private async loadRecord(directory: string, expectedId: string): Promise<StoredFileRecord> {
    const metadataPath = join(directory, METADATA_FILENAME);
    const metadataStats = await stat(metadataPath);
    if (!metadataStats.isFile() || metadataStats.size > MAX_METADATA_BYTES) {
      throw new Error("Invalid persisted file metadata");
    }
    const parsed: unknown = JSON.parse(await readFile(metadataPath, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("Invalid persisted file metadata");
    }
    const value = parsed as Partial<PersistedFileRecord>;
    const codec = value.codec;
    if (
      value.version !== FILE_RECORD_VERSION ||
      value.id !== expectedId ||
      !FILE_ID_PATTERN.test(value.id) ||
      value.status !== "ready" ||
      !["csv", "json", "jsonl", "log"].includes(codec ?? "") ||
      typeof value.ownerId !== "string" ||
      value.ownerId.length === 0 ||
      value.ownerId.length > 512 ||
      typeof value.originalName !== "string" ||
      typeof value.sourceBytes !== "number" ||
      !Number.isSafeInteger(value.sourceBytes) ||
      value.sourceBytes < 0 ||
      typeof value.schemaBytes !== "number" ||
      !Number.isSafeInteger(value.schemaBytes) ||
      value.schemaBytes < 0 ||
      value.primerId !== PRIMER_ID ||
      typeof value.schemaId !== "string" ||
      !SCHEMA_ID_PATTERN.test(value.schemaId) ||
      typeof value.retainedBytes !== "number" ||
      !Number.isSafeInteger(value.retainedBytes) ||
      value.retainedBytes <= 0 ||
      typeof value.createdAt !== "string" ||
      !Number.isFinite(Date.parse(value.createdAt)) ||
      typeof value.expiresAt !== "string" ||
      !Number.isFinite(Date.parse(value.expiresAt))
    ) {
      throw new Error("Invalid persisted file metadata");
    }
    validateUploadFilename(value.originalName);
    const expectedCodec = CODECS_BY_EXTENSION[extname(value.originalName).toLowerCase()];
    if (expectedCodec !== codec) throw new Error("Persisted codec does not match filename");

    const artifactPath = join(directory, "artifact.sg");
    const schemaPath = join(directory, "schema.json");
    const [artifactStats, schemaStats] = await Promise.all([stat(artifactPath), stat(schemaPath)]);
    if (
      !artifactStats.isFile() ||
      !schemaStats.isFile() ||
      schemaStats.size !== value.schemaBytes ||
      artifactStats.size + schemaStats.size !== value.retainedBytes
    ) {
      throw new Error("Persisted artifact size does not match metadata");
    }
    const schemaIdentity = await inspectSchemaManifest(schemaPath, codec as SupportedCodec);
    if (
      schemaIdentity.primerId !== value.primerId ||
      schemaIdentity.schemaId !== value.schemaId ||
      schemaIdentity.bytes !== value.schemaBytes
    ) {
      throw new Error("Persisted schema identity does not match metadata");
    }
    return {
      ownerId: value.ownerId,
      retainedBytes: value.retainedBytes,
      id: value.id,
      status: "ready",
      codec: codec as SupportedCodec,
      originalName: value.originalName,
      sourceBytes: value.sourceBytes,
      primerId: value.primerId,
      schemaId: value.schemaId,
      schemaBytes: value.schemaBytes,
      createdAt: value.createdAt,
      expiresAt: value.expiresAt,
      directory,
      artifactPath,
      schemaPath,
    };
  }

  private async persistRecord(record: StoredFileRecord): Promise<void> {
    const metadata: PersistedFileRecord = {
      version: FILE_RECORD_VERSION,
      ownerId: record.ownerId,
      retainedBytes: record.retainedBytes,
      id: record.id,
      status: record.status,
      codec: record.codec,
      originalName: record.originalName,
      sourceBytes: record.sourceBytes,
      schemaBytes: record.schemaBytes,
      primerId: record.primerId,
      schemaId: record.schemaId,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
    };
    await writeAtomic(
      join(record.directory, METADATA_FILENAME),
      `${JSON.stringify(metadata)}\n`,
    );
  }

  private reserveUpload(ownerId: string): void {
    const tenantActive = (this.tenantFileCounts.get(ownerId) ?? 0) +
      (this.pendingUploads.get(ownerId) ?? 0);
    if (tenantActive >= this.options.maxActiveFilesPerTenant) throw new TenantFileLimitError();
    if (this.files.size + this.totalPendingUploads >= this.options.maxActiveFilesTotal) {
      throw new ServiceStorageCapacityError();
    }
    this.pendingUploads.set(ownerId, (this.pendingUploads.get(ownerId) ?? 0) + 1);
    this.totalPendingUploads += 1;
  }

  private releaseUpload(ownerId: string): void {
    const pending = this.pendingUploads.get(ownerId) ?? 0;
    if (pending <= 1) this.pendingUploads.delete(ownerId);
    else this.pendingUploads.set(ownerId, pending - 1);
    this.totalPendingUploads = Math.max(0, this.totalPendingUploads - 1);
  }

  private addRecord(record: StoredFileRecord): void {
    this.files.set(record.id, record);
    this.tenantStorageBytes.set(
      record.ownerId,
      (this.tenantStorageBytes.get(record.ownerId) ?? 0) + record.retainedBytes,
    );
    this.tenantFileCounts.set(
      record.ownerId,
      (this.tenantFileCounts.get(record.ownerId) ?? 0) + 1,
    );
    this.totalRetainedBytes += record.retainedBytes;
  }

  private detachRecord(record: StoredFileRecord): void {
    if (this.files.get(record.id) !== record) return;
    this.files.delete(record.id);
    const tenantBytes = (this.tenantStorageBytes.get(record.ownerId) ?? 0) - record.retainedBytes;
    if (tenantBytes > 0) this.tenantStorageBytes.set(record.ownerId, tenantBytes);
    else this.tenantStorageBytes.delete(record.ownerId);
    const tenantFiles = (this.tenantFileCounts.get(record.ownerId) ?? 0) - 1;
    if (tenantFiles > 0) this.tenantFileCounts.set(record.ownerId, tenantFiles);
    else this.tenantFileCounts.delete(record.ownerId);
    this.totalRetainedBytes = Math.max(0, this.totalRetainedBytes - record.retainedBytes);
  }

  private async assertFreeSpace(additionalBytes = 0): Promise<void> {
    const storage = await statfs(this.filesDirectory);
    const availableBytes = storage.bavail * storage.bsize;
    if (availableBytes - additionalBytes < this.options.minFreeStorageBytes) {
      throw new ServiceStorageCapacityError();
    }
  }

  private async expireIfNeeded(id: string): Promise<void> {
    const record = this.files.get(id);
    if (record !== undefined && Date.parse(record.expiresAt) <= this.now()) await this.remove(record);
  }

  private async deleteExpired(): Promise<void> {
    await this.ensureInitialized();
    const now = this.now();
    const expired = [...this.files.values()].filter((record) => Date.parse(record.expiresAt) <= now);
    await Promise.all(expired.map((record) => this.remove(record)));
  }

  private async remove(record: StoredFileRecord): Promise<void> {
    if (this.files.get(record.id) !== record) return;
    await rm(record.directory, { recursive: true, force: true });
    this.detachRecord(record);
  }

  private toPublicRecord(record: StoredFileRecord): PublicFileRecord {
    return {
      id: record.id,
      status: record.status,
      codec: record.codec,
      originalName: record.originalName,
      sourceBytes: record.sourceBytes,
      primerId: record.primerId,
      schemaId: record.schemaId,
      schemaBytes: record.schemaBytes,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
    };
  }
}

export function createFileService(config: ServiceConfig): PersistentFileService {
  const runner = new SchemagrepRunner({
    binaryPath: config.schemagrepBinary,
    timeoutMs: config.processTimeoutMs,
    maxArtifactBytes: config.maxArtifactBytes,
    maxSchemaBytes: config.maxSchemaBytes,
    maxQueryOutputBytes: config.maxQueryOutputBytes,
    maxActiveWorkers: config.maxActiveWorkers,
    maxQueuedWorkers: config.maxQueuedWorkers,
    sandbox:
      config.workerSandbox === "bwrap"
        ? { mode: "bwrap", bubblewrapBinary: config.bubblewrapBinary }
        : { mode: "disabled" },
  });

  return new PersistentFileService({
    storageBaseDirectory: config.storageBaseDirectory,
    fileTtlMs: config.fileTtlMs,
    maxUploadBytes: config.maxUploadBytes,
    maxTenantStorageBytes: config.maxTenantStorageBytes,
    maxTotalStorageBytes: config.maxTotalStorageBytes,
    maxActiveFilesPerTenant: config.maxActiveFilesPerTenant,
    maxActiveFilesTotal: config.maxActiveFilesTotal,
    minFreeStorageBytes: config.minFreeStorageBytes,
    runner,
  });
}
