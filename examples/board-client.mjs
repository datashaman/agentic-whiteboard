import { randomUUID } from "node:crypto";

export async function connectBoard() {
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
  const authorization = "Bearer " + token;
  const access = await fetch(board, {
    headers: { Authorization: authorization },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!access.ok) {
    await access.body?.cancel();
    throw new Error("Board details returned HTTP " + access.status + ".");
  }
  const { archived, permissions } = await access.json();
  if (archived) throw new Error("Board archived. Check its status before retrying.");
  if (!Array.isArray(permissions) || !permissions.includes("take") || !permissions.includes("post")) {
    throw new Error("The worker needs both Take and Post permissions before it can claim work.");
  }

  async function mutate(operation, input) {
    const requestID = randomUUID();
    const body = JSON.stringify(input);
    const send = async () => {
      const response = await fetch(board + "/" + operation, {
        method: "POST",
        body,
        headers: {
          Authorization: authorization,
          "Content-Type": "application/json",
          "Idempotency-Key": requestID,
        },
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      if (response.ok) {
        return { status: response.status, entry: response.status === 204 ? null : await response.json() };
      }
      if (response.status === 409) {
        const error = await response.json().catch(() => null);
        return { status: response.status, error };
      }
      await response.body?.cancel();
      if (response.status >= 500) throw new Error("HTTP " + response.status);
      return { status: response.status };
    };

    // Retrying a lost response uses the same key and request body.
    const reply = await send().catch(send).catch(cause => {
      throw new Error("Could not confirm " + operation + " request " + requestID + ".", { cause });
    });
    if (reply.error?.code === "board_archived") throw new Error(reply.error.message);
    if (reply.status >= 400) throw new Error(operation + " returned HTTP " + reply.status + ".");
    return reply.entry;
  }

  return { board, mutate };
}
