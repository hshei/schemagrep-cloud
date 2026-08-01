import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  EmptyUploadError,
  InvalidFilenameError,
  ServiceStorageCapacityError,
  TenantFileLimitError,
  TenantStorageQuotaError,
  UnsupportedFileTypeError,
} from "../src/files/errors";
import { PersistentFileService } from "../src/files/service";
import type { SchemagrepProcessor } from "../src/schemagrep/runner";
import type { StructuredQueryRequest } from "../src/query/contract";
const COMPACT_SCHEMA = `${JSON.stringify({
  format: "schemagrep-manifest/v1",
  primerId: "schemagrep-manifest/v1",
  codec: "jsonl",
  records: 1,
  topLevel: ["/id"],
  fields: [],
})}\n`;
const SCHEMA_BYTES = Buffer.byteLength(COMPACT_SCHEMA);
const RETAINED_BYTES = Buffer.byteLength('encoded:{"id":1}\n') + SCHEMA_BYTES;


class FakeProcessor implements SchemagrepProcessor {
  constructor(private readonly compactSchema: string = COMPACT_SCHEMA) {}
  encodeCalls = 0;
  schemaCalls = 0;
  lastQueryArgs: readonly string[] | undefined;
  schemaInput: string | undefined;
  async encode(sourcePath: string, outputPath: string): Promise<number> {
    this.encodeCalls += 1;
    const source = await readFile(sourcePath);
    const artifact = Buffer.concat([Buffer.from("encoded:"), source]);
    await writeFile(outputPath, artifact, { flag: "wx", mode: 0o600 });
    return artifact.byteLength;
  }

  async schema(artifactPath: string, outputPath: string): Promise<number> {
    this.schemaCalls += 1;
    this.schemaInput = await readFile(artifactPath, "utf8");
    await writeFile(outputPath, this.compactSchema, { flag: "wx", mode: 0o600 });
    return Buffer.byteLength(this.compactSchema);
  }
  async primer(primerId: string): Promise<string> {
    return `primer:${primerId}`;
  }


