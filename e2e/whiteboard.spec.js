import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";

const boardPath = `/boards/${process.env.WHITEBOARD_E2E_BOARD}`;
const apiPath = `/api${boardPath}`;
const agentName = "README Agent";

const work = {
  kind: "work",
  task: "draft-readme",
  issue: 42,
  title: "Draft the project README",
  instructions: { include: ["setup", "usage"], existingDraft: null },
};
const sibling = {
  kind: "work",
  task: "verify-examples",
  issue: 42,
  title: "Verify the command examples",
};
const unrelated = {
  kind: "work",
  task: sibling.task,
  issue: 43,
  title: "Check the project license",
};
const note = {
  kind: "note",
  task: work.task,
  title: "Installation notes for the README",
};
const ambiguousNote = {
  kind: "note",
  task: sibling.task,
  title: "Notes with two possible issues",
};
const workPattern = { kind: "work", task: work.task, issue: work.issue };

test("a maintainer follows two tasks on one issue through agent handoff and recovery", async ({
  page,
  playwright,
}) => {
  const agent = await playwright.request.newContext({
    baseURL: process.env.WHITEBOARD_E2E_URL,
    extraHTTPHeaders: { Authorization: `Bearer ${process.env.WHITEBOARD_E2E_AGENT_TOKEN}` },
  });
  const button = (name) => page.getByRole("button", { name, exact: true });
  const issue = page.getByLabel("Issue", { exact: true });
  const region = (name) => page.getByRole("region", { name, exact: true });
  const card = (lane, name) => region(lane).getByRole("button", { name, exact: true });
  const live = region("Live entries");
  const activity = region("Activity");
  const originalTake = activity.locator("details")
    .filter({ has: page.getByText(agentName, { exact: true }) })
    .filter({ has: page.getByText(work.title, { exact: true }) });
  const refresh = () => button("Refresh").click();

  async function mutate(operation, data, status) {
    const response = await agent.post(`${apiPath}/${operation}`, {
      data,
      headers: { "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
    });
    expect(response.status(), `Agent ${operation}`).toBe(status);
    return response.json();
  }

  async function liveWork() {
    const response = await agent.post(`${apiPath}/browse`, { data: { pattern: workPattern } });
    await expect(response).toBeOK();
    return (await response.json()).entries;
  }

  try {
    await test.step("Post work in the browser and follow it from the issue to its live entries", async () => {
      for (const payload of [sibling, unrelated, note, ambiguousNote]) {
        await mutate("entries", { payload }, 201);
      }

      const boardPage = await page.goto(boardPath);
      expect(boardPage?.status(), "Board page").toBe(200);
      await page.getByLabel("Access token", { exact: true }).fill(process.env.WHITEBOARD_E2E_BROWSER_TOKEN);
      await button("Connect").click();
      await button("Live entries").click();
      await button("Post entry").click();
      await page.getByLabel("JSON object", { exact: true }).fill(JSON.stringify(work));
      await button("Post").click();
      await expect(live.getByText(work.title, { exact: true })).toBeVisible();

      await button("Tasks").click();
      await expect(card("Available", unrelated.title)).toBeVisible();
      await issue.selectOption({ label: `#${work.issue}` });
      await expect(card("Available", unrelated.title)).toHaveCount(0);
      await expect(card("Available", sibling.title)).toBeVisible();
      await card("Available", work.title).click();

      await expect(issue).toHaveValue(String(work.issue));
      await expect(live.getByText(work.title, { exact: true })).toBeVisible();
      await expect(live.getByText(note.title, { exact: true })).toBeVisible();
      await expect(live.getByText(sibling.title, { exact: true })).toHaveCount(0);
    });

    const original = await test.step("Take the work through the API and inspect its history in the browser", async () => {
      const entry = await mutate("take", { pattern: workPattern }, 200);
      expect(entry.payload).toEqual(work);
      await button("Tasks").click();
      await refresh();
      await expect(card("Taken", work.title)).toBeVisible();
      await button("Activity").click();
      await refresh();
      await expect(issue).toHaveValue(String(work.issue));
      await expect(activity.getByText(note.title, { exact: true })).toBeVisible();
      await expect(activity.getByText(ambiguousNote.title, { exact: true })).toHaveCount(0);

      await originalTake.getByText(work.title, { exact: true }).click();
      const raw = originalTake.getByLabel("Entry JSON", { exact: true });
      await expect(raw).toBeVisible();
      expect(JSON.parse(await raw.innerText())).toEqual(work);
      await expect(activity.getByText(unrelated.title, { exact: true })).toHaveCount(0);
      return entry;
    });

    const recovered = await test.step("Repost the work with a fresh ID and retain the original take", async () => {
      await originalTake.getByRole("button", { name: "Repost", exact: true }).click();
      await expect.poll(liveWork).toEqual([expect.objectContaining({ payload: work })]);
      const [entry] = await liveWork();
      expect(entry.id).not.toBe(original.id);

      const history = await agent.get(`${apiPath}/history`);
      await expect(history).toBeOK();
      expect((await history.json()).events).toContainEqual(expect.objectContaining({
        operation: "take",
        actor: agentName,
        entry: original,
      }));
      await button("Activity").click();
      await refresh();
      await expect(originalTake).toBeVisible();

      await button("Tasks").click();
      await refresh();
      await card("Available", work.title).click();
      await expect(issue).toHaveValue(String(work.issue));
      await expect(live.getByText(work.title, { exact: true })).toBeVisible();
      await expect(live.getByText(`ID ${entry.id}`, { exact: true })).toBeVisible();
      return entry;
    });

    await test.step("Post a result through the API and advance only the matching task card", async () => {
      const entry = await mutate("take", { entryId: recovered.id }, 200);
      expect(entry).toEqual(recovered);
      const result = (issueNumber) => `{"payload":{
        "kind":"result",
        "task":${JSON.stringify(work.task)},
        "issue":${issueNumber},
        "title":${JSON.stringify(work.title)},
        "body":"The draft includes setup and usage."
      }}`;

      await mutate("entries", result("42.0000000000000000001"), 201);
      await button("Tasks").click();
      await refresh();
      await expect(card("Taken", work.title)).toBeVisible();

      await mutate("entries", result("42.0"), 201);
      await refresh();
      await expect(issue).toHaveValue(String(work.issue));
      await expect(card("Result posted", work.title)).toBeVisible();
      await expect(card("Result posted", sibling.title)).toHaveCount(0);
      await expect(card("Available", sibling.title)).toBeVisible();
      await expect(card("Taken", work.title)).toHaveCount(0);
      await expect(issue.getByRole("option", { name: "42.0", exact: true })).toHaveCount(0);
    });

    await test.step("Connect without number support and report numeric data accurately", async () => {
      await page.addInitScript(() => {
        Object.defineProperty(JSON, "rawJSON", { value: undefined });
      });
      await page.reload();
      await page.getByLabel("Access token", { exact: true }).fill(process.env.WHITEBOARD_E2E_BROWSER_TOKEN);
      await button("Connect").click();
      await expect(page.getByRole("heading", { name: "Whiteboard browser test", exact: true })).toBeVisible();
      await expect(page.getByRole("alert")).toHaveText(/exact JSON numbers/);
    });
  } finally {
    await agent.dispose();
  }
});
