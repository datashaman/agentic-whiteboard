import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";

const exec = promisify(execFile);

test("archive and reopen pause the board in the browser without losing available or taken work", async ({ page, request }) => {
  const slug = process.env.WHITEBOARD_E2E_ARCHIVE_BOARD;
  const path = "/boards/" + slug;
  const token = process.env.WHITEBOARD_E2E_ARCHIVE_TOKEN;
  const api = "/api" + path;
  const button = name => page.getByRole("button", { name, exact: true });
  const region = name => page.getByRole("region", { name, exact: true });
  async function mutate(operation, data) {
    const response = await request.post(api + "/" + operation, {
      headers: { Authorization: "Bearer " + token, "Idempotency-Key": randomUUID() },
      data,
    });
    await expect(response).toBeOK();
    return response.json();
  }
  const taken = await mutate("entries", { payload: { kind: "work", task: "taken", title: "Claimed draft" } });
  await mutate("take", { entryId: taken.id });
  const available = await mutate("entries", { payload: { kind: "work", task: "available", title: "Available draft" } });

  await page.goto(path);
  await page.getByLabel("Access token").fill(token);
  await button("Connect").click();
  await expect(region("Taken").getByRole("button", { name: "Claimed draft" })).toBeVisible();
  await button("Post entry").click();
  await exec(process.env.WHITEBOARD_E2E_EXECUTABLE, ["board", "archive", slug]);
  await button("Post").click();
  const banner = page.getByText("Archived · Read only", { exact: true });
  await expect(banner).toBeVisible();
  await expect(button("Post entry")).toBeHidden();
  expect(new URL(page.url()).pathname).toBe(path);

  await button("Live entries").click();
  const live = region("Live entries");
  await live.getByText("Available draft", { exact: true }).click();
  await expect(live.getByLabel("Entry JSON")).toContainText("Available draft");
  await expect(live.getByText("ID " + available.id, { exact: true })).toBeVisible();
  await expect(live.getByRole("button", { name: "Take", exact: true })).toBeHidden();

  await button("Tasks").click();
  await region("Taken").getByRole("button", { name: "Claimed draft" }).click();
  const activity = region("Activity");
  await expect(activity.getByLabel("Entry JSON")).toContainText("Claimed draft");
  await expect(activity.getByRole("button", { name: "Repost", exact: true })).toBeHidden();

  await exec(process.env.WHITEBOARD_E2E_EXECUTABLE, ["board", "reopen", slug]);
  await button("Refresh").click();
  await expect(banner).toBeHidden();
  await expect(button("Post entry")).toBeVisible();
  await expect(activity.getByRole("button", { name: "Repost", exact: true })).toBeVisible();
  await button("Tasks").click();
  await expect(region("Taken").getByRole("button", { name: "Claimed draft" })).toBeVisible();
  await expect(region("Available").getByRole("button", { name: "Available draft" })).toBeVisible();
});
