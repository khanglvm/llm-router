import test from "node:test";
import assert from "node:assert/strict";
import { classifyTransientIntegerInput } from "./transient-integer-input-utils.js";

test("classifyTransientIntegerInput keeps empty numeric drafts local until the next digit", () => {
  assert.deepEqual(classifyTransientIntegerInput(""), {
    accepted: true,
    draftValue: "",
    shouldCommit: false,
    commitValue: ""
  });
});

test("classifyTransientIntegerInput commits digit-only edits", () => {
  assert.deepEqual(classifyTransientIntegerInput("12"), {
    accepted: true,
    draftValue: "12",
    shouldCommit: true,
    commitValue: "12"
  });
});

test("classifyTransientIntegerInput rejects non-digit edits", () => {
  assert.deepEqual(classifyTransientIntegerInput("12a"), {
    accepted: false,
    draftValue: "",
    shouldCommit: false,
    commitValue: ""
  });
});
