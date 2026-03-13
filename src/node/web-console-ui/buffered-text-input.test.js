import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveBufferedTextInputBlurCommitValue,
  resolveBufferedTextInputValue,
  syncBufferedTextInputDraft
} from "./buffered-text-input.js";

test("syncBufferedTextInputDraft keeps the local draft after blur when the committed value is still stale", () => {
  assert.deepEqual(syncBufferedTextInputDraft({
    committedValue: "old-key",
    draftValue: "new-key",
    isFocused: false,
    hasLocalDraft: true,
    previousCommittedValue: "old-key"
  }), {
    draftValue: "new-key",
    hasLocalDraft: true,
    previousCommittedValue: "old-key"
  });
});

test("syncBufferedTextInputDraft clears the local draft when the committed value catches up", () => {
  assert.deepEqual(syncBufferedTextInputDraft({
    committedValue: "new-key",
    draftValue: "new-key",
    isFocused: false,
    hasLocalDraft: true,
    previousCommittedValue: "old-key"
  }), {
    draftValue: "new-key",
    hasLocalDraft: false,
    previousCommittedValue: "new-key"
  });
});

test("syncBufferedTextInputDraft adopts an external reset while blurred", () => {
  assert.deepEqual(syncBufferedTextInputDraft({
    committedValue: "server-key",
    draftValue: "new-key",
    isFocused: false,
    hasLocalDraft: true,
    previousCommittedValue: "old-key"
  }), {
    draftValue: "server-key",
    hasLocalDraft: false,
    previousCommittedValue: "server-key"
  });
});

test("resolveBufferedTextInputValue prefers the buffered draft while it is still local", () => {
  assert.equal(resolveBufferedTextInputValue({
    committedValue: "old-key",
    draftValue: "new-key",
    isFocused: false,
    hasLocalDraft: true
  }), "new-key");
});

test("resolveBufferedTextInputBlurCommitValue only commits buffered drafts on blur when enabled", () => {
  assert.equal(resolveBufferedTextInputBlurCommitValue({
    commitOnBlur: false,
    draftValue: "new-key",
    hasLocalDraft: true
  }), null);

  assert.equal(resolveBufferedTextInputBlurCommitValue({
    commitOnBlur: true,
    draftValue: "new-key",
    hasLocalDraft: false
  }), null);

  assert.equal(resolveBufferedTextInputBlurCommitValue({
    commitOnBlur: true,
    draftValue: "new-key",
    hasLocalDraft: true
  }), "new-key");
});
