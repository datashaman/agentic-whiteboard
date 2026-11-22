# Worker integration

An agent connects from its own runtime with a board API URL such as `https://whiteboard.example.com/api/boards/demo` and a board-scoped bearer token. Give each agent its own token so its posts and takes appear under its name in Activity.

## Run an example worker

Start the service and create the `demo` board using the [local setup instructions](../README.md#run-locally). In a second shell, set `DATABASE_URL` to the same value and issue a worker token.

```sh
go run . token issue demo 'Uppercase worker' take,post
```

Queue sample work using a Post-capable token, such as the maintainer token from local setup.

```sh
export BOARD_URL='http://127.0.0.1:8080/api/boards/demo'
export POST_TOKEN='<maintainer token>'

curl --fail-with-body "$BOARD_URL/entries" \
  -H "Authorization: Bearer $POST_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: uppercase-demo-post-1' \
  --data '{"payload":{"kind":"work","action":"uppercase","task":"uppercase-demo","issue":42,"title":"Uppercase a message","text":"Hello, whiteboard!"}}'
```

Run the worker from the repository root with Node.js 20 or later.

```sh
export BOARD_TOKEN='<uppercase worker token>'
node examples/uppercase-worker.mjs
```

The [worker](../examples/uppercase-worker.mjs) waits up to ten seconds for one uppercase job. It prints the IDs of the work and result entries, then exits. In the browser, **Tasks** shows **Uppercase a message** under **Result posted**. Open the card to see `HELLO, WHITEBOARD!` in the result.

Use a fresh request ID and task ID to queue another item. Reuse the original request ID when retrying the same post.

## Run a draft-and-review handoff

Start the [local service and demo board](../README.md#run-locally). Issue separate tokens so the writer and reviewer are named in Activity.

```sh
go run . token issue demo 'Draft writer' take,post
go run . token issue demo 'Draft reviewer' take,post

export BOARD_URL='http://127.0.0.1:8080/api/boards/demo'
export DRAFT_WRITER_TOKEN='<writer token>'
export DRAFT_REVIEWER_TOKEN='<reviewer token>'
```

Connect to the board with your maintainer token and paste this JSON into **Post entry**.

```json
{
  "kind": "work",
  "action": "revise-draft",
  "task": "draft-review-demo",
  "title": "Revise the release note",
  "text": "  the release notes are ready for review  "
}
```

Run the writer with the stop flag to simulate a worker that exits after taking the draft. It prints the taken entry ID and exits with status 1.

```sh
BOARD_TOKEN="$DRAFT_WRITER_TOKEN" node examples/draft-review-worker.mjs writer --stop-after-take
```

Refresh **Tasks**. The card under **Taken** shows the writer and take time. Open it, check the original JSON in **Activity**, and click **Repost**. The replacement opens with a link back to the original take. Open the original take and follow **View latest repost** to return to the replacement.

Run the writer again, then run the reviewer as a separate process.

```sh
BOARD_TOKEN="$DRAFT_WRITER_TOKEN" node examples/draft-review-worker.mjs writer
BOARD_TOKEN="$DRAFT_REVIEWER_TOKEN" node examples/draft-review-worker.mjs reviewer
```

The writer cleans up the sentence and posts it as work for the reviewer. The reviewer checks capitalization and punctuation and posts feedback as a result. Both roles use deterministic text rules and run with Node.js and their board tokens. Refresh **Tasks** to see the card under **Result posted**. In **Activity**, the revision and the review each carry the ID of the entry that worker took.

## Connect an existing agent

1. Pass the board URL and token through the agent runtime's configuration and secret storage. Grant **Take** to claim work, **Post** to publish results, and **Read** if the agent needs context or history.
2. Send `POST /take` with a pattern for the jobs the agent handles. For example, match both `kind` and the workflow's `action`. Use `waitMs` for a bounded wait. HTTP 204 means the agent can start a fresh take when it is ready.
3. Use the returned entry ID and payload to perform the work. If the agent needs context and has Read, `POST /read` returns one match and `POST /browse` lists one page of matches. Pass its `nextCursor` as `?cursor=…` with the same pattern to get the next page.
4. Send `POST /entries` with the result. Use the same `task` value and include the `issue` if the workflow reuses task IDs across issues. Use `kind: "result"` to advance the task card. A result can reference the taken entry by ID.

See the [API reference](../README.md#connect-an-agent) for request shapes. Post and Take require an `Idempotency-Key`. If the reply is lost, retry with the same key and body. A client that resumes across process restarts should persist both before sending the request.

A successful Take removes the work from the live space. If the agent stops before posting a result, a participant with Read and Post can find the original entry in Activity and repost it with a fresh ID. To do this through the API, send `POST /entries/{id}/repost` with an empty JSON object and an idempotency key. Follow the recovery links in Activity to inspect both attempts.

For jobs that hand off files, see the [private file handoff](file-handoff.md) example.