  async query(_artifactPath: string, args: readonly string[]): Promise<string> {
    this.lastQueryArgs = args;
    return "5\n";
  }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const OWNER_ID = "tenant-a";
const CAPACITY = {
  maxTotalStorageBytes: 65_536,
  maxActiveFilesPerTenant: 20,
  maxActiveFilesTotal: 100,
  minFreeStorageBytes: 0,
};

describe("PersistentFileService", () => {
  test("retains only query artifacts and metadata, then expires them", async () => {
    const storageBaseDirectory = await mkdtemp(join(tmpdir(), "schemagrep-service-test-"));
    temporaryDirectories.push(storageBaseDirectory);
    const abandonedDirectory = join(storageBaseDirectory, "instance-abandoned");
    await mkdir(abandonedDirectory);
    await writeFile(join(abandonedDirectory, "raw-upload.jsonl"), "must be deleted");
    let now = Date.parse("2026-07-29T00:00:00.000Z");
    const runner = new FakeProcessor();
    const service = new PersistentFileService({
      storageBaseDirectory,
      fileTtlMs: 1000,
      maxUploadBytes: 1024,
      maxTenantStorageBytes: 4096,
      ...CAPACITY,
      runner,
      now: () => now,
    });

    const record = await service.ingest(
      {
        filename: "events.jsonl",
        stream: Readable.from(['{"id":1}\n']),
        wasTruncated: () => false,
      },
      OWNER_ID,
    );

    expect(record.originalName).toBe("events.jsonl");
    expect(record.sourceBytes).toBe(9);
    expect(record.schemaBytes).toBe(SCHEMA_BYTES);
    expect(record.primerId).toBe("schemagrep-manifest/v1");
    expect(record.schemaId).toBe(`sha256:${createHash("sha256").update(COMPACT_SCHEMA).digest("hex")}`);
    expect(await service.readSchema(record.id, OWNER_ID)).toBe(COMPACT_SCHEMA);
    expect(runner.schemaInput).toBe('encoded:{"id":1}\n');
    const query: StructuredQueryRequest = {
      mode: "count",
      target: { path: "/id" },
      filters: [],
      value: "1",
    };
    expect(await service.query(record.id, OWNER_ID, query)).toEqual({
      query,
      answer: "5",
      outputBytes: 1,
    });
    expect(runner.lastQueryArgs).toEqual(["--count", "1", "--path", "/id"]);
    expect(await service.query(record.id, "tenant-b", query)).toBeUndefined();
    expect(await service.get(record.id, "tenant-b")).toBeUndefined();
    expect(await service.readSchema(record.id, "tenant-b")).toBeUndefined();
    expect(await service.delete(record.id, "tenant-b")).toBe(false);
    expect(await service.get(record.id, OWNER_ID)).toEqual(record);

    const filesDirectory = join(storageBaseDirectory, "files");
    expect(await readdir(storageBaseDirectory)).toEqual(["files"]);
    expect(await readdir(filesDirectory)).toEqual([record.id]);
    const retainedArtifacts = (await readdir(join(filesDirectory, record.id))).sort();
    expect(retainedArtifacts).toEqual(["artifact.sg", "metadata.json", "schema.json"]);

    now += 1001;
    expect(await service.get(record.id, OWNER_ID)).toBeUndefined();
    expect(await readdir(filesDirectory)).toEqual([]);
    await service.close();
  });

  test("accepts canonical field paths for CSV and log artifacts", async () => {
    const cases = [
      {
        codec: "csv",
        filename: "events.csv",
        source: "status\n200\n",
        path: "/columns/0",
        invalidPath: "/fields/1",
      },
      {
        codec: "log",
        filename: "events.log",
        source: "status=200\n",
        path: "/fields/1",
        invalidPath: "/columns/0",
      },
    ] as const;

    for (const item of cases) {
      const storageBaseDirectory = await mkdtemp(
        join(tmpdir(), `schemagrep-${item.codec}-query-test-`),
      );
      temporaryDirectories.push(storageBaseDirectory);
      const compactSchema = `${JSON.stringify({
        format: "schemagrep-manifest/v1",
        primerId: "schemagrep-manifest/v1",
        codec: item.codec,
        records: 1,
        fields: [{ coordinate: { path: item.path } }],
      })}\n`;
      const runner = new FakeProcessor(compactSchema);
      const service = new PersistentFileService({
        storageBaseDirectory,
        fileTtlMs: 60_000,
        maxUploadBytes: 1024,
        maxTenantStorageBytes: 4096,
        ...CAPACITY,
        runner,
      });
      const record = await service.ingest(
        {
          filename: item.filename,
          stream: Readable.from([item.source]),
          wasTruncated: () => false,
        },
        OWNER_ID,
      );
      const query: StructuredQueryRequest = {
        mode: "count",
        target: { path: item.path },
        filters: [],
        value: "200",
      };
      await expect(service.query(record.id, OWNER_ID, query)).resolves.toMatchObject({
        answer: "5",
      });
      expect(runner.lastQueryArgs).toEqual([
        "--count",
        "200",
        "--path",
        item.path,
      ]);
      await expect(service.query(record.id, OWNER_ID, {
        ...query,
        target: { path: item.invalidPath },
      })).rejects.toThrow(item.codec === "csv" ? "/columns/N" : "/fields/N");
      await service.close();
    }
  });

  test("reloads active file metadata and artifacts after restart", async () => {
    const storageBaseDirectory = await mkdtemp(join(tmpdir(), "schemagrep-service-test-"));
    temporaryDirectories.push(storageBaseDirectory);
    const now = Date.parse("2026-07-29T00:00:00.000Z");
    const first = new PersistentFileService({
      storageBaseDirectory,
      fileTtlMs: 60_000,
      maxUploadBytes: 1024,
      maxTenantStorageBytes: 4096,
      ...CAPACITY,
      runner: new FakeProcessor(),
      now: () => now,
    });
    const record = await first.ingest(
      {
        filename: "events.jsonl",
        stream: Readable.from(['{"id":1}\n']),
        wasTruncated: () => false,
      },
      OWNER_ID,
    );
    await first.close();

    const runner = new FakeProcessor();
    const restarted = new PersistentFileService({
      storageBaseDirectory,
      fileTtlMs: 60_000,
      maxUploadBytes: 1024,
      maxTenantStorageBytes: 4096,
      ...CAPACITY,
      runner,
      now: () => now,
    });
    const query: StructuredQueryRequest = { mode: "rows", target: null, filters: [] };
    expect(await restarted.list(OWNER_ID)).toEqual([record]);
    expect(await restarted.readSchema(record.id, OWNER_ID)).toBe(COMPACT_SCHEMA);
    expect(await restarted.query(record.id, OWNER_ID, query)).toMatchObject({ answer: "5" });
    expect(await restarted.usage(OWNER_ID)).toMatchObject({
      activeFiles: 1,
      sourceBytes: 9,
      retainedBytes: RETAINED_BYTES,
    });
    expect(runner.encodeCalls).toBe(0);
    expect(runner.schemaCalls).toBe(0);
    await restarted.close();
  });

  test("rejects a persisted compact manifest whose content hash changed", async () => {
    const storageBaseDirectory = await mkdtemp(join(tmpdir(), "schemagrep-service-test-"));
    temporaryDirectories.push(storageBaseDirectory);
    const now = Date.parse("2026-07-29T00:00:00.000Z");
    const first = new PersistentFileService({
      storageBaseDirectory,
      fileTtlMs: 60_000,
      maxUploadBytes: 1024,
      maxTenantStorageBytes: 4096,
      ...CAPACITY,
      runner: new FakeProcessor(),
      now: () => now,
    });
    const record = await first.ingest(
      {
        filename: "events.jsonl",
        stream: Readable.from(['{"id":1}\n']),
        wasTruncated: () => false,
      },
      OWNER_ID,
    );
    await first.close();
    await writeFile(
      join(storageBaseDirectory, "files", record.id, "schema.json"),
      COMPACT_SCHEMA.replace('"records":1', '"records":2'),
    );

    const restarted = new PersistentFileService({
      storageBaseDirectory,
      fileTtlMs: 60_000,
      maxUploadBytes: 1024,
      maxTenantStorageBytes: 4096,
      ...CAPACITY,
      runner: new FakeProcessor(),
      now: () => now,
    });
    expect(await restarted.list(OWNER_ID)).toEqual([]);
    expect(await readdir(join(storageBaseDirectory, "files"))).toEqual([]);
    await restarted.close();
  });

  test("rejects path-like and control-character filenames", async () => {
    const storageBaseDirectory = await mkdtemp(join(tmpdir(), "schemagrep-service-test-"));
    temporaryDirectories.push(storageBaseDirectory);
    const service = new PersistentFileService({
      storageBaseDirectory,
      fileTtlMs: 1000,
      maxUploadBytes: 1024,
      maxTenantStorageBytes: 4096,
      runner: new FakeProcessor(),
      ...CAPACITY,
    });

    for (const filename of ["../../events.jsonl", "..\\..\\events.jsonl", "\0events.jsonl"]) {
      await expect(
        service.ingest(
          {
            filename,
            stream: Readable.from(['{"id":1}\n']),
            wasTruncated: () => false,
          },
          OWNER_ID,
        ),
      ).rejects.toBeInstanceOf(InvalidFilenameError);
    }

    expect(await readdir(storageBaseDirectory)).toEqual([]);
    await service.close();
  });

  test("rejects an empty file before invoking schemagrep", async () => {
    const storageBaseDirectory = await mkdtemp(join(tmpdir(), "schemagrep-service-test-"));
    temporaryDirectories.push(storageBaseDirectory);
    const runner = new FakeProcessor();
    const service = new PersistentFileService({
      storageBaseDirectory,
      fileTtlMs: 1000,
      maxUploadBytes: 1024,
      maxTenantStorageBytes: 4096,
      runner,
      ...CAPACITY,
    });

    await expect(
      service.ingest(
        {
          filename: "empty.jsonl",
          stream: Readable.from([]),
          wasTruncated: () => false,
        },
        OWNER_ID,
      ),
    ).rejects.toBeInstanceOf(EmptyUploadError);

    expect(runner.encodeCalls).toBe(0);
    expect(runner.schemaCalls).toBe(0);
    await service.close();
  });

  test("tracks retained-byte quotas independently per tenant and releases usage on delete", async () => {
    const storageBaseDirectory = await mkdtemp(join(tmpdir(), "schemagrep-service-test-"));
    temporaryDirectories.push(storageBaseDirectory);
    const service = new PersistentFileService({
      storageBaseDirectory,
      fileTtlMs: 1000,
      maxUploadBytes: 1024,
      maxTenantStorageBytes: RETAINED_BYTES * 2 - 1,
      runner: new FakeProcessor(),
      ...CAPACITY,
    });
    const ingest = (ownerId: string) =>
      service.ingest(
        {
          filename: "events.jsonl",
          stream: Readable.from(['{"id":1}\n']),
          wasTruncated: () => false,
        },
        ownerId,
      );

    const firstAlpha = await ingest("alpha");
    await expect(ingest("alpha")).rejects.toBeInstanceOf(TenantStorageQuotaError);
    const firstBeta = await ingest("beta");
    expect(await service.delete(firstAlpha.id, "alpha")).toBe(true);
    const secondAlpha = await ingest("alpha");

    expect(await service.get(firstBeta.id, "beta")).toBeDefined();
    expect(await service.get(secondAlpha.id, "alpha")).toBeDefined();
    await service.close();
  });

  test("rejects unsupported extensions before creating storage", async () => {
    const storageBaseDirectory = await mkdtemp(join(tmpdir(), "schemagrep-service-test-"));
    temporaryDirectories.push(storageBaseDirectory);
    const service = new PersistentFileService({
      storageBaseDirectory,
      fileTtlMs: 1000,
      maxUploadBytes: 1024,
      maxTenantStorageBytes: 4096,
      runner: new FakeProcessor(),
      ...CAPACITY,
    });

    const ingest = service.ingest(
      {
        filename: "archive.zip",
        stream: Readable.from(["not a supported file"]),
        wasTruncated: () => false,
      },
      OWNER_ID,
    );

    await expect(ingest).rejects.toBeInstanceOf(UnsupportedFileTypeError);
    expect(await readdir(storageBaseDirectory)).toEqual([]);
    await service.close();
  });

  test("enforces per-tenant file and global retained-storage capacity", async () => {
    const storageBaseDirectory = await mkdtemp(join(tmpdir(), "schemagrep-service-test-"));
    temporaryDirectories.push(storageBaseDirectory);
    const service = new PersistentFileService({
      storageBaseDirectory,
      fileTtlMs: 60_000,
      maxUploadBytes: 1024,
      maxTenantStorageBytes: 4096,
      ...CAPACITY,
      maxActiveFilesPerTenant: 1,
      runner: new FakeProcessor(),
    });
    const ingest = (target: PersistentFileService, ownerId: string) => target.ingest(
      {
        filename: "events.jsonl",
        stream: Readable.from(['{"id":1}\n']),
        wasTruncated: () => false,
      },
      ownerId,
    );
    await ingest(service, OWNER_ID);
    await expect(ingest(service, OWNER_ID)).rejects.toBeInstanceOf(TenantFileLimitError);
    await service.close();

    const constrainedDirectory = await mkdtemp(join(tmpdir(), "schemagrep-service-test-"));
    temporaryDirectories.push(constrainedDirectory);
    const storageCapacity = new PersistentFileService({
      storageBaseDirectory: constrainedDirectory,
      fileTtlMs: 60_000,
      maxUploadBytes: 1024,
      maxTenantStorageBytes: 4096,
      ...CAPACITY,
      maxTotalStorageBytes: 25,
      runner: new FakeProcessor(),
    });
    await expect(ingest(storageCapacity, "other"))
      .rejects.toBeInstanceOf(ServiceStorageCapacityError);
    await storageCapacity.close();
  });
});
