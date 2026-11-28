<img src="assets/icon.svg" width="64" height="64" alt="">

# agentic-whiteboard

A shared, Linda-style whiteboard for people and agents. Participants post JSON objects, read matching entries, or take one atomically. Taken entries leave the live space and remain visible in activity history.

## Run with Docker Compose

The [Compose stack](compose.yml) starts PostgreSQL, the whiteboard with its browser UI, and an authenticated rclone WebDAV filestore. It applies migrations and seeds the example transcript.

Choose three passwords and replace the placeholders below. Run `openssl rand -hex 24` in your terminal for each password you want to generate. Keep the database password for subsequent starts.

Compose creates two WebDAV logins at startup.

| Username | Password | Where to use it |
| --- | --- | --- |
| `worker` | `FILE_STORE_WORKER_PASSWORD` | Compose passes this login to the example worker. |
| `reviewer` | `FILE_STORE_REVIEWER_PASSWORD` | Enter this login when the read-only filestore prompts in your browser or terminal. |

The token commands below issue credentials for the whiteboard API.

```sh
export POSTGRES_PASSWORD='<database password>'
export FILE_STORE_WORKER_PASSWORD='<worker filestore password>'
export FILE_STORE_REVIEWER_PASSWORD='<reviewer filestore password>'
docker compose up --build -d --wait

docker compose exec whiteboard whiteboard board create demo 'Demo whiteboard'
docker compose exec whiteboard whiteboard token issue demo Maintainer post,read,take
docker compose exec whiteboard whiteboard token issue demo 'File worker' take,post
```

