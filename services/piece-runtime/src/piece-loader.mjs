import { PieceRuntimeError } from "./errors.mjs";

export async function loadReviewedAction(manifest) {
  if (
    manifest.piecePackage !== "@activepieces/piece-hubspot" ||
    manifest.pieceVersion !== "0.8.10" ||
    manifest.actionId !== "get-contact"
  ) {
    throw new PieceRuntimeError("PIECE_ACTION_NOT_ALLOWED");
  }
  const loaded = await import("@activepieces/piece-hubspot");
  const action = loaded.hubspot?.actions?.()["get-contact"];
  if (
    action?.name !== manifest.actionId ||
    action?.classification !== manifest.expectedClassification ||
    typeof action.run !== "function"
  ) {
    throw new PieceRuntimeError("PIECE_ACTION_NOT_ALLOWED");
  }
  return action;
}
