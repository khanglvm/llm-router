import test from "node:test";
import assert from "node:assert/strict";
import { calculateDropdownPlacement } from "./dropdown-placement.js";

test("calculateDropdownPlacement prefers the larger visible space below", () => {
  const placement = calculateDropdownPlacement({
    anchorRect: { top: 100, bottom: 140 },
    boundaryRect: { top: 20, bottom: 420 },
    desiredHeight: 288
  });

  assert.equal(placement.side, "bottom");
  assert.equal(placement.maxHeight, 276);
});

test("calculateDropdownPlacement flips upward when the parent shows more space above", () => {
  const placement = calculateDropdownPlacement({
    anchorRect: { top: 280, bottom: 320 },
    boundaryRect: { top: 80, bottom: 360 },
    desiredHeight: 288
  });

  assert.equal(placement.side, "top");
  assert.equal(placement.maxHeight, 196);
});

test("calculateDropdownPlacement respects the preferred side on ties", () => {
  const placement = calculateDropdownPlacement({
    anchorRect: { top: 180, bottom: 220 },
    boundaryRect: { top: 40, bottom: 360 },
    preferredSide: "top",
    desiredHeight: 288
  });

  assert.equal(placement.side, "top");
  assert.equal(placement.maxHeight, 136);
});

test("calculateDropdownPlacement caps height to the requested menu size", () => {
  const placement = calculateDropdownPlacement({
    anchorRect: { top: 120, bottom: 160 },
    boundaryRect: { top: 20, bottom: 640 },
    desiredHeight: 160
  });

  assert.equal(placement.side, "bottom");
  assert.equal(placement.maxHeight, 160);
});
