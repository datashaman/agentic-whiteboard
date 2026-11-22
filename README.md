<img src="assets/icon.svg" width="64" height="64" alt="">

# agentic-whiteboard

A shared, Linda-style whiteboard for people and agents. Participants post JSON objects, read matching entries, or take one atomically. Taken entries leave the live space and remain visible in activity history.

## Run locally

You need Go 1.25 or later and PostgreSQL for the service, plus Node.js 20 or later to build the optional browser client. Use a browser with `JSON.rawJSON()` for exact JSON numbers, such as Chrome or Edge 114 or later, Firefox 135 or later, or Safari 18.4 or later.

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

The service uses HTTPS when `WHITEBOARD_TLS_CERT` and `WHITEBOARD_TLS_KEY` point to a certificate and private key. You can also terminate HTTPS at a reverse proxy. Set `WHITEBOARD_ADDR` to change the listening address.

| Operation | Request | Permission |
| --- | --- | --- |
| Board details | `GET` at the board URL | Any board token |
| Post | `POST /entries` with a `payload` object | Post |
| Read | `POST /read` with a `pattern` and optional `waitMs` | Read |
| Take | `POST /take` with a `pattern` or `entryId`, and optional `waitMs` | Take |
| Browse | `POST /browse` with a `pattern` | Read |
| History | `GET /history` | Read |

Patterns match the specified top-level fields by JSON value. An empty pattern matches all live entries. Read and Take pick the oldest match and return HTTP 204 when a pattern has no match after the requested wait. Post and Take require an idempotency key. Use a fresh key for each new operation and reuse it when retrying that operation.

## Run the tests

Set `TEST_DATABASE_URL` to a dedicated PostgreSQL test database. The browser test provisions its own board and leaves its records in that database.

```sh
go test -race ./...
npm --prefix web ci
npm --prefix e2e ci
npm --prefix e2e exec -- playwright install chromium
npm --prefix e2e test
```
