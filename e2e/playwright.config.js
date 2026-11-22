import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

const baseURL = process.env.WHITEBOARD_E2E_URL;

export default defineConfig({
  testDir: ".",
  use: { baseURL },
  webServer: process.env.WHITEBOARD_E2E_EXECUTABLE
    ? {
        command: 'exec "$WHITEBOARD_E2E_EXECUTABLE" serve',
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        url: `${baseURL}/api/boards/${process.env.WHITEBOARD_E2E_BOARD}`,
        reuseExistingServer: false,
        gracefulShutdown: { signal: "SIGTERM", timeout: 5000 },
        timeout: 15_000,
      }
    : undefined,
});
