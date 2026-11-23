import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";

test("create boards on this server and a chosen remote server from one UI", async ({ page }) => {
  const central = process.env.WHITEBOARD_E2E_URL;
  const remote = process.env.WHITEBOARD_E2E_REMOTE_URL;
  const dialog = page.getByRole("dialog", { name: "Create whiteboard" });
  await page.goto(central);

  for (const target of [
    { origin: remote, token: process.env.WHITEBOARD_E2E_REMOTE_CREATE_TOKEN, name: "Remote project" },
    { origin: central, token: process.env.WHITEBOARD_E2E_CREATE_TOKEN, name: "Local project" },
  ]) {
    const slug = "project-" + randomUUID();
    await page.getByRole("button", { name: "Create whiteboard", exact: true }).click();
    await dialog.getByLabel("Target server URL").fill(target.origin);
    await dialog.getByLabel("Whiteboard name").fill(target.name);
    await dialog.getByLabel("URL slug").fill(slug);
    await dialog.getByLabel("Your display name").fill("Project lead");
    await dialog.getByLabel("Server creation token").fill(target.token);
    const [created] = await Promise.all([
      page.waitForResponse(response => response.url() === target.origin + "/api/boards" && response.request().method() === "POST"),
      dialog.getByRole("button", { name: "Create", exact: true }).click(),
    ]);
    expect(created.status()).toBe(201);

    const link = dialog.getByRole("link", { name: /^Open whiteboard on / });
    const boardURL = `${target.origin}/boards/${slug}`;
    await expect(link).toHaveAttribute("href", boardURL);
    const token = await dialog.getByLabel("New board token").inputValue();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await expect(dialog.getByText(/^Token ID [1-9]\d*$/)).toBeVisible();
    expect(await dialog.getByLabel("Server creation token").inputValue()).toBe("");
    await expect(page).toHaveURL(central + "/");

    const [board] = await Promise.all([page.waitForEvent("popup"), link.click()]);
    await expect(board).toHaveURL(boardURL);
    await board.getByLabel("Access token", { exact: true }).fill(token);
    await board.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(board.getByRole("heading", { name: target.name })).toBeVisible();
    await expect(board.getByRole("button", { name: "Post entry" })).toBeVisible();
    await board.close();
    await dialog.getByRole("button", { name: "Done", exact: true }).click();
    await expect(dialog).toBeHidden();
  }
});
