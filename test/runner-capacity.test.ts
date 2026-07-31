import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SchemagrepProcessError } from "../src/files/errors";
import { SchemagrepRunner } from "../src/schemagrep/runner";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function blockingProcessor(): Promise<{
  executable: string;
  artifactPath: string;
  releasePath: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "schemagrep-runner-test-"));
  temporaryDirectories.push(directory);
  const executable = join(directory, "blocking-processor");
  const artifactPath = join(directory, "artifact.sg");
  const releasePath = `${artifactPath}.release`;
  await writeFile(
    executable,
    [
      "#!/bin/sh",
      "while [ ! -f \"$2.release\" ]; do :; done",
      "printf '1\\n'",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  await chmod(executable, 0o700);
  return { executable, artifactPath, releasePath };
}

describe("SchemagrepRunner capacity", () => {
  test("bounds active workers and rejects beyond the configured queue", async () => {
    const processor = await blockingProcessor();
    const runner = new SchemagrepRunner({
      binaryPath: processor.executable,
      timeoutMs: 1000,
      maxArtifactBytes: 4096,
      maxSchemaBytes: 4096,
      maxQueryOutputBytes: 4096,
      maxActiveWorkers: 1,
      maxQueuedWorkers: 1,
      sandbox: { mode: "disabled" },
    });

    const active = runner.query(processor.artifactPath, []);
    const queued = runner.query(processor.artifactPath, []);
    const saturated = runner.query(processor.artifactPath, []);

    await expect(saturated).rejects.toMatchObject({
      name: "SchemagrepProcessError",
      kind: "busy",
    } satisfies Partial<SchemagrepProcessError>);
    await writeFile(processor.releasePath, "");
    expect(await active).toBe("1\n");
    expect(await queued).toBe("1\n");
  });
});
