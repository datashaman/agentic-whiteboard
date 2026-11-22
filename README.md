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

You need Go 1.27.4 or later and PostgreSQL for the service, plus Node.js 20 or later to build the optional browser client. Use a browser with `JSON.rawJSON()` for exact JSON numbers, such as Chrome or Edge 114 or later, Firefox 135 or later, or Safari 18.4 or later.

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

Open `http://127.0.0.1:8080/boards/demo` and paste the access token. Tasks groups work by its workflow-defined task ID. Live entries lets you post and inspect JSON. Activity shows who posted or took each entry and lets you recover taken work with Read and Post access.

Run `go run . token revoke demo <token-id>` to revoke a token. Whiteboards and their permissions are independent, so issue tokens for each board an agent needs.

## Connect an agent

See the [worker integration guide](docs/worker-integration.md) to run the example worker or connect an agent from your own runtime. Give each agent the board API URL and its own token.

The [private file handoff](docs/file-handoff.md) shows a worker sharing file references through the board and opening them with separate filestore credentials.

The service uses HTTPS when `WHITEBOARD_TLS_CERT` and `WHITEBOARD_TLS_KEY` point to a certificate and private key. You can also terminate HTTPS at a reverse proxy. Set `WHITEBOARD_ADDR` to change the listening address.

| Operation | Request | Permission |
| --- | --- | --- |
| Board details | `GET` at the board URL | Any board token |
| Post | `POST /entries` with a `payload` object | Post |
| Read | `POST /read` with a `pattern` and optional `waitMs` | Read |
| Take | `POST /take` with a `pattern` or `entryId`, and optional `waitMs` | Take |
| Browse | `POST /browse` with a `pattern` | Read |
| History | `GET /history` | Read |
| Inspect an entry | `GET /entries/{id}`, including entries already taken | Read |

Patterns match the specified top-level fields by JSON value. An empty pattern matches all live entries. Read and Take pick the oldest match and return HTTP 204 when a pattern has no match after the requested wait. Post and Take require an idempotency key. Use a fresh key for each new operation and reuse it when retrying that operation.

Browse and History return up to 50 records per page. If the response has a `nextCursor`, pass it as the `cursor` query parameter with the same Browse pattern or History selection to fetch the next page. Pass `summary=1` to list only the fields the browser uses for titles and task navigation. Open a record to fetch its full JSON.

## Run the tests

Set `TEST_DATABASE_URL` to a dedicated PostgreSQL test database. Go skips the database tests when this variable is unset. The browser test provisions its own board and leaves its records in that database. GitHub Actions runs both suites against a fresh PostgreSQL database.

Install rclone and OpenSSL to include the private-file browser test.

```sh
go test -race ./...
npm --prefix web ci
npm --prefix e2e ci
npm --prefix e2e exec -- playwright install chromium
npm --prefix e2e test
```
