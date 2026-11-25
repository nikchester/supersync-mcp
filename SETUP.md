# Setup

This service runs in Docker on the Ubuntu host. It listens on a configurable address and port. Nothing in the server is specific to a particular overlay network. Put the published port on an interface that only your private network can reach, or leave it on `127.0.0.1` and forward it from that network yourself.

The examples below use placeholders. Do not commit real tokens, passwords, or the access key.

## 1. Access key

Generate 32 random bytes and store them in a file mode `0600`:

```sh
mkdir -p secrets data
chmod 700 secrets data
umask 077
openssl rand -base64 32 > secrets/access.key
chmod 600 secrets/access.key
chown "$LOCAL_UID:$LOCAL_GID" secrets/access.key
```

`openssl rand -base64 32` prints 44 characters and is longer than the 32-byte minimum. The loader ignores one trailing newline. A group- or world-readable file is refused.

`ACCESS_KEY` in the environment is used only when `secrets/access.key` is absent. Prefer the file. If both are set and they differ, the process exits. Do not put the key in `.env` if that file is world-readable or copied into image layers.

## 2. SuperSync account

```sh
cp examples/supersync.json secrets/supersync.json
cp examples/accounts.json secrets/accounts.json
chmod 600 secrets/supersync.json secrets/accounts.json
```

Edit `secrets/supersync.json`:

- `baseUrl`: `https://sync.super-productivity.com`
- `accessToken`: the SuperSync access token from the official app
- `encryptionPassword`: the password that encrypts that account

`secrets/accounts.json` should keep a single entry, `id` `owner`, pointing at that file and at `data`. The running server rejects any other count.

Both JSON files must be mode `0600`. Directories `secrets/` and `data/` should be mode `0700` and owned by the uid/gid in `.env` (`LOCAL_UID` / `LOCAL_GID`, default `1000`).

## 3. Listen address and port

```sh
cp .env.example .env
```

| Variable | Default | Role |
|---|---|---|
| `MCP_BIND_ADDRESS` | `127.0.0.1` | Host interface Docker publishes. |
| `MCP_HOST_PORT` | `1901` | Host port Docker publishes. |
| `LISTEN_HOST` | `0.0.0.0` | Address the Node process binds inside the container. |
| `PORT` | `1901` | Port the Node process binds inside the container. |
| `ALLOWED_HOSTS` | `127.0.0.1,localhost` | `Host` headers the MCP endpoint accepts. |
| `TZ` | `Europe/Brussels` | Calendar timezone for today and due days. |
| `DAY_START_HOUR` | `4` | Fallback hour for `time_by_day` and `worklog_report` when the account has no start-of-next-day setting. |
| `CHANGE_LOG_PATH` | `data/changes/changes.jsonl` | Append-only write log. The path must stay under `data/changes/`. |
| `CHANGE_LOG_MAX_BYTES` | `1048576` | Cap for the current log file. The previous file is kept as `.1`. |
| `MCP_ALLOW_WRITES` | `false` | Set to `true` only when agents may change tasks. |
| `PLUGIN_DATA_PREFIXES` | empty | Prefixes such as `week-planner:` whose synced plugin records `get_plugin_data` may read. Empty: the tool is not registered. |

`127.0.0.1` and `localhost` are always allowed, including with the listen port (`127.0.0.1:1901`). Add every other name or address a client will send in `Host`. The check is exact. `tasks.internal` also allows `tasks.internal:1901`.

Leave `LISTEN_HOST` at `0.0.0.0` when you use Docker port publishing. Setting it to `127.0.0.1` inside the container makes the published host port unreachable, because Docker forwards to the container interface, not to the container's loopback.

To accept connections on a private interface of the host, set `MCP_BIND_ADDRESS` to that interface's address and keep the host firewall from accepting the same port from anywhere else. Do not set `MCP_BIND_ADDRESS=0.0.0.0` unless that firewall is already in place.

## 4. Build and start

```sh
docker compose run --rm dev npm ci
docker compose run --rm dev npm run setup
docker compose run --rm dev npm run build
docker compose up -d mcp
docker compose ps
```

`npm run setup` downloads the pinned Super Productivity source. The container healthcheck calls `http://127.0.0.1:$PORT/healthz`.

Read-only check, after the real SuperSync file is in place:

```sh
docker compose exec -T mcp node --import tsx src/smoke-read.ts
```

## 5. Who can connect

The process does not authenticate clients by source IP. The published bind address and the host firewall do that.

- Default: the port is on the host loopback only. Other machines cannot open it.
- Private interface: set `MCP_BIND_ADDRESS` to that address. On the host, allow the port only from the addresses that should call it, and drop it on every public interface.
- Add every non-loopback name a client sends in `Host` to `ALLOWED_HOSTS`, then recreate the container.

### Cloudflare Tunnel

Keep `MCP_BIND_ADDRESS=127.0.0.1`. Point the tunnel hostname, such as `https://mcp.example.com`, at `http://127.0.0.1:1901`. Set `ALLOWED_HOSTS=mcp.example.com` and recreate the container. Put the hostname behind Cloudflare Access and send the service-token headers with the bearer key:

```http
POST /mcp HTTP/1.1
Host: mcp.example.com
CF-Access-Client-Id: <service token client id>
CF-Access-Client-Secret: <service token secret>
Authorization: Bearer <key from secrets/access.key>
Content-Type: application/json
Accept: application/json, text/event-stream
```

The service token does not replace the bearer key. The same headers are shown in the README.

## 6. Optional egress limit

The service's only required outbound HTTPS dependency in normal operation is the SuperSync API. On a host that can restrict container or process egress, allow:

- `sync.super-productivity.com` port `443` for sync
- DNS, if name resolution is not already provided another way

`npm ci`, `npm run setup`, and image pulls need broader egress at build time. Runtime does not. Denying other outbound destinations limits what a compromised process can call. It does not protect the decrypted data already in memory.

## 7. MCP client

URL:

```text
http://127.0.0.1:1901/mcp
```

Use the private name or address instead when the client is not on this host. The transport is stateless Streamable HTTP. Send the key on every request:

```http
POST /mcp HTTP/1.1
Host: 127.0.0.1:1901
Authorization: Bearer <key from secrets/access.key>
Content-Type: application/json
Accept: application/json, text/event-stream
```

The key is the contents of `secrets/access.key` without the trailing newline. A wrong or missing key returns `401`. A `Host` value outside `ALLOWED_HOSTS` returns `403`. More than `RATE_LIMIT_MAX` requests from one client address in the window returns `429`. A proxy on this machine presents every client as `127.0.0.1`, so those clients share one limit.

With `MCP_ALLOW_WRITES` left false, `tools/list` returns the 15 read tools, including `time_by_day`, `worklog_report`, `list_changes`, `list_habits`, and `get_habit`. Write tools are not registered. Set `MCP_ALLOW_WRITES=true` and recreate the container to enable them. The full list is in the README. The write log is `data/changes/changes.jsonl` on the `./data` bind mount. The server creates `data/changes` when it appends the first line. The container runs as `LOCAL_UID` and does not use a separate volume for the log.

There is no login flow and no refresh token. Put the same bearer value in the client's HTTP header configuration. Rotate the key by replacing the file, recreating `mcp`, and updating the client.