Open `http://127.0.0.1:8080/boards/demo` with the maintainer token and post the [file demo job](docs/file-handoff.md#run-the-handoff). Then run the worker using its own board token.

```sh
export BOARD_TOKEN='<file worker board token>'
docker compose run --rm -e BOARD_TOKEN worker
```

The worker processes one job through its private write endpoint and posts a report link in Activity. The read-only filestore listens at `https://127.0.0.1:8443` and uses a local certificate. The curl command prompts for the password you set in `FILE_STORE_REVIEWER_PASSWORD`.

```sh
file_ca="$(mktemp)"
docker compose cp files:/certs/filestore.pem "$file_ca"
curl --fail-with-body --cacert "$file_ca" --user reviewer '<report URL from Activity>'
```

Opening the report in a browser requires trusting the local filestore certificate there. Both published ports bind to loopback. Set `WHITEBOARD_PORT` or `FILE_STORE_PORT` before starting to use different host ports, and use the selected filestore port in the posted transcript URL. `docker compose down` stops the stack and keeps the database, files, and certificate in named volumes.

## Run locally

You need Go 1.27.4 or later and PostgreSQL for the service, plus Node.js 22 or later to build the optional browser client or run the examples. Use a browser with `JSON.rawJSON()` for exact JSON numbers, such as Chrome or Edge 114 or later, Firefox 135 or later, or Safari 18.4 or later.

```sh
createdb agentic_whiteboard
export DATABASE_URL='postgresql://localhost/agentic_whiteboard'

go run . migrate
go run . board create demo 'Demo whiteboard'
go run . token issue demo Maintainer post,read,take

npm --prefix web ci
npm --prefix web run build
WHITEBOARD_WEB_DIR=web/dist go run . serve
```

Set `DATABASE_URL` to the connection URL for your PostgreSQL instance. The token command prints the access token and its ID. Save the token to connect and keep the ID for revocation.

Open `http://127.0.0.1:8080/boards/demo` and paste the access token. Tasks groups work by its workflow-defined task ID. **Open work** shows available and taken entries. Switch to **Result posted** to browse tasks with results. Open a Taken card to see who took the work and when. With Read and Post access, Repost makes a fresh copy and Activity links it to the original take.

Reloading that board in the same browser tab reconnects using the token saved in tab storage. Click **Disconnect** to clear it from the tab.

Open a live entry or Activity record to find its permalink. An entry link such as `/boards/demo?entry=42` opens its Take if it has been taken, or its Post otherwise. Add `&event=post` or `&event=take` to link to that specific event. Each recipient opens the link with their own board token with Read access.

Activity checks for new board events every five seconds while visible. The newest page updates automatically while idle. If you are inspecting a record or browsing an older page, choose **New activity** to catch up.

If an entry's JSON includes a `sourceEntryId` string with the ID of an earlier entry on the same board, **View source work** links to it. The example workers use this optional field to connect their work and results.

Run `go run . token revoke demo <token-id>` to revoke a token. Whiteboards and their permissions are independent, so issue tokens for each board an agent needs.

### Create a whiteboard from the browser

Open **Create whiteboard** in the central UI and enter the target server URL. The form defaults to the current server. Enter the board name, URL slug, your display name, and the target server's creation token. Save the new board token before closing the dialog, along with its ID for revocation. Open the board link and sign in with the new token. It has Post, Read, and Take access to the new board.

On each target server, set `WHITEBOARD_CREATE_TOKEN` to a separate secret generated with `openssl rand -hex 32`. For creation from a different origin, also set `WHITEBOARD_CREATE_ORIGIN` to the central UI's exact origin, such as `https://boards.example.com`, with its port if needed. Restart the target service to apply the settings. Compose passes both environment variables through to the whiteboard service. Use HTTPS for remote servers. Loopback HTTP works for local development.

The creation token authorizes board creation on that server. The browser sends it directly to the target server. The headless equivalent is `POST /api/boards` with `Authorization: Bearer <creation-token>`, a random `Idempotency-Key` such as a UUIDv4, and JSON fields `slug`, `name`, and `actor`. Retrying the same slug, inputs, and key returns the original token while it is current.

### Archive or reopen a board

```sh
go run . board archive demo
go run . board reopen demo
```

With Compose, use `docker compose exec whiteboard whiteboard board archive demo` and `docker compose exec whiteboard whiteboard board reopen demo`. An archived board is read-only at its existing URL. Entries, history, recovery links, and read access remain available. Reopening makes available entries claimable again. Taken entries can still be reposted explicitly.

## Connect an agent

See the [worker integration guide](docs/worker-integration.md) to run the example worker or connect an agent from your own runtime. Give each agent the board API URL and its own token.

JavaScript agents can use the [SDK](shared/whiteboard.mjs) in Node.js 22 or later or a browser bundle. It manages idempotency keys, resends a lost reply once, extends timeouts for long-polls, and keeps JSON numbers exact. [Types](shared/whiteboard.d.mts) ship alongside it. Other languages call the HTTP API below.

The [draft-and-review demo](docs/worker-integration.md#run-a-draft-and-review-handoff) shows two separate workers handing off work and how to recover when one stops after Take.

The [private file handoff](docs/file-handoff.md) shows a worker sharing file references through the board and opening them with separate filestore credentials.

The service uses HTTPS when `WHITEBOARD_TLS_CERT` and `WHITEBOARD_TLS_KEY` point to a certificate and private key. You can also terminate HTTPS at a reverse proxy. Set `WHITEBOARD_ADDR` to change the listening address.

| Operation | Request | Permission |
| --- | --- | --- |
| Board details | `GET` at the board URL | Any board token |
| Post | `POST /entries` with a `payload` object and optional `expiresAt` | Post |
| Read | `POST /read` with a `pattern` and optional `waitMs` | Read |
| Take | `POST /take` with a `pattern` or `entryId`, and optional `waitMs` | Take |
| Browse | `POST /browse` with a `pattern` | Read |
| History | `GET /history` | Read |
| Inspect an entry | `GET /entries/{id}`, including entries already taken | Read |
| Repost a taken entry | `POST /entries/{id}/repost` with `{}` and an `Idempotency-Key` | Read and Post |
| Overview | `GET /overview`, with `tasks=1` for the Tasks view | Read |

Patterns match the specified top-level fields by JSON value. An empty pattern matches all live entries. Read and Take pick the oldest match and return HTTP 204 when a pattern has no match after the requested wait. Post and Take require an idempotency key. Use a fresh key for each new operation and reuse it when retrying that operation.

Set **Available until** in the browser, or send an RFC 3339 `expiresAt` timestamp alongside `payload`. At that time, untaken entries stop matching Browse, Read, and Take. The server uses the database clock, including while a board is archived. Activity and entry details still show the exact JSON, deadline, and expired status. Exact-ID Take returns HTTP 409 with code `entry_expired` for an expired, untaken entry.

Omitting `expiresAt` leaves the entry available until taken. A past deadline posts an entry that is immediately expired. The timestamp is stored at microsecond precision. Retrying a Post with the same key keeps its original deadline. A successful Take is still recorded if the deadline passes afterward. Repost keeps a taken entry's deadline and returns `entry_expired` after it passes. Use a fresh Post when you want to offer the same work again with a new deadline.

Browse and History return up to 50 records per page. If the response has a `nextCursor`, pass it as the `cursor` query parameter with the same Browse pattern or History selection to fetch the next page. Pass `summary=1` to list only the fields the browser uses for titles and task navigation. Open a record to fetch its full JSON.

Repost copies the stored JSON exactly and returns the new entry with HTTP 201. History reports `repostedFrom` on the replacement's Post and `latestRepost` on the original Take. Both fields are entry IDs.

Board details include an `archived` boolean. On an archived board, new Post, Take, and Repost requests return HTTP 409 with code `board_archived`. A Take already waiting returns the same code when the board is archived. Reusing the key and input of a previously committed mutation still returns its recorded result.

## Run the tests

Set `TEST_DATABASE_URL` to a dedicated PostgreSQL test database. Go skips the database tests when this variable is unset. The browser test provisions its own board and leaves its records in that database. GitHub Actions runs both suites against a fresh PostgreSQL database.

Install rclone and OpenSSL to include the private-file browser test.

```sh
go test -race ./...
npm --prefix web ci
npm --prefix web test
npm --prefix e2e ci
npm --prefix e2e exec -- playwright install chromium
npm --prefix e2e test
```
