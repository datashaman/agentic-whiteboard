import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

const baseURL = process.env.WHITEBOARD_E2E_URL;
const remoteURL = process.env.WHITEBOARD_E2E_REMOTE_URL;

function whiteboardServer(url, token, origin = "") {
  return {
    command: 'exec "$WHITEBOARD_E2E_EXECUTABLE" serve',
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    url: `${url}/api/boards/${process.env.WHITEBOARD_E2E_BOARD}`,
    env: {
      WHITEBOARD_ADDR: new URL(url).host,
      WHITEBOARD_CREATE_TOKEN: token,
      WHITEBOARD_CREATE_ORIGIN: origin,
    },
    reuseExistingServer: false,
    gracefulShutdown: { signal: "SIGTERM", timeout: 5000 },
    timeout: 15_000,
  };
}

export default defineConfig({
  testDir: ".",
  use: { baseURL },
  webServer: process.env.WHITEBOARD_E2E_EXECUTABLE
    ? [
        whiteboardServer(baseURL, process.env.WHITEBOARD_E2E_CREATE_TOKEN),
        whiteboardServer(remoteURL, process.env.WHITEBOARD_E2E_REMOTE_CREATE_TOKEN, baseURL),
      ]
    : undefined,
});
