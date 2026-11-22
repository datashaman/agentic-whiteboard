import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { numberText, parseExactJSON } from "../shared/exact-json.mjs";

const exec = promisify(execFile);
const worker = fileURLToPath(new URL("../examples/draft-review-worker.mjs", import.meta.url));

test("the draft writer can stop after Take and hand off a recovered draft to the reviewer", async ({ page, request }) => {
  const board = "/boards/" + process.env.WHITEBOARD_E2E_BOARD;
  const api = process.env.WHITEBOARD_E2E_URL + "/api" + board;
  const token = process.env.WHITEBOARD_E2E_BROWSER_TOKEN;
  const issue = "9007199254740993";
  const draft = {
    kind: "work", action: "revise-draft", task: "draft-review-demo",
    title: "Revise the release note", text: "  the release notes are ready for review  ",
    issue: JSON.rawJSON(issue),
  };
  const posted = await request.post(api + "/entries", {
    headers: { Authorization: "Bearer " + token, "Idempotency-Key": randomUUID() },
    data: { payload: draft },
  });
  await expect(posted).toBeOK();
  const original = await posted.json();
  function run(role, ...args) {
    const tokenKey = role === "writer" ? "WHITEBOARD_E2E_DRAFT_WRITER_TOKEN" : "WHITEBOARD_E2E_DRAFT_REVIEWER_TOKEN";
    return exec(process.execPath, [worker, role, ...args], {
      env: { ...process.env, BOARD_URL: api, BOARD_TOKEN: process.env[tokenKey] },
    });
  }
  await expect(run("writer", "--stop-after-take")).rejects.toMatchObject({
    code: 1, stderr: expect.stringContaining("Stopped after taking entry " + original.id + "."),
  });

  await page.goto(board);
  await page.getByLabel("Access token").fill(token);
  const button = name => page.getByRole("button", { name, exact: true });
  const region = name => page.getByRole("region", { name, exact: true });
  await button("Connect").click();
  const taken = region("Taken").getByRole("button", { name: draft.title });
  await expect(taken).toContainText("Taken by Draft writer");
  await expect(taken.locator("time")).toHaveAttribute("datetime", /T/);
  await taken.click();
  const activity = region("Activity");
  const originalTake = activity.locator("details[open]");
  await expect(originalTake.getByLabel("Entry JSON")).toContainText(draft.text);
  await originalTake.getByRole("button", { name: "Repost", exact: true }).click();
  await expect(button("View original take (entry " + original.id + ")")).toBeVisible();

  await run("writer");
  await run("reviewer");
  await button("Tasks").click();
  await button("Result posted").click();
  await expect(region("Result posted").getByRole("button", { name: "Review the revised draft" })).toBeVisible();

  const history = await request.get(api + "/history", { headers: { Authorization: "Bearer " + token } });
  await expect(history).toBeOK();
  const { events } = parseExactJSON(await history.text());
  const replacement = events.find(event => event.repostedFrom === original.id);
  expect(replacement?.entry.payload).toEqual(draft);
  const revision = events.find(event => event.operation === "post" && event.entry.payload.action === "review-draft");
  expect(revision).toMatchObject({
    actor: "Draft writer", entry: { payload: {
      sourceEntryId: replacement.entry.id, text: "The release notes are ready for review.",
    } },
  });
  expect(numberText(revision.entry.payload.issue)).toBe(issue);
  const review = events.find(event => event.operation === "post" && event.entry.payload.title === "Draft review");
  expect(review).toMatchObject({
    actor: "Draft reviewer", entry: { payload: {
      sourceEntryId: revision.entry.id,
      feedback: ["The draft starts with a capital letter and ends with punctuation."],
    } },
  });
  expect(numberText(review.entry.payload.issue)).toBe(issue);
});
