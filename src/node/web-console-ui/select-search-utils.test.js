import test from "node:test";
import assert from "node:assert/strict";
import {
  filterSelectOptions,
  getSelectSearchKey,
  hasSelectSearchQuery,
  optionMatchesSelectQuery
} from "./select-search-utils.js";

test("hasSelectSearchQuery ignores empty and whitespace-only values", () => {
  assert.equal(hasSelectSearchQuery(""), false);
  assert.equal(hasSelectSearchQuery("   "), false);
  assert.equal(hasSelectSearchQuery("route"), true);
});

test("filterSelectOptions matches route label, value, and hint", () => {
  const options = [
    { value: "coding.default", label: "Coding default", hint: "Alias" },
    { value: "openai/gpt-5-codex", label: "GPT-5 Codex", hint: "Provider route" },
    { value: "claude/sonnet", label: "Claude Sonnet", hint: "Current config" }
  ];

  assert.deepEqual(
    filterSelectOptions(options, "codex").map((option) => option.value),
    ["openai/gpt-5-codex"]
  );
  assert.deepEqual(
    filterSelectOptions(options, "current").map((option) => option.value),
    ["claude/sonnet"]
  );
  assert.deepEqual(
    filterSelectOptions(options, "coding.default").map((option) => option.value),
    ["coding.default"]
  );
});

test("optionMatchesSelectQuery checks textValue and extra search text", () => {
  assert.equal(
    optionMatchesSelectQuery(
      {
        value: "openrouter/deepseek-r1",
        textValue: "DeepSeek R1",
        searchText: "Reasoning provider route"
      },
      "reasoning"
    ),
    true
  );

  assert.equal(
    optionMatchesSelectQuery(
      {
        value: "openrouter/deepseek-r1",
        textValue: "DeepSeek R1",
        searchText: "Reasoning provider route"
      },
      "haiku"
    ),
    false
  );
});

test("getSelectSearchKey ignores modifiers and whitespace", () => {
  assert.equal(getSelectSearchKey({ key: "g" }), "g");
  assert.equal(getSelectSearchKey({ key: " ", ctrlKey: false, metaKey: false, altKey: false }), "");
  assert.equal(getSelectSearchKey({ key: "g", ctrlKey: true }), "");
  assert.equal(getSelectSearchKey({ key: "ArrowDown" }), "");
});
