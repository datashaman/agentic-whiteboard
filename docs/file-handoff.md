# Private file handoff

This example uses a private WebDAV directory to pass a text file through a whiteboard job. The entry carries a reference in its own JSON shape. Activity preserves that reference, and the filestore controls access to the bytes.

## Start a filestore

Use the [Compose stack](../README.md#run-with-docker-compose), or use an HTTPS WebDAV store with a writable worker login and a read-only reviewer login. To run [rclone WebDAV](https://rclone.org/commands/rclone_serve_webdav/) locally, use two listeners on the same directory with OpenSSL and `htpasswd`.

```sh
export FILE_DEMO_DIR="$(mktemp -d)"
printf 'Filestore demo directory %s\n' "$FILE_DEMO_DIR"
mkdir "$FILE_DEMO_DIR/files"
printf 'Hello from the private filestore.\n' > "$FILE_DEMO_DIR/files/transcript.txt"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -subj '/CN=127.0.0.1' -addext 'subjectAltName=IP:127.0.0.1' \
  -keyout "$FILE_DEMO_DIR/key.pem" -out "$FILE_DEMO_DIR/cert.pem"
htpasswd -cB "$FILE_DEMO_DIR/worker" worker
htpasswd -cB "$FILE_DEMO_DIR/reviewer" reviewer
rclone serve webdav "$FILE_DEMO_DIR/files" \
  --addr 127.0.0.1:8443 --read-only --min-tls-version tls1.2 \
  --cert "$FILE_DEMO_DIR/cert.pem" --key "$FILE_DEMO_DIR/key.pem" \
  --htpasswd "$FILE_DEMO_DIR/reviewer" &
rclone serve webdav "$FILE_DEMO_DIR/files" \
  --addr 127.0.0.1:8444 --min-tls-version tls1.2 \
  --cert "$FILE_DEMO_DIR/cert.pem" --key "$FILE_DEMO_DIR/key.pem" \
  --htpasswd "$FILE_DEMO_DIR/worker"
```

The worker and curl commands below trust this local certificate explicitly. For opening the links in a browser, use a certificate trusted by that browser.

If using an existing store, upload your transcript there and substitute your file URL, store URL, and credentials in the following steps. Set `NODE_EXTRA_CA_CERTS` when the worker needs to trust your store's private certificate authority.

## Run the handoff

Start the [whiteboard and demo board](../README.md#run-locally). In a separate shell with the same `DATABASE_URL`, issue a Take/Post token for the worker and a Read token for a second board viewer.

```sh
go run . token issue demo 'File worker' take,post
go run . token issue demo 'Board observer' read
```

Connect with the maintainer token and paste this JSON into **Post entry**. The names `document.transcript` and `report.uri` are how this example's worker understands a job.

```json
{
  "kind": "work",
  "action": "uppercase-file",
  "task": "transcript-demo",
  "title": "Uppercase a transcript",
  "document": {
    "transcript": "https://127.0.0.1:8443/transcript.txt"
  }
}
```

Set `FILE_DEMO_DIR` to the directory printed when starting the local filestore. Then run the [file worker](../examples/file-worker.mjs) from the repository root with Node.js 22 or later.

```sh
export BOARD_URL='http://127.0.0.1:8080/api/boards/demo'
export BOARD_TOKEN='<file worker board token>'
export FILE_STORE_URL='https://127.0.0.1:8443/'
export FILE_STORE_WRITE_URL='https://127.0.0.1:8444/'
export FILE_STORE_USER='worker'
export FILE_STORE_PASSWORD='<worker filestore password>'
export NODE_EXTRA_CA_CERTS="$FILE_DEMO_DIR/cert.pem"
node examples/file-worker.mjs
```

The worker takes one job and validates the transcript URL against `FILE_STORE_URL`. It reads the transcript and uploads the uppercase report using the same paths at `FILE_STORE_WRITE_URL`, then posts a report URL under `FILE_STORE_URL` for reviewers. The example accepts UTF-8 text up to 1 MiB. For a store that handles permissions on a single origin, omit `FILE_STORE_WRITE_URL`.

## Check visibility

Refresh **Activity** and expand **Uppercase file result**. Both the maintainer and the board observer can see the same report URL with their own board tokens. Open the link using the reviewer filestore login. A separate browser profile with board access will get the filestore's sign-in prompt.

You can also copy `report.uri` into `REPORT_URL` and verify both outcomes from the terminal. The first request prompts for the reviewer password and returns the uppercase text. The second returns HTTP 401.

```sh
curl --fail-with-body --cacert "$FILE_DEMO_DIR/cert.pem" --user reviewer "$REPORT_URL"
curl --silent --output /dev/null --write-out '%{http_code}\n' \
  --cacert "$FILE_DEMO_DIR/cert.pem" "$REPORT_URL"
```

Keep passwords in the client runtime. Put stable file references in the board payload, and retain each referenced version for the time you expect to recover work from Activity. If a worker stops mid-job, check Activity for a result before reposting the original work.
