const TRANSIENT_INTEGER_INPUT_PATTERN = /^\d*$/;

export function classifyTransientIntegerInput(rawValue) {
  const nextValue = String(rawValue ?? "");
  const accepted = TRANSIENT_INTEGER_INPUT_PATTERN.test(nextValue);
  return {
    accepted,
    draftValue: accepted ? nextValue : "",
    shouldCommit: accepted && nextValue !== "",
    commitValue: accepted && nextValue !== "" ? nextValue : ""
  };
}
