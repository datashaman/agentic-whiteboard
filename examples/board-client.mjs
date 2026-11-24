import { supportsExactJSON } from "../shared/exact-json.mjs";
import { Whiteboard } from "../shared/whiteboard.mjs";

export async function connectBoard() {
  if (!supportsExactJSON()) throw new Error("Use Node.js 22 or later to preserve exact JSON numbers.");
  if (!process.env.BOARD_URL || !process.env.BOARD_TOKEN?.trim()) {
    throw new Error("Set BOARD_URL and BOARD_TOKEN before starting the worker.");
  }
  const board = new Whiteboard(process.env.BOARD_URL, process.env.BOARD_TOKEN);
  const { archived, permissions } = await board.details();
  if (archived) throw new Error("Board archived. Check its status before retrying.");
  if (!permissions.includes("take") || !permissions.includes("post")) {
    throw new Error("The worker needs both Take and Post permissions before it can claim work.");
  }
  return board;
}
