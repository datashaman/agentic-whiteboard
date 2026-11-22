import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const databaseURL = process.env.TEST_DATABASE_URL;
if (!databaseURL?.trim()) {
  console.error("Set TEST_DATABASE_URL to a dedicated PostgreSQL test database.");
  process.exit(1);
}

const e2e = fileURLToPath(new URL(".", import.meta.url));
const root = fileURLToPath(new URL("..", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "whiteboard-e2e-"));
const binary = join(scratch, "whiteboard");
const board = `e2e-${randomUUID()}`;

function run(command, args, capture = false) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: { ...process.env, DATABASE_URL: databaseURL },
    encoding: "utf8",
    stdio: ["inherit", capture ? "pipe" : "inherit", "inherit"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const name = command === binary ? "whiteboard" : command;
    throw new Error(`${name} ${args[0]} exited with ${result.status ?? result.signal}`);
  }
  return result.stdout;
}

function issueToken(actor, permissions, target = board) {
  const issued = JSON.parse(run(binary, ["token", "issue", target, actor, permissions], true));
  if (typeof issued?.token !== "string" || !issued.token) {
    throw new Error("The operator CLI did not return an access token.");
  }
  return issued.token;
}

try {
  run("go", ["build", "-o", binary, "."]);
  run("npm", ["--prefix", "web", "run", "build"]);
  run(binary, ["migrate"]);
  run(binary, ["board", "create", board, "Whiteboard browser test"]);
  const browserToken = issueToken("Maintainer", "read,post");
  const agentToken = issueToken("README Agent", "read,post,take");
  const observerToken = issueToken("Board observer", "read");
  const draftWriterToken = issueToken("Draft writer", "take,post");
  const draftReviewerToken = issueToken("Draft reviewer", "take,post");
  const pagingBoard = board + "-paging";
  run(binary, ["board", "create", pagingBoard, "Paged whiteboard"]);
  const pagingToken = issueToken("Maintainer", "read,post,take", pagingBoard);

  const socket = createServer().listen(0, "127.0.0.1");
  await once(socket, "listening");
  const address = `127.0.0.1:${socket.address().port}`;
  const closed = once(socket, "close");
  socket.close();
  await closed;

  const require = createRequire(import.meta.url);
  const tests = spawn(process.execPath, [require.resolve("@playwright/test/cli"), "test"], {
    cwd: e2e,
    stdio: "inherit",
    detached: true,
    env: {
      ...process.env,
      DATABASE_URL: databaseURL,
      WHITEBOARD_ADDR: address,
      WHITEBOARD_WEB_DIR: join(root, "web", "dist"),
      WHITEBOARD_TLS_CERT: "",
      WHITEBOARD_TLS_KEY: "",
      WHITEBOARD_E2E_EXECUTABLE: binary,
      WHITEBOARD_E2E_URL: `http://${address}`,
      WHITEBOARD_E2E_BOARD: board,
      WHITEBOARD_E2E_BROWSER_TOKEN: browserToken,
      WHITEBOARD_E2E_AGENT_TOKEN: agentToken,
      WHITEBOARD_E2E_OBSERVER_TOKEN: observerToken,
      WHITEBOARD_E2E_DRAFT_WRITER_TOKEN: draftWriterToken,
      WHITEBOARD_E2E_DRAFT_REVIEWER_TOKEN: draftReviewerToken,
      WHITEBOARD_E2E_PAGING_BOARD: pagingBoard,
      WHITEBOARD_E2E_PAGING_TOKEN: pagingToken,
    },
  });
  const forwardSignal = (signal) => tests.kill(signal);
  process.on("SIGINT", forwardSignal);
  process.on("SIGTERM", forwardSignal);
  try {
    const [code, signal] = await once(tests, "exit");
    process.exitCode = code ?? (signal === "SIGINT" ? 130 : 1);
  } finally {
    process.off("SIGINT", forwardSignal);
    process.off("SIGTERM", forwardSignal);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
