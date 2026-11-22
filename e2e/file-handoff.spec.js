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
  const workerPassword = randomUUID();
  const readerPassword = randomUUID();
  const stores = [];
  let reader, observer;
  try {
    await mkdir(files);
    await writeFile(join(files, "transcript.txt"), "Hello from the private filestore.\n");
    const user = (name, password) => name + ":{SHA}" + createHash("sha1").update(password).digest("base64");
    await exec("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
      "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1",
      "-keyout", key, "-out", cert,
    ]);
    async function startStore(name, password, options = []) {
      const credentials = join(dir, name);
      await writeFile(credentials, user(name, password) + "\n");
      const store = spawn("rclone", [
        "serve", "webdav", files, "--addr", "127.0.0.1:0", "--htpasswd", credentials,
        "--cert", cert, "--key", key, "--config", "/dev/null", "--log-level", "NOTICE", ...options,
      ], { stdio: ["ignore", "ignore", "pipe"] });
      stores.push({ store, stopped: once(store, "exit") });
      return storeAddress(store);
    }
    const storeURL = await startStore("reviewer", readerPassword, ["--read-only"]);
    const writeURL = await startStore("worker", workerPassword);
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
        FILE_STORE_WRITE_URL: writeURL,
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
    const write = await reader.request.put(allowed.uri, {
      headers: { Authorization: "Basic " + Buffer.from("reviewer:" + readerPassword).toString("base64") },
      data: "The reviewer should not be able to change this report.",
    });
    expect(write.ok()).toBe(false);
    expect(write.status()).not.toBe(401);
    await file.reload();
    await expect(file.locator("body")).toHaveText("HELLO FROM THE PRIVATE FILESTORE.");
  } finally {
    await Promise.allSettled([reader?.close(), observer?.close()]);
    for (const { store } of stores) store.kill();
    try {
      await Promise.all(stores.map(({ stopped }) => stopped));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});
