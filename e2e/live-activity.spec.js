import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";

test("Activity follows agent events without interrupting a permalink or older page", async ({ page }) => {
  const path = "/boards/" + process.env.WHITEBOARD_E2E_LIVE_BOARD;
  const button = name => page.getByRole("button", { name, exact: true });
  const activity = page.getByRole("region", { name: "Activity", exact: true });
  const catchUp = button("New activity");
  const tick = () => page.clock.runFor(5_000);

  async function mutate(operation, data) {
    const response = await page.request.post(`/api${path}/${operation}`, {
      data,
      headers: {
        Authorization: "Bearer " + process.env.WHITEBOARD_E2E_LIVE_AGENT_TOKEN,
        "Idempotency-Key": randomUUID(),
      },
    });
    await expect(response).toBeOK();
    return response.json();
  }
  const post = (title, details) => mutate("entries", { payload: { title, details } });

  await page.clock.install();
  await page.goto(path);
  await page.getByLabel("Access token").fill(process.env.WHITEBOARD_E2E_LIVE_OBSERVER_TOKEN);
  await button("Connect").click();
  await button("Activity").click();
  await expect(activity.getByText("No activity for this selection on this page.")).toBeVisible();

  const work = await post("Live handoff", "Keep the exact draft visible");
  await tick();
  const posted = activity.locator("summary").filter({ hasText: /posted.*Live handoff/ });
  await expect(posted).toBeVisible();
  await expect(catchUp).toBeHidden();

  await mutate("take", { entryId: work.id });
  await tick();
  await expect(activity.locator("summary").filter({ hasText: /took.*Live handoff/ })).toBeVisible();

  await page.goto(`${path}?entry=${work.id}&event=post`);
  const open = activity.locator("details[open]");
  const json = open.getByLabel("Entry JSON");
  await expect(json).toContainText("Keep the exact draft visible");
  const link = open.getByRole("link", { name: "Link to this event", exact: true });
  await link.focus();
  const openNode = await open.elementHandle();

  await post("While reading");
  await tick();
  await expect(catchUp).toBeVisible();
  await expect(activity.getByText("While reading", { exact: true })).toHaveCount(0);
  expect(await openNode.evaluate(record => record.isConnected && record.open)).toBe(true);
  await expect(link).toBeFocused();
  await expect(json).toContainText("Keep the exact draft visible");

  await catchUp.click();
  await expect(activity.getByText("While reading", { exact: true })).toBeVisible();
  await expect(catchUp).toBeHidden();
  await expect(open.locator("summary")).toHaveText(/posted.*Live handoff/);
  await expect(open.locator("summary")).toBeFocused();
  await expect(page).toHaveURL(`${path}?entry=${work.id}&event=post`);

  for (let i = 1; i <= 50; i++) await post(`Page seed ${i}`);
  await button("Activity").click();
  await expect(activity.getByText("Page seed 50", { exact: true })).toBeVisible();
  await button("Next page").click();
  await expect(activity.getByText("Page 2", { exact: true })).toBeVisible();

  await post("While paging");
  await tick();
  await expect(catchUp).toBeVisible();
  await expect(activity.getByText("Page 2", { exact: true })).toBeVisible();
  await catchUp.click();
  await expect(activity.getByText("While paging", { exact: true })).toBeVisible();
  await expect(activity.getByText("Page 1", { exact: true })).toBeVisible();
  await expect(catchUp).toBeHidden();
});
