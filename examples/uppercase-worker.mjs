import { randomUUID } from "node:crypto";

async function run() {
  const token = process.env.BOARD_TOKEN?.trim();
  if (!process.env.BOARD_URL || !token) {
    throw new Error("Set BOARD_URL and BOARD_TOKEN before starting the worker.");
  }
  const url = new URL(process.env.BOARD_URL);
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("Use an HTTPS board URL or HTTP on loopback.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Use the board API URL without credentials, a query, or a fragment.");
  }
  const board = url.href.replace(/\/+$/, "");

  async function mutate(operation, input) {
    const requestID = randomUUID();
    const body = JSON.stringify(input);
    const send = async () => {
      const response = await fetch(board + "/" + operation, {
        method: "POST",
        body,
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json",
          "Idempotency-Key": requestID,
        },
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      if (response.ok) {
        return { status: response.status, entry: response.status === 204 ? null : await response.json() };
      }
      await response.body?.cancel();
      if (response.status >= 500) throw new Error("HTTP " + response.status);
      return { status: response.status };
    };

    // Retrying a lost response uses the same key and request body.
    const reply = await send().catch(send).catch(cause => {
      throw new Error("Could not confirm " + operation + " request " + requestID + ".", { cause });
    });
    if (reply.status >= 400) throw new Error(operation + " returned HTTP " + reply.status + ".");
    return reply.entry;
  }

  const work = await mutate("take", {
    pattern: { kind: "work", action: "uppercase" },
    waitMs: 10_000,
  });
  if (work === null) {
    console.log("No matching work.");
    return;
  }

  const { task, text } = work.payload;
  if (typeof task !== "string" || !task.trim() || typeof text !== "string") {
    throw new Error("Entry " + work.id + " needs a nonempty task and a text string. Recover it from Activity.");
  }
  const result = await mutate("entries", {
    payload: {
      kind: "result",
      task,
      title: "Uppercase result",
      sourceEntryId: work.id,
      text: text.toUpperCase(),
    },
  });
  console.log("Took entry " + work.id + " and posted result " + result.id + ".");
}

try {
  await run();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
