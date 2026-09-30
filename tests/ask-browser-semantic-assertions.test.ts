import assert from "node:assert/strict";
import test from "node:test";

import {
  FALSE_APPROVAL_STATE_PATTERN,
  FALSE_EXTERNAL_DELIVERY_PATTERN,
  SPECIFIC_DATE_PATTERN,
  WRONG_WAITING_STATUS_PATTERN,
  classifyAskTurnObservation,
  containsMaterialPhrase,
  containsUnsupportedDependencyClaim,
  hasStructuredReference,
  normalizeAskDisplayText,
} from "../e2e/helpers/ask-semantic-assertions";

test("material phrase matching accepts only harmless display variation", () => {
  assert.equal(containsMaterialPhrase("Review launch proposal", "Review launch proposal"), true);
  assert.equal(containsMaterialPhrase("Please review the launch proposal.", "Review launch proposal"), true);
  assert.equal(containsMaterialPhrase("REVIEW — THE LAUNCH   PROPOSAL!", "Review launch proposal"), true);
});

test("material phrase matching rejects the wrong or unrelated Work Item", () => {
  assert.equal(containsMaterialPhrase("Review supplier invoice", "Review launch proposal"), false);
  assert.equal(containsMaterialPhrase("Archive old campaign notes", "Review launch proposal"), false);
});

test("structured reference matching rejects the wrong source entity", () => {
  const references = [{ kind: "work_item", label: "Review launch proposal", entityId: "expected-id" }];
  assert.equal(hasStructuredReference(references, {
    kind: "work_item", label: "Review launch proposal", entityId: "expected-id",
  }), true);
  assert.equal(hasStructuredReference(references, {
    kind: "work_item", label: "Review launch proposal", entityId: "different-id",
  }), false);
  assert.equal(hasStructuredReference(references, {
    kind: "work_item", label: "Confirm supplier shortlist", entityId: "expected-id",
  }), false);
});

test("normalization retains status and decision terms", () => {
  const normalized = normalizeAskDisplayText("Not waiting; Approved, rejected, done, high, low, sent, failed, completed.");
  for (const materialTerm of ["not", "waiting", "approved", "rejected", "done", "high", "low", "sent", "failed", "completed"]) {
    assert.match(normalized, new RegExp(`\\b${materialTerm}\\b`));
  }
});

test("negative semantic guards reject wrong status, approval, date, and delivery claims", () => {
  assert.equal(containsMaterialPhrase("Review launch proposal is waiting", "Review launch proposal"), true);
  assert.match("The customer contract review is done.", WRONG_WAITING_STATUS_PATTERN);
  assert.match("The customer contract review needs your action.", WRONG_WAITING_STATUS_PATTERN);
  assert.match("The request was approved yesterday and executed.", FALSE_APPROVAL_STATE_PATTERN);
  assert.match("The request has been rejected.", FALSE_APPROVAL_STATE_PATTERN);
  assert.match("It was approved on Thursday.", SPECIFIC_DATE_PATTERN);
  assert.match("The email was sent to the customer.", FALSE_EXTERNAL_DELIVERY_PATTERN);
});

test("follow-up semantic guard rejects unsupported dependencies but permits factual recommendations", () => {
  assert.equal(containsUnsupportedDependencyClaim(
    "I'd handle Review launch proposal first because it is high priority and the launch decision is waiting.",
  ), false);
  assert.equal(containsUnsupportedDependencyClaim(
    "No dependency is recorded; I recommend the launch proposal first because it is high priority.",
  ), false);
  for (const claim of [
    "Handle the proposal before the supplier shortlist can be finalized.",
    "The launch proposal blocks the supplier shortlist.",
    "The supplier shortlist depends on the launch proposal.",
    "The shortlist cannot proceed until the launch proposal is complete.",
    "The proposal is a prerequisite for the shortlist.",
  ]) {
    assert.equal(containsUnsupportedDependencyClaim(claim), true, claim);
  }
});

test("turn observation requires completed plus assistant and distinguishes failure", () => {
  assert.deepEqual(classifyAskTurnObservation("completed", true, null), { kind: "completed" });
  assert.deepEqual(classifyAskTurnObservation("failed", false, "generation_failed"), {
    kind: "failed",
    failureCategory: "generation_failed",
  });
  assert.deepEqual(classifyAskTurnObservation("processing", false, null), { kind: "processing" });
  assert.deepEqual(classifyAskTurnObservation("completed", false, null), { kind: "processing" });
  assert.deepEqual(classifyAskTurnObservation("processing", true, null), { kind: "processing" });
});
