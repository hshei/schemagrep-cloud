import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const projectRoot = join(import.meta.dir, "..");

async function runCli(...args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, "src/cli.ts", ...args], {
    cwd: projectRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

async function readLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let output = "";
  for await (const chunk of stream) {
    output += decoder.decode(chunk, { stream: true });
    const newline = output.indexOf("\n");
    if (newline >= 0) return output.slice(0, newline);
  }
  return output + decoder.decode();
}

describe("cloud CLI guidance", () => {
  test("prints top-level help without requiring credentials", async () => {
    const result = await runCli("--help");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: bun run cloud -- <command> [options]");
    expect(result.stdout).toContain("Run `bun run cloud -- help COMMAND` for command-specific help.");
  });

  test("prints contextual query help with copyable one-line examples", async () => {
    const result = await runCli("query", "--help");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("query <FILE_ID|--latest> --mode MODE");
    expect(result.stdout).toContain("query --latest --mode count --key type --value push");
    expect(result.stdout).not.toContain("\\\n");
  });

  test("diagnoses whitespace-only arguments before authentication", async () => {
    const result = await runCli("query", " ");

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("A blank argument was received. Your shell probably broke a multiline command.");
    expect(result.stderr).toContain("Retry with the entire command on one line.");
  });

  test("rejects unknown options before authentication", async () => {
    const result = await runCli("files", "--bogus");

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Unknown arguments: --bogus");
  });

  test("discovers Client ID Metadata Document login without a hard-coded client ID", async () => {
    const requestedPaths: string[] = [];
    let origin = "";
    const authorizationServer = Bun.serve({
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        requestedPaths.push(path);
        if (path === "/.well-known/oauth-protected-resource/mcp") {
          return Response.json({
            resource: `${origin}/mcp`,
            authorization_servers: [origin],
          });
        }
        if (path.replace(/\/$/u, "") === "/.well-known/oauth-authorization-server") {
          return Response.json({
            issuer: origin,
            authorization_endpoint: `${origin}/authorize`,
            token_endpoint: `${origin}/token`,
            client_id_metadata_document_supported: true,
          });
        }
        if (path === "/token") return Response.json({});
        return new Response("Not found", { status: 404 });
      },
    });
    origin = `http://127.0.0.1:${authorizationServer.port}`;
    const child = Bun.spawn([
      process.execPath,
      "src/cli.ts",
      "login",
      "--server",
      origin,
      "--no-browser",
    ], {
      cwd: projectRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const authorizationLine = await readLine(child.stdout);
      if (authorizationLine.length === 0) {
        throw new Error(`${await new Response(child.stderr).text()} (${requestedPaths.join(", ")})`);
      }
      const authorizationUrl = new URL(authorizationLine);
      expect(authorizationUrl.origin).toBe(origin);
      expect(authorizationUrl.pathname).toBe("/authorize");
      expect(authorizationUrl.searchParams.get("client_id"))
        .toBe(`${origin}/oauth/client/schemagrep-cli`);
      expect(authorizationUrl.searchParams.get("resource")).toBe(`${origin}/mcp`);
      expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");

      const state = authorizationUrl.searchParams.get("state");
      const callback = await fetch(
        `http://127.0.0.1:47831/callback?code=test-code&state=${encodeURIComponent(state as string)}`,
      );
      expect(callback.status).toBe(200);
      const [stderr, exitCode] = await Promise.all([
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(exitCode).toBe(1);
      expect(stderr).toContain("Authorization server returned an invalid token response");
    } finally {
      child.kill();
      authorizationServer.stop(true);
    }
  });
});
