import { useLayoutEffect, useRef, useMemo } from "react";
import { captureScrollSettleSnapshot, isScrollSettleSnapshotStable } from "../utils.js";

export function useReorderLayoutAnimation(itemKeys = []) {
  const itemRefs = useRef(new Map());
  const refCallbacksRef = useRef(new Map());
  const previousRectsRef = useRef(new Map());
  const previousSignatureRef = useRef("");
  const keySignature = JSON.stringify(itemKeys);

  useLayoutEffect(() => {
    const nextRects = new Map();
    for (const itemKey of itemKeys) {
      const node = itemRefs.current.get(itemKey);
      if (node) nextRects.set(itemKey, node.getBoundingClientRect());
    }

    const prefersReducedMotion = typeof window !== "undefined"
      && typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const shouldAnimate = previousSignatureRef.current !== "" && previousSignatureRef.current !== keySignature;

    if (shouldAnimate && !prefersReducedMotion) {
      for (const itemKey of itemKeys) {
        const previousRect = previousRectsRef.current.get(itemKey);
        const nextRect = nextRects.get(itemKey);
        const node = itemRefs.current.get(itemKey);
        if (!previousRect || !nextRect || !node) continue;
        const deltaY = previousRect.top - nextRect.top;
        if (Math.abs(deltaY) < 1 || typeof node.animate !== "function") continue;
        node.animate(
          [
            { transform: `translateY(${deltaY}px)` },
            { transform: "translateY(0)" }
          ],
          {
            duration: 220,
            easing: "cubic-bezier(0.22, 1, 0.36, 1)"
          }
        );
      }
    }

    const activeKeys = new Set(itemKeys);
    for (const itemKey of refCallbacksRef.current.keys()) {
      if (!activeKeys.has(itemKey)) refCallbacksRef.current.delete(itemKey);
    }

    previousRectsRef.current = nextRects;
    previousSignatureRef.current = keySignature;
  }, [keySignature]);

  return useMemo(() => (itemKey) => {
    if (!refCallbacksRef.current.has(itemKey)) {
      refCallbacksRef.current.set(itemKey, (node) => {
        if (node) {
          itemRefs.current.set(itemKey, node);
          return;
        }
        itemRefs.current.delete(itemKey);
      });
    }
    return refCallbacksRef.current.get(itemKey);
  }, []);
}
