import { connectBoard } from "./board-client.mjs";

async function run() {
  const [role, option, ...extra] = process.argv.slice(2);
  if (!["writer", "reviewer"].includes(role) || (option && option !== "--stop-after-take") || extra.length) {
    throw new Error("Usage: node examples/draft-review-worker.mjs writer|reviewer [--stop-after-take]");
  }

  const writing = role === "writer";
  const action = writing ? "revise-draft" : "review-draft";
  const { board, mutate } = await connectBoard();
  const work = await mutate("take", { pattern: { kind: "work", action }, waitMs: 10_000 });
  if (!work) {
    console.log("No work with action " + JSON.stringify(action) + " on " + board + ".");
    return;
  }
  if (option) {
    throw new Error("Stopped after taking entry " + work.id + ". Repost that entry from Activity to resume.");
  }

  const { task, issue, text } = work.payload;
  if (typeof task !== "string" || !task.trim() || typeof text !== "string" || !text.trim()) {
    throw new Error("Entry " + work.id + " needs a task ID and nonempty text. Recover it from Activity.");
  }

  const source = { task, issue, sourceEntryId: work.id };
  let payload;
  if (writing) {
    const sentence = text.trim().replace(/\s+/g, " ").replace(/^./u, first => first.toUpperCase());
    payload = {
      ...source, kind: "work", action: "review-draft", title: "Review the revised draft",
      text: /[.!?]$/.test(sentence) ? sentence : sentence + ".",
    };
  } else {
    const feedback = [];
    if (!/^\p{Lu}/u.test(text)) feedback.push("Start with a capital letter.");
    if (!/[.!?]$/.test(text)) feedback.push("End with a period, question mark, or exclamation point.");
    if (!feedback.length) feedback.push("The draft starts with a capital letter and ends with punctuation.");
    payload = { ...source, kind: "result", title: "Draft review", feedback };
  }
  const output = await mutate("entries", { payload });
  console.log("Took entry " + work.id + " and posted " + payload.title + " as entry " + output.id + ".");
}

try {
  await run();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
