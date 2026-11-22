import { connectBoard } from "./board-client.mjs";

async function run() {
  const mutate = connectBoard();
  const work = await mutate("take", {
    pattern: { kind: "work", action: "uppercase" },
    waitMs: 10_000,
  });
  if (work === null) {
    console.log("No matching work.");
    return;
  }

  const { task, text } = work.payload;
  if (typeof task !== "string" || !task.trim() || typeof text !== "string") {
    throw new Error("Entry " + work.id + " needs a nonempty task and a text string. Recover it from Activity.");
  }
  const result = await mutate("entries", {
    payload: {
      kind: "result",
      task,
      title: "Uppercase result",
      sourceEntryId: work.id,
      text: text.toUpperCase(),
    },
  });
  console.log("Took entry " + work.id + " and posted result " + result.id + ".");
}

try {
  await run();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
