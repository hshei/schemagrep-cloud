# schemagrep-cloud

Ephemeral HTTP API around [schemagrep](https://github.com/hshei/schemagrep). It accepts CSV, JSON, JSONL, and log files, retains the encoded artifact and schema for a short TTL, executes bounded structured queries, and deletes the raw upload immediately after processing.

The service does not make hosted model calls. Customer-owned models connect through the authenticated MCP endpoint and pay their own model provider; schemagrep-cloud never receives a model-provider credential.

## Prerequisites

- Node.js 22 LTS or newer
- Bun 1.3 or newer (package installation and test runner)
- C compiler and `make`
- `pkg-config`
- PCRE2 development headers (`pcre2` on Arch, `libpcre2-dev` on Debian/Ubuntu)
- Bubblewrap (`bubblewrap` package) for the default network/filesystem worker sandbox

## Clone and run locally

```bash
git clone --recurse-submodules https://github.com/hshei/schemagrep-cloud.git
cd schemagrep-cloud
bun install
bun run setup-engine
AUTH_DISABLED=true WORKER_SANDBOX=disabled bun run start
```

`AUTH_DISABLED=true` is accepted only when `HOST` is loopback. It is a local
development mode, never a deployment setting. Linux development can retain the
default Bubblewrap sandbox after installing `bubblewrap`.

The bundled engine is `vendor/schemagrep/schemagrep`. Override it only with an
explicit trusted build:

```bash
SCHEMAGREP_BIN=/absolute/path/to/schemagrep \
AUTH_DISABLED=true WORKER_SANDBOX=disabled bun run start
```

Startup checks that the configured binary is executable and is schemagrep
before listening.

## Managed account dashboard

Open `http://127.0.0.1:3000/` in local mode. Production users sign in through
WorkOS AuthKit. The service stores only an encrypted, HTTP-only browser session
cookie; unsafe cookie-authenticated requests additionally require a same-origin
CSRF token.

After sign-in, a user can upload a file, inspect active datasets and retained
storage, see upload/query/MCP usage, copy a `file_...` ID and OAuth-enabled MCP
configuration, inspect expiry, or delete an artifact. The dashboard is an
upload, lifecycle, and usage surface—not a chat product. Customer-owned model
clients perform inference and send only structured schema/query tool calls.

## Terminal cloud workflow

Authenticate once through the same managed account used by the dashboard.
Access and refresh tokens are stored in the OS credential store (`secret-tool`
on Linux, Keychain on macOS). The CLI uses OAuth discovery, PKCE, resource
indicators, and a hosted Client ID Metadata Document; no client secret or static
invite key is embedded.

```bash
bun run cloud -- login --server https://schemagrep.hani-labs.com
bun run cloud -- upload ./events.jsonl
bun run cloud -- files
bun run cloud -- schema --latest
bun run cloud -- query --latest --mode count --key type --value push
bun run cloud -- query --latest --mode rows
bun run cloud -- delete --latest
bun run cloud -- logout
```

The normal login path opens a browser. `login --no-browser` prints a URL for a
browser on the same computer because the PKCE callback binds to
`127.0.0.1:47831`. Upload output includes the file ID and next commands.
Schema, query, and delete accept either an explicit `file_...` ID or `--latest`.
Add `--json` for stable machine-readable output.

## Local REST example

Production users should use the dashboard, cloud CLI, or an OAuth-capable MCP
client. In loopback-only `AUTH_DISABLED=true` development mode:

```bash
UPLOAD=$(curl -sS -F "file=@vendor/schemagrep/samples/jsonl/qtest.jsonl" \
  "http://127.0.0.1:3000/v1/files")
FILE_ID=$(printf '%s' "$UPLOAD" | jq -r '.id')
curl -sS "http://127.0.0.1:3000/v1/files/$FILE_ID/schema"
curl -sS -H "Content-Type: application/json" \
  --data '{"mode":"count","target":{"key":"type"},"value":"push","filters":[]}' \
  "http://127.0.0.1:3000/v1/files/$FILE_ID/query" | jq
```

The query contract accepts `rows`, `count`, `grep`, `min`, `max`, `sum`, `avg`,
`argmax`, `argmin`, `distinct`, and `const`. A target or filter field is
`{"col":N}` for CSV, `{"slot":N}` for logs, and `{"slot":N}` or `{"key":"name"}`
for JSON/JSONL. Up to eight filters are combined with AND. `grep` has a required
bounded result limit from 1 to 100 (default 20) and reports exact truncation.

## Connect a customer-owned model through MCP

Configure only the remote Streamable HTTP endpoint:

```json
{
  "mcpServers": {
    "schemagrep": {
      "type": "http",
      "url": "https://schemagrep.example.com/mcp"
    }
  }
}
```

The MCP client discovers OAuth from the initial `401`, opens WorkOS browser
authorization with PKCE, sends the MCP resource indicator, and refreshes its
access token. The client must support remote Streamable HTTP MCP and OAuth.

The endpoint supports the current 2026 Streamable HTTP protocol and the
stateless 2025 fallback. It exposes three read-only tools:

| Tool | Purpose |
|---|---|
| `schemagrep_list_files` | List the signed-in user's active uploads |
| `schemagrep_get_schema` | Read a user-owned file's schema and query primer |
| `schemagrep_query` | Execute the validated, bounded query contract |

Upload through the dashboard or terminal, then ask about the file by name or
ID. The customer's model account performs inference; schemagrep-cloud receives
no model-provider credential.

## Routes

```text
GET    /
GET    /assets/*
GET    /health
GET    /ready
GET    /login
GET    /callback
GET    /csrf-token
POST   /logout
GET    /v1/session
GET    /v1/usage
GET    /v1/files
POST   /v1/files
GET    /v1/files/{id}
GET    /v1/files/{id}/schema
POST   /v1/files/{id}/query
DELETE /v1/files/{id}
POST   /v1/feedback
GET/POST/DELETE /mcp
GET    /.well-known/oauth-protected-resource
GET    /.well-known/oauth-protected-resource/mcp
GET    /.well-known/oauth-authorization-server
GET    /oauth/client/schemagrep-cli
```

The upload field must be `file`. Supported extensions are `.csv`, `.json`,
`.jsonl`, `.ndjson`, `.log`, and `.txt`. Health, readiness, static assets,
browser login/callback, OAuth discovery, and the public session status endpoint
are unauthenticated. Data and MCP routes require a valid WorkOS identity.

## Configuration

| Variable | Default |
|---|---:|
| `HOST` | `127.0.0.1` |
| `PORT` | `3000` |
| `PUBLIC_BASE_URL` | required HTTPS origin |
| `WORKOS_API_KEY` | required |
| `WORKOS_CLIENT_ID` | required |
| `WORKOS_AUTHKIT_URL` | required HTTPS AuthKit issuer |
| `WORKOS_COOKIE_PASSWORD` | required, 32–512 bytes |
| `CSRF_SECRET` | required, independent 32–512 byte secret |
| `AUTH_DISABLED` | `false`; loopback development only |
| `FILE_TTL_SECONDS` | `3600` |
| `MAX_UPLOAD_BYTES` | `26214400` |
| `MAX_ARTIFACT_BYTES` | four times upload limit, capped at 2 GiB |
| `MAX_SCHEMA_BYTES` | `4194304` |
| `MAX_QUERY_OUTPUT_BYTES` | `1048576` |
| `MAX_TENANT_STORAGE_BYTES` | `536870912` |
| `MAX_TOTAL_STORAGE_BYTES` | 16 GiB or tenant limit, whichever is larger |
| `MAX_ACTIVE_FILES_PER_TENANT` | `20` |
| `MAX_ACTIVE_FILES_TOTAL` | `1000` |
| `MIN_FREE_STORAGE_BYTES` | `1073741824` |
| `PROCESS_TIMEOUT_MS` | `30000` |
| `MAX_ACTIVE_WORKERS` | `4` |
| `MAX_QUEUED_WORKERS` | `16` |
| `STORAGE_DIR` | system temporary directory; set a persistent production path |
| `SCHEMAGREP_BIN` | bundled engine |
| `WORKER_SANDBOX` | `bwrap` |
| `BWRAP_BIN` | `/usr/bin/bwrap` |
| `RATE_LIMIT_MAX` | `60` |
| `RATE_LIMIT_WINDOW_MS` | `60000` |
| `TRUSTED_PROXY_CLIENT_IP_HEADER` | disabled |
| `MCP_ALLOWED_HOSTS` | bind host plus loopback names |
| `PRODUCT_TELEMETRY_PATH` | disabled |
| `PRODUCT_TELEMETRY_HASH_KEY` | required with telemetry path |
| `FEEDBACK_PATH` | disabled |
| `FEEDBACK_RETENTION_DAYS` | `30` |

See `deploy/schemagrep-cloud.env.example` for a complete production template.

## Production deployment

The provided deployment targets one Ubuntu 24.04 LTS server in Ashburn:

- minimum **4 vCPU, 8 GiB RAM, 80 GiB NVMe**;
- Caddy owns ports 80/443 and automatic TLS;
- Bun/Fastify binds only to `127.0.0.1:3000`;
- systemd supplies a 6 GiB cgroup ceiling and restart policy;
- Bubblewrap isolates every native schemagrep worker;
- file metadata and artifacts persist under `/var/lib/schemagrep-cloud`, while
  raw uploads are deleted immediately after encoding.

### 1. Configure WorkOS

Create a WorkOS project and AuthKit application. Configure:

1. sign-in callback: `https://schemagrep.example.com/callback`;
2. sign-out return URI: `https://schemagrep.example.com`;
3. MCP OAuth resource: `https://schemagrep.example.com/mcp`;
4. OAuth scopes: `openid` and `offline_access`;
5. Client ID Metadata Document support for public MCP clients.

`files:read`, `files:write`, and `files:delete` are internal resource
permissions enforced by schemagrep-cloud. Do not configure them as WorkOS OAuth
scopes.

Record the WorkOS API key, client ID, and AuthKit issuer origin. Generate the
cookie password and CSRF secret independently with a cryptographic secret
generator; each must contain at least 32 bytes.

### 2. Provision the server and DNS

Create the server in an Ashburn region, attach a firewall allowing TCP 22, 80,
and 443 only, and point the domain's `A`/`AAAA` records at it. Install Node.js
22 LTS, Bun, Caddy, Git, a C toolchain, `pkg-config`, PCRE2 headers, Bubblewrap,
and AppArmor tooling. The `tsx` production entry point requires `node`; Bun does
not replace that runtime dependency.

Ubuntu 24.04 restricts unprivileged user namespaces but does not currently ship
the Bubblewrap-specific AppArmor profile. Install the pinned upstream profile
without disabling Ubuntu's system-wide restriction:

```bash
curl -fsSL https://gitlab.com/apparmor/apparmor/-/raw/1979af7710d0f38db6680bd7c19c80902f11f969/profiles/apparmor/profiles/extras/bwrap-userns-restrict -o /tmp/bwrap-userns-restrict
echo "634d3d3427c483f123cb5ed53b71ea13040187e07d9f67ca74421d42a6170f0e  /tmp/bwrap-userns-restrict" | sha256sum -c -
sudo install -o root -g root -m 0644 /tmp/bwrap-userns-restrict /etc/apparmor.d/bwrap-userns-restrict
sudo apparmor_parser -r /etc/apparmor.d/bwrap-userns-restrict
rm -f /tmp/bwrap-userns-restrict
```

The bundled engine is a private submodule. Add a read-only deploy key for
`hshei/schemagrep` to the server's root account and configure GitHub SSH before
initializing it. Never copy a personal GitHub private key onto the server.

```bash
sudo useradd --system --home /var/lib/schemagrep-cloud --shell /usr/sbin/nologin schemagrep
sudo install -d -o schemagrep -g schemagrep -m 0700 /var/lib/schemagrep-cloud
sudo install -d -o root -g root -m 0755 /opt/schemagrep-cloud
sudo -u schemagrep bwrap --unshare-all --ro-bind / / /usr/bin/true
sudo git clone https://github.com/hshei/schemagrep-cloud.git /opt/schemagrep-cloud/current
cd /opt/schemagrep-cloud/current
sudo git config submodule.vendor/schemagrep.url git@github.com:hshei/schemagrep.git
sudo git submodule update --init --recursive
sudo /usr/local/bin/bun install --frozen-lockfile
sudo /usr/local/bin/bun run setup-engine
```

Ensure Node.js is available as `node` and Bun is available at
`/usr/local/bin/bun`, matching the systemd unit.

### 3. Install configuration

```bash
sudo cp deploy/schemagrep-cloud.env.example /etc/schemagrep-cloud.env
sudo chmod 0600 /etc/schemagrep-cloud.env
sudoedit /etc/schemagrep-cloud.env

sudo cp deploy/schemagrep-cloud.service /etc/systemd/system/
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudoedit /etc/caddy/Caddyfile  # replace the example domain and ACME email

sudo systemctl daemon-reload
sudo systemctl enable --now schemagrep-cloud
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

The Caddy template overwrites `X-Schemagrep-Client-IP`; the application trusts
only that loopback-proxy header. Do not expose port 3000 publicly or preserve a
client-supplied value in that header.

### 4. Verify and operate

```bash
curl -fsS https://schemagrep.example.com/health
curl -fsS https://schemagrep.example.com/ready
journalctl -u schemagrep-cloud -f
```

Then verify browser sign-in, upload, MCP discovery/authorization, schema read,
query, explicit deletion, TTL deletion, and service restart with an active
artifact. Saturated worker queues return `503` with `Retry-After`; tenant file
limits return `429`; disk/global storage pressure returns `503`.

For updates, pull a reviewed commit, update the submodule, run `bun install
--frozen-lockfile` and `bun run setup-engine`, then restart the service.
Artifacts and metadata survive the restart. Roll back by checking out the prior
reviewed commit and rebuilding the engine.

Product telemetry is opt-in and local. It records only day,
HMAC-pseudonymous tenant, action, outcome, HTTP status class, latency bucket,
and query mode—not filenames, schemas, records, values, file IDs, IP addresses,
or prompts:

```bash
bun run telemetry:report /var/lib/schemagrep-cloud/product-events.jsonl
bun run feedback:report /var/lib/schemagrep-cloud/feedback.jsonl
```

Feedback is separately consented and expires after
`FEEDBACK_RETENTION_DAYS`.

## Security boundary

The production service:

- delegates user accounts, browser login, token issuance, refresh, and logout
  lifecycle to WorkOS AuthKit;
- validates bearer JWT issuer, audience, signature, expiry, and required
  subject before deriving the stable per-user tenant ID;
- stores sealed browser sessions only in encrypted HTTP-only cookies and
  requires CSRF tokens for cookie-authenticated mutations;
- publishes MCP protected-resource discovery and a stable CLI Client ID
  Metadata Document; the CLI uses PKCE and OS credential storage;
- scopes all file access to the authenticated WorkOS user;
- persists atomic metadata beside each artifact, reloads valid unexpired files
  after restart, and removes incomplete crash remnants;
- enforces per-user and global retained-byte quotas, active-file caps, minimum
  free disk, a four-worker pool, and a bounded waiting queue;
- streams uploads through a byte cap, deletes raw sources after encoding, and
  deletes artifacts on request or TTL expiry;
- invokes schemagrep with fixed arguments and `shell: false`;
- accepts only a closed structured-query grammar and bounds grep evidence;
- validates MCP Host/Origin and runs workers in Bubblewrap with no network,
  cleared environment, read-only engine/input mounts, and no capabilities;
- bounds worker time, artifact/schema/query output, and captured stderr.

Rate limits and accounting are process-local. Run one application instance per
persistent storage directory. Horizontal replication requires shared metadata,
quota/rate accounting, and coordinated artifact storage; the supplied systemd
deployment intentionally does not pretend otherwise.

## Checks

```bash
bun run typecheck
bun test
```
