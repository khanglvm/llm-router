import { useLayoutEffect, useState } from "react";

const DEFAULT_VIEWPORT_PADDING = 12;

function isScrollableOverflow(value) {
  return /auto|scroll|hidden|clip|overlay/.test(String(value || "").toLowerCase());
}

function intersectRects(baseRect, nextRect) {
  return {
    top: Math.max(baseRect.top, nextRect.top),
    right: Math.min(baseRect.right, nextRect.right),
    bottom: Math.min(baseRect.bottom, nextRect.bottom),
    left: Math.max(baseRect.left, nextRect.left)
  };
}

export function getClippingAncestors(node) {
  if (typeof window === "undefined") return [];

  const ancestors = [];
  let current = node?.parentElement || null;

  while (current && current !== document.body && current !== document.documentElement) {
    const style = window.getComputedStyle(current);
    if (
      isScrollableOverflow(style.overflow)
      || isScrollableOverflow(style.overflowY)
      || isScrollableOverflow(style.overflowX)
    ) {
      ancestors.push(current);
    }
    current = current.parentElement;
  }

  return ancestors;
}

export function getDropdownBoundaryRect(node, { viewportPadding = DEFAULT_VIEWPORT_PADDING } = {}) {
  if (typeof window === "undefined") return null;

  let boundaryRect = {
    top: viewportPadding,
    right: window.innerWidth - viewportPadding,
    bottom: window.innerHeight - viewportPadding,
    left: viewportPadding
  };

  for (const ancestor of getClippingAncestors(node)) {
    boundaryRect = intersectRects(boundaryRect, ancestor.getBoundingClientRect());
  }

  return boundaryRect;
}

export function calculateDropdownPlacement({
  anchorRect,
  boundaryRect,
  preferredSide = "bottom",
  offset = 4,
  desiredHeight = 288
} = {}) {
  if (!anchorRect || !boundaryRect) {
    return {
      side: preferredSide === "top" ? "top" : "bottom",
      maxHeight: desiredHeight
    };
  }

  const spaceAbove = Math.max(0, anchorRect.top - boundaryRect.top - offset);
  const spaceBelow = Math.max(0, boundaryRect.bottom - anchorRect.bottom - offset);
  const resolvedPreferredSide = preferredSide === "top" ? "top" : "bottom";
  const side = spaceAbove === spaceBelow
    ? resolvedPreferredSide
    : spaceAbove > spaceBelow
      ? "top"
      : "bottom";
  const maxHeight = Math.max(
    0,
    Math.min(
      desiredHeight,
      side === "top" ? spaceAbove : spaceBelow
    )
  );

  return {
    side,
    maxHeight
  };
}

export function useDropdownPlacement({
  open = false,
  anchorRef,
  preferredSide = "bottom",
  offset = 4,
  desiredHeight = 288
} = {}) {
  const [placement, setPlacement] = useState(() => ({
    side: preferredSide === "top" ? "top" : "bottom",
    maxHeight: desiredHeight
  }));

  useLayoutEffect(() => {
    if (!open || typeof window === "undefined") return undefined;

    const anchorNode = anchorRef?.current || null;
    if (!anchorNode) {
      setPlacement({
        side: preferredSide === "top" ? "top" : "bottom",
        maxHeight: desiredHeight
      });
      return undefined;
    }

    const updatePlacement = () => {
      setPlacement(calculateDropdownPlacement({
        anchorRect: anchorNode.getBoundingClientRect(),
        boundaryRect: getDropdownBoundaryRect(anchorNode),
        preferredSide,
        offset,
        desiredHeight
      }));
    };

    updatePlacement();

    const ancestors = getClippingAncestors(anchorNode);
    window.addEventListener("resize", updatePlacement);
    for (const ancestor of ancestors) {
      ancestor.addEventListener("scroll", updatePlacement, { passive: true });
    }

    let resizeObserver = null;
    if (typeof ResizeObserver === "function") {
      resizeObserver = new ResizeObserver(updatePlacement);
      resizeObserver.observe(anchorNode);
      for (const ancestor of ancestors) {
        resizeObserver.observe(ancestor);
      }
    }

    return () => {
      window.removeEventListener("resize", updatePlacement);
      for (const ancestor of ancestors) {
        ancestor.removeEventListener("scroll", updatePlacement);
      }
      resizeObserver?.disconnect?.();
    };
  }, [open, anchorRef, preferredSide, offset, desiredHeight]);

  return placement;
}
