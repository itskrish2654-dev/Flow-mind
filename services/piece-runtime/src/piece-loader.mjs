import { REVIEWED_PIECE_BUILDS } from "./build-registry.mjs";
import { PieceRuntimeError } from "./errors.mjs";

export async function loadReviewedAction(manifest, builds = REVIEWED_PIECE_BUILDS) {
  const build = builds.getForManifest(manifest);
  const reviewedAction = build.actions[manifest.actionId];
  const action = await reviewedAction.resolve();
  if (
    action?.name !== manifest.actionId ||
    action?.classification !== reviewedAction.classification ||
    typeof action.run !== "function"
  ) {
    throw new PieceRuntimeError("PIECE_ACTION_NOT_ALLOWED");
  }
  return action;
}
