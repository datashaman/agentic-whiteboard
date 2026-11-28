import { randomUUID } from "node:crypto";
import { connectBoard } from "./board-client.mjs";

const maxFileBytes = 1024 * 1024;

function privateURL(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("Use a stable HTTPS file URL without credentials, a query, or a fragment.");
  }
  return url;
}

let workID;
try {
  const { FILE_STORE_URL, FILE_STORE_USER, FILE_STORE_PASSWORD } = process.env;
  if (!FILE_STORE_URL || !FILE_STORE_USER || FILE_STORE_USER.includes(":") || !FILE_STORE_PASSWORD) {
    throw new Error("Set FILE_STORE_URL, FILE_STORE_USER, and FILE_STORE_PASSWORD.");
  }
  const store = privateURL(FILE_STORE_URL);
  if (!store.pathname.endsWith("/")) store.pathname += "/";
  const writeStore = process.env.FILE_STORE_WRITE_URL ? privateURL(process.env.FILE_STORE_WRITE_URL) : store;
  const authorization = "Basic " + Buffer.from(FILE_STORE_USER + ":" + FILE_STORE_PASSWORD).toString("base64");

  async function fileRequest(url, method, body) {
    const headers = { Authorization: authorization };
    if (body !== undefined) headers["Content-Type"] = "text/plain; charset=utf-8";
    const endpoint = new URL(writeStore);
    endpoint.pathname = url.pathname;
    const response = await fetch(endpoint, {
      method, body, headers, redirect: "error", signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Filestore " + method + " returned HTTP " + response.status + ".");
    }
    return response;
  }

  const board = await connectBoard();
  const action = "uppercase-file";
  const work = await board.take({ pattern: { kind: "work", action }, waitMs: 10_000 });
  if (work === null) {
    console.log("No work with action " + JSON.stringify(action) + " on " + board.url + ".");
  } else {
    workID = work.id;
    const { task, document } = work.payload;
    if (typeof task !== "string" || !task.trim() || typeof document?.transcript !== "string") {
      throw new Error("This example requires a task ID and a document.transcript link.");
    }
    const transcript = privateURL(document.transcript);
    if (transcript.origin !== store.origin) {
      throw new Error("The transcript must be on the configured filestore origin.");
    }

    const input = await fileRequest(transcript, "GET");
    if (!input.body) throw new Error("The filestore returned no file body.");
    const chunks = [];
    let bytes = 0;
    for await (const chunk of input.body) {
      bytes += chunk.byteLength;
      if (bytes > maxFileBytes) throw new Error("This example accepts text files up to 1 MiB.");
      chunks.push(chunk);
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    const report = new URL("report-" + randomUUID() + ".txt", store);
    const upload = await fileRequest(report, "PUT", text.toUpperCase());
    await upload.body?.cancel();

    const result = await board.post({
      kind: "result", task, title: "Uppercase file result", sourceEntryId: workID,
      report: { uri: report.href },
    });
    console.log("Took entry " + workID + " and posted result " + result.id + ".");
  }
} catch (error) {
  console.error(error.message);
  if (workID) console.error("Check Activity for taken entry " + workID + " and any result before retrying.");
  process.exitCode = 1;
}
