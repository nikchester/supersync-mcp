# SuperSync MCP

A Docker bridge for one encrypted [Super Productivity](https://super-productivity.com/) SuperSync account. It decrypts that account and serves MCP tools over stateless Streamable HTTP at `POST /mcp`. It does not run the Super Productivity GUI, and it is not part of the official Super Productivity project.

This tree adapts the MIT-licensed project [yamichi77/supersync-mcp](https://github.com/yamichi77/supersync-mcp) at commit `6eec7c2c69e3741c11745b8a8dd34ca063d78f43`. That commit is recorded in [docs/bridge-upstream.json](docs/bridge-upstream.json). The MIT notice is [LICENSE](LICENSE). Third-party Super Productivity code is listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

One process serves one bearer key and one SuperSync account. Reads are available by default. Write tools are registered only when `MCP_ALLOW_WRITES=true`.

## Tools

Version 0.3.0 defines 45 tools. With writes off, only the 15 read tools are registered. Successful results use `structuredContent` and a JSON text fallback.

| Kind | Tools |
|---|---|
| Status and lookup | `get_sync_status` / `list_tasks` / `search_tasks` / `list_today` / `get_task` / `get_task_time` / `time_by_day` / `worklog_report` / `list_changes` |
| Lists | `list_projects` / `list_tags` / `list_archived_tasks` |
| Boards | `get_board` |
| Create and edit | `create_task` / `create_subtask` / `update_task` / `reorder_subtask` / `detach_subtask` / `attach_task` |
| Done and reopen | `complete_task` / `reopen_task` |
| Delete | `delete_task` |
| Archive | `archive_done_tasks` |
| Time | `log_task_time` / `set_task_time` / `set_task_estimate` |
| Batch | `batch` |
| Undo | `undo_change` |
| Tags | `update_task_tags` / `create_tag` / `rename_tag` |
| Standard Kanban | `set_task_kanban_status` |
| Projects | `create_project` / `move_task` |
| Boards | `create_board` / `update_board` |
| Habits | `list_habits` / `get_habit` / `set_habit_value` / `set_habit_values` / `increment_habit` / `toggle_habit_day` / `create_habit` / `update_habit` / `delete_habit` |

Read tools:

- `get_sync_status` reports the current sync sequence, whether writes are enabled, and how many active tasks are loaded.
- `list_tasks`, `list_archived_tasks`, `list_projects`, and `list_tags` return one page of that collection.
- `search_tasks` filters by title or notes, one project, one tag, a due-day range, and done state. Archived tasks are included only when `includeArchived` is true. TODAY follows the due day and is not a tag filter.
- `list_today` returns tasks due or scheduled today, plus undone overdue tasks and undone overdue deadlines. Today follows `TZ` (default `Europe/Brussels`) and the account start-of-next-day offset. Archived tasks and tasks in archived projects are omitted.
- `get_task` returns one task, including an archived task. A missing id returns null.
- `get_task_time` returns time spent, the estimate, and the per-day worklog for one active or archived task.
- `time_by_day` returns tracked time for an inclusive `YYYY-MM-DD` range in one call. Omit both dates for the current Monday–Sunday week. Totals count leaf `timeSpentOnDay` only, including archived tasks, so a parent that also stores its subtasks' time is not added again. Day keys are the app's logical days and are not split again by hour. The default week uses the account `startOfNextDayTime` when that setting exists. When neither that field nor the legacy `startOfNextDay` hour is present, `DAY_START_HOUR` (default 4) ends the working day at 04:00 in `TZ`. An explicit account offset, including midnight or a value other than 4, wins over `DAY_START_HOUR`.
- `worklog_report` uses that same range, boundary, and leaf selection. `groupBy` is any combination of `day`, `project`, and `task`; the default is all three. Every group has `totalMs` and `hours`, and the result has the same two fields for the whole range. Hours are rounded to two decimals from the milliseconds, so the sum of the rounded group hours can differ from the rounded grand total. A `day`-only report includes days with zero time. Other groupings list only groups that have time. Time logged after midnight and before the day boundary is already stored on the previous logical day. The report reads that key and does not split a stored day by clock hour.
- `get_board` returns one board, its columns, and card order.
- `list_changes` reads the append-only write log, newest first. It is available with writes off.
- `list_habits` and `get_habit` read habits (Super Productivity simple counters): settings, today's value, the current streak, and for `get_habit` the value of every day in a range of up to 366 days. The day value is clicks for `ClickCounter`, finished sessions for `RepeatedCountdownReminder`, and milliseconds for `StopWatch`.

Write tools, registered only when writes are on:

- `create_task` and `create_subtask` add a task. `create_subtask` is the same Add SubTask write as `create_task` with `parentId`.
- `update_task` changes title, notes, schedule, or deadline. It does not change `projectId` or time spent.
- `reorder_subtask` moves a subtask up, down, to the top, or to the bottom inside its current parent.
- `detach_subtask` turns a subtask into a top-level task. `attach_task` turns a top-level task into a subtask and refuses a task that already has subtasks, an issue, a repeat config, a due time, or a reminder.
- `complete_task` marks a task done. `reopen_task` clears done on an active task. It does not restore an archived task.
- `delete_task` requires `confirm: true`. It deletes an active task and its subtasks. Archived tasks are refused. Planner day ids are left as they are.
- `archive_done_tasks` requires `confirm: true`. It archives every done top-level active task and that task's subtasks. A done subtask of an open parent stays active.
- `log_task_time` adds time on one day. The day defaults to logical today. `set_task_time` sets one `YYYY-MM-DD` key in `timeSpentOnDay` to an exact number of milliseconds, including `0` to remove that key, for an active, done, or archived task. It sends `updateTask` with the full day map. The reducer sets `timeSpent` to the sum of that map, and a parent in the same list moves by the difference. The day key is stored as given. `set_task_estimate` sets `timeEstimate`. `update_task` does not take a time field.
- `update_task_tags` adds or removes named tags and keeps the others. `create_tag` and `rename_tag` manage normal tags. TODAY cannot be created or renamed.
- `set_task_kanban_status` sets `todo`, `in_progress`, or `done`. In progress uses the `KANBAN_IN_PROGRESS` tag.
- `create_project` adds a project. `move_task` moves a top-level task and its subtasks to another project.
- `create_board` and `update_board` manage a board. A board has a name and 1 to 50 columns. `update_board` changes settings of existing columns and keeps column order, card placement, and task bodies.
- Habits: `set_habit_value` sets one day and `set_habit_values` sets up to 62 days in one upload, both to exact values. `increment_habit` adds or subtracts and sends the absolute result, so a retry with the same `requestId` cannot count twice. `toggle_habit_day` ticks or unticks a checkbox habit. `create_habit`, `update_habit`, and `delete_habit` (needs `confirm: true`) manage the habit itself. Days default to logical today. All of them send the official simple-counter sync actions.
- `batch` runs 1 to 20 write operations, including `set_time`, in order and uploads them as one SuperSync request with one `expectedServerSeq` and one `requestId`. `idFrom`, `projectIdFrom`, `parentIdFrom`, `targetProjectIdFrom`, and `addTagIdsFrom` use the id created by an earlier operation in that batch. If `expectedServerSeq` is not the current sequence, nothing is uploaded. Every operation is replayed through the official reducers before the upload, and a failure in any of them uploads nothing. The batch is also rejected before upload when its operations contradict each other. `BATCH_CONFLICT` names the operations by index, kind, and requestId. That includes a later operation on a task deleted or archived earlier in the batch, moving one task to two projects, deleting a task completed earlier in the batch, a repeated operation `requestId`, and an id that is neither in the account nor produced by an earlier operation in the batch. An operation `requestId` is optional and must be unique inside the batch. The same batch `requestId` retries that same upload. SuperSync still decides each operation inside the request. If the server accepts some and rejects others, the call fails with `WRITE_PARTIALLY_ACCEPTED` and does not upload that request again. Read the account again and send a new request for whatever is still missing. A fully rejected upload leaves none of the batch on the server.
- Every successful write, including `batch` and `undo_change`, appends one line to an append-only JSONL file. The default path is `data/changes/changes.jsonl`, set with `CHANGE_LOG_PATH`, and it must stay under `data/changes/`. That directory is on the `./data` bind mount. The server creates it with the first log line. There is no separate volume. `CHANGE_LOG_MAX_BYTES` defaults to 1 MiB. When the next line would pass that cap, the current file is renamed to the same name with `.1` and a new file is started. The previous `.1` file is removed, so the log stays within about two caps. An entry stores the time, tool, `requestId`, `serverSeq` before and after the upload, and the before and after state of each affected task, project, tag, board, or habit. It does not store the access key, the SuperSync token, or the encryption password. `undo_change` sends the inverse official sync actions for one entry id. Pass `expectedServerSeq` from a fresh read. If any affected entity no longer matches the logged after state, the call returns `UNDO_CONFLICT` and uploads nothing. A successful undo is appended as its own entry. Some writes, such as a board edit whose inverse the official reducers do not restore exactly, return `UNDO_UNSUPPORTED` and upload nothing. A rejected upload, including `WRITE_PARTIALLY_ACCEPTED`, is not logged, so undo cannot roll back a prefix the server already accepted. The log keeps the current file and one rotated file only. If the log still cannot be written after the server has accepted the upload, the tool returns success with `changeLogWarning` instead of an error. The upload is already applied. Retry that same `requestId` to record the line. A new `requestId` would apply the change again.

Dates, reminders, and subtasks are described in [docs/TASK-DATES.md](docs/TASK-DATES.md), [docs/TASK-REMINDERS.md](docs/TASK-REMINDERS.md), and [docs/TASK-SUBTASKS.md](docs/TASK-SUBTASKS.md). Board argument limits are in [docs/BOARD-API-REVIEW.md](docs/BOARD-API-REVIEW.md). Archive restore and card reordering are not provided.

## Requirements

- Docker Compose, or Node.js 24 and tar for a local build and test run.
- One SuperSync account: its HTTPS base URL, access token, and encryption password.
- A bearer key of at least 32 random bytes. Clients send `Authorization: Bearer <key>`.

Host setup is in [SETUP.md](SETUP.md). Deployment notes are in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## First build

```sh
cp .env.example .env
mkdir -p secrets data
chmod 700 secrets data
cp examples/supersync.json secrets/supersync.json
cp examples/accounts.json secrets/accounts.json
openssl rand -base64 32 > secrets/access.key
chmod 600 secrets/*.json secrets/access.key
```

Edit `secrets/supersync.json` and replace the placeholders. If the host uid or gid is not 1000, set `LOCAL_UID` and `LOCAL_GID` in `.env`.

```sh
docker compose run --rm dev npm ci
docker compose run --rm dev npm run setup
docker compose run --rm dev npm run build
docker compose run --rm dev npm run check
docker compose run --rm dev npm test
docker compose up -d mcp
```

`npm run setup` downloads the Super Productivity revision pinned in [upstream.json](upstream.json), checks its SHA-256, and unpacks it into `vendor-source/`. Do not edit `vendor-source/`. A Super Productivity update has to move the pin, `vendor/`, the adapter, and the regression tests together.

`docker compose exec -T mcp node --import tsx src/smoke-read.ts` reads the configured account. The unit tests use fake HTTP and do not need that account.

## Configuration

| Item | Meaning |
|---|---|
| `MCP_BIND_ADDRESS`, `MCP_HOST_PORT` | Host interface and port published by Docker. Default `127.0.0.1:1901`. |
| `LISTEN_HOST`, `PORT` | Address and port inside the container. Default `0.0.0.0:1901`. Leave `LISTEN_HOST` at `0.0.0.0` when Docker publishes the port. |
| `ALLOWED_HOSTS` | `Host` values accepted for DNS-rebinding protection. `127.0.0.1` and `localhost` are always included. |
| `MCP_ALLOW_WRITES` | Default `false`. Write tools are registered only when this is `true`. |
| `PLUGIN_DATA_PREFIXES` | Default empty. Comma-separated record prefixes such as `week-planner:`, each ending with a colon. When set, the read-only tool `get_plugin_data` reads the synced plugin records (`pluginUserData`) whose id starts with one of them. Records of other plugins stay hidden. When empty, the tool is not registered. |
| `TZ` | Timezone for calendar days. Default `Europe/Brussels`. |
| `DAY_START_HOUR` | Fallback hour for `time_by_day` and `worklog_report` when the account has no start-of-next-day setting. Default `4`. It does not move stored day keys and does not override an account setting. |
| `CHANGE_LOG_PATH` | Append-only write log. Default `data/changes/changes.jsonl`. The path must stay under `data/changes/`. |
| `CHANGE_LOG_MAX_BYTES` | Cap for the current log file. Default 1 MiB. The previous file is kept as `.1`. |
| `RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS` | Per-client-address limit. Default 120 requests per 60 seconds. |
| `secrets/access.key` | Bearer key, mode `0600`. A trailing newline is ignored. `ACCESS_KEY` is accepted when the file is absent. |
| `secrets/supersync.json` | SuperSync URL, access token, and encryption password. Mode `0600`. |
| `secrets/accounts.json` | The single local account id, credential path, and data directory. |

Credential and key files that are readable by group or other are refused on Linux. Do not commit `secrets/`, `data/`, or a filled-in `.env`.

## Clients

Local URL:

```text
http://127.0.0.1:1901/mcp
```

```http
POST /mcp HTTP/1.1
Host: 127.0.0.1:1901
Authorization: Bearer <key from secrets/access.key>
Content-Type: application/json
Accept: application/json, text/event-stream
```

A wrong or missing key returns `401`. A `Host` value outside `ALLOWED_HOSTS` returns `403`. Too many requests from one client address return `429`. A proxy on this machine presents its clients as `127.0.0.1`, so they share one rate-limit bucket.

With writes left off, `tools/list` returns the 15 read tools, including `list_changes`. Set `MCP_ALLOW_WRITES=true` and recreate the container to register the write tools.

## Cloudflare Tunnel

Keep the published port on loopback and let a tunnel on the same machine expose it. This repository does not ship a tunnel config.

1. Leave `MCP_BIND_ADDRESS=127.0.0.1`.
2. Point the tunnel's public hostname, such as `https://mcp.example.com`, at `http://127.0.0.1:1901`.
3. Add that hostname to `ALLOWED_HOSTS`, for example `ALLOWED_HOSTS=mcp.example.com`, then recreate the container.
4. Protect the hostname with Cloudflare Access. Create a service token for the MCP client.
5. Send the Access headers and the bearer key on every request:

```http
POST /mcp HTTP/1.1
Host: mcp.example.com
CF-Access-Client-Id: <service token client id>
CF-Access-Client-Secret: <service token secret>
Authorization: Bearer <key from secrets/access.key>
Content-Type: application/json
Accept: application/json, text/event-stream
```

The bridge checks the bearer key and the `Host` header. Access is what rejects a request that lacks the service token. The service token does not replace the bearer key.

A private network such as Tailscale can reach the same loopback listener. This repository does not configure that network.

## Writes

Each write needs a unique `requestId` and the `expectedServerSeq` from the latest read. When the result is unknown, retry with the same request id and the same arguments.

- `STALE_REVISION_READ_AGAIN`: read again and send a new request id.
- `WRITE_PENDING_RETRY_SAME_REQUEST`: retry that same request. Do not start a different write.
- `WRITE_REJECTED`: nothing is overwritten automatically.

The encrypted body is stored before it is sent. A request that already succeeded returns the stored result. See [docs/OPERATIONS.md](docs/OPERATIONS.md).

Most writes send `entityId` and do not send `entityIds`. `archive_done_tasks` is the exception: it sends `entityIds` for the archived tasks. Other concurrent edits can be rejected with less context than the official app would show.

`src/smoke-write.ts` creates and changes tasks on the configured account. It is not part of the tests. Run it only on an account you intend to modify.

## Develop

```sh
npm ci
npm run setup
npm run build
npm run check
npm test
```

GitHub Actions runs that sequence. Tests use public fixtures and fake HTTP.

## Limits

The adapter targets the Super Productivity revision in [upstream.json](upstream.json) and schema version 4. It stops on an unknown operation, a new schema, a decryption failure, a gap it cannot repair, or a repair whose cause it cannot check. It does not run browser effects such as GUI notifications or external issue updates. Decrypted state stays in process memory. Run this process only on a host you trust.

The server builds that state once at startup, in the background, by replaying the stored log. Later refreshes download and apply only new operations. A full replay runs again only for a full-state operation (`SYNC_IMPORT`, `BACKUP_IMPORT`, `REPAIR`) or a gap in the log. A tool call made during the startup replay waits for it. The log shows `warmup_done` or `warmup_failed`, and `projection_full` for each full replay.

## License

MIT. See [LICENSE](LICENSE). Copyright notices on code imported from Super Productivity are kept. Sources are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
