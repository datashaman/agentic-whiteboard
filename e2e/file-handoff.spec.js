import { execFile, spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";

const exec = promisify(execFile);
const worker = fileURLToPath(new URL("../examples/file-worker.mjs", import.meta.url));

async function storeAddress(process) {
  const lines = createInterface({ input: process.stderr });
  const timer = setTimeout(() => process.kill(), 5000);
  try {
    for await (const line of lines) {
      const url = line.match(/WebDav Server started on \[(https:\/\/127\.0\.0\.1:\d+\/)\]/)?.[1];
      if (url) return url;
    }
    throw new Error("rclone did not announce its HTTPS address.");
  } finally {
    clearTimeout(timer);
    lines.close();
    process.stderr.resume();
  }
}

test("a private file moves through work and Activity under separate permissions", async ({ browser, request }) => {
  for (const [tool, arg] of [["rclone", "version"], ["openssl", "version"]]) {
    test.skip(spawnSync(tool, [arg]).error?.code === "ENOENT", tool + " is required for the file handoff");
  }

  const dir = await mkdtemp(join(tmpdir(), "whiteboard-file-handoff-"));
  const files = join(dir, "files");
  const key = join(dir, "key.pem");
  const cert = join(dir, "cert.pem");
  const credentials = join(dir, "users");
  const workerPassword = randomUUID();
  const readerPassword = randomUUID();
  let store, stopped, reader, observer;
  try {
    await mkdir(files);
    await writeFile(join(files, "transcript.txt"), "Hello from the private filestore.\n");
    const user = (name, password) => name + ":{SHA}" + createHash("sha1").update(password).digest("base64");
    await writeFile(credentials, [user("worker", workerPassword), user("reviewer", readerPassword)].join("\n") + "\n");
    await exec("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
      "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1",
      "-keyout", key, "-out", cert,
    ]);
    store = spawn("rclone", [
      "serve", "webdav", files, "--addr", "127.0.0.1:0", "--htpasswd", credentials,
      "--cert", cert, "--key", key, "--config", join(dir, "rclone.conf"), "--log-level", "NOTICE",
    ], { stdio: ["ignore", "ignore", "pipe"] });
    stopped = once(store, "exit");
    const storeURL = await storeAddress(store);
    const transcript = storeURL + "transcript.txt";
    const board = "/boards/" + process.env.WHITEBOARD_E2E_BOARD;
    const apiURL = process.env.WHITEBOARD_E2E_URL + "/api" + board;
    const work = await request.post(apiURL + "/entries", {
      headers: {
        Authorization: "Bearer " + process.env.WHITEBOARD_E2E_BROWSER_TOKEN,
        "Idempotency-Key": randomUUID(),
      },
      data: { payload: {
        kind: "work", action: "uppercase-file", task: "file-demo", title: "Uppercase a transcript",
        document: { transcript },
      } },
    });
    await expect(work).toBeOK();
    const original = await work.json();
    await exec(process.execPath, [worker], {
      env: {
        ...process.env,
        BOARD_URL: apiURL,
        BOARD_TOKEN: process.env.WHITEBOARD_E2E_AGENT_TOKEN,
        FILE_STORE_URL: storeURL,
        FILE_STORE_USER: "worker",
        FILE_STORE_PASSWORD: workerPassword,
        NODE_EXTRA_CA_CERTS: cert,
      },
    });

    reader = await browser.newContext({
      ignoreHTTPSErrors: true,
      httpCredentials: { origin: new URL(storeURL).origin, username: "reviewer", password: readerPassword },
    });
    observer = await browser.newContext({ ignoreHTTPSErrors: true });
    async function openResult(context, token) {
      const page = await context.newPage();
      await page.goto(process.env.WHITEBOARD_E2E_URL + board);
      await page.getByLabel("Access token").fill(token);
      await page.getByRole("button", { name: "Connect", exact: true }).click();
      await page.getByRole("button", { name: "Activity", exact: true }).click();
      const activity = page.getByRole("region", { name: "Activity", exact: true });
      await activity.getByText("Uppercase file result", { exact: true }).click();
      const payload = JSON.parse(await activity.getByLabel("Entry JSON").innerText());
      expect(payload.sourceEntryId).toBe(original.id);
      const uri = payload.report.uri;
      expect(uri).toMatch(/^https:\/\//);
      const link = activity.getByRole("link", { name: "Open " + uri, exact: true });
      await expect(link).toHaveAttribute("href", uri);
      return { page, link, uri };
    }

    const allowed = await openResult(reader, process.env.WHITEBOARD_E2E_BROWSER_TOKEN);
    const denied = await openResult(observer, process.env.WHITEBOARD_E2E_OBSERVER_TOKEN);
    expect(denied.uri).toBe(allowed.uri);

    const [file] = await Promise.all([allowed.page.waitForEvent("popup"), allowed.link.click()]);
    await expect(file.locator("body")).toHaveText("HELLO FROM THE PRIVATE FILESTORE.");
    const response = await observer.request.get(denied.uri);
    expect(response.status()).toBe(401);
  } finally {
    await Promise.allSettled([reader?.close(), observer?.close()]);
    store?.kill();
    try {
      await stopped;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});
