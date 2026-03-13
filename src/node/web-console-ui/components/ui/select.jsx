import {
  Children,
  useCallback,
  cloneElement,
  createContext,
  forwardRef,
  isValidElement,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import { Input } from "./input.jsx";
import { cn } from "../../lib/utils.js";
import {
  getSelectSearchKey,
  hasSelectSearchQuery,
  optionMatchesSelectQuery,
  shouldShowSelectSearchInput
} from "../../select-search-utils.js";
import { useDropdownPlacement } from "../../dropdown-placement.js";

const SelectSearchContext = createContext(null);
const DEFAULT_SELECT_SEARCH_PLACEHOLDER = "Enter character to filter";
const SELECT_SEARCH_HEADER_HEIGHT = 41;
const SELECT_SEARCH_INPUT_DATA_ATTR = "data-llm-router-select-search-input";

function extractTextFromNode(node) {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map((item) => extractTextFromNode(item)).filter(Boolean).join(" ");
  if (isValidElement(node)) return extractTextFromNode(node.props?.children);
  return "";
}

function focusSelectOption(container, direction = "first") {
  const options = Array.from(container?.querySelectorAll?.("[role='option']") || [])
    .filter((node) => node.getAttribute("aria-disabled") !== "true");
  if (options.length === 0) return;

  const checked = options.find((node) => node.getAttribute("data-state") === "checked");
  const target = direction === "last"
    ? options[options.length - 1]
    : checked || options[0];
  target?.focus?.();
}

function buildSelectItemSearchEntry(props = {}) {
  const textValue = String(props.textValue || extractTextFromNode(props.children) || "").trim();
  return {
    value: String(props.value || ""),
    textValue,
    searchText: String(props.searchText || "")
  };
}

function filterSelectChildren(children, query = "") {
  let totalItems = 0;
  let matchedItems = 0;

  const filteredChildren = Children.map(children, (child) => {
    if (!isValidElement(child)) return child;

    if (child.type?.__LLM_ROUTER_SELECT_ITEM === true) {
      totalItems += 1;
      const matches = optionMatchesSelectQuery(buildSelectItemSearchEntry(child.props), query);
      if (matches) matchedItems += 1;
      return matches ? child : null;
    }

    if (!child.props?.children) return child;

    const nested = filterSelectChildren(child.props.children, query);
    totalItems += nested.totalItems;
    matchedItems += nested.matchedItems;
    if (child.type?.__LLM_ROUTER_SELECT_GROUP === true && nested.matchedItems === 0) return null;
    return cloneElement(child, undefined, nested.children);
  });

  return {
    children: filteredChildren,
    totalItems,
    matchedItems
  };
}

export function Select({
  open: openProp,
  defaultOpen = false,
  onOpenChange,
  searchEnabled = true,
  openSearchRequest = 0,
  children,
  ...props
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(Boolean(defaultOpen));
  const [filterValue, setFilterValue] = useState("");
  const [searchSessionActive, setSearchSessionActive] = useState(false);
  const triggerRef = useRef(null);
  const handledOpenSearchRequestRef = useRef(0);
  const open = openProp !== undefined ? openProp : uncontrolledOpen;

  useEffect(() => {
    if (open) return;
    setFilterValue("");
    setSearchSessionActive(false);
  }, [open]);

  function handleOpenChange(nextOpen) {
    if (openProp === undefined) setUncontrolledOpen(nextOpen);
    onOpenChange?.(nextOpen);
    if (!nextOpen) {
      setFilterValue("");
      setSearchSessionActive(false);
    }
  }

  useEffect(() => {
    if (!openSearchRequest || openSearchRequest === handledOpenSearchRequestRef.current) return;
    handledOpenSearchRequestRef.current = openSearchRequest;
    setFilterValue("");
    if (searchEnabled) setSearchSessionActive(true);
    if (open) return;
    if (openProp === undefined) {
      setUncontrolledOpen(true);
    }
    onOpenChange?.(true);
  }, [openSearchRequest, searchEnabled, open, openProp, onOpenChange]);

  const contextValue = {
    open,
    searchEnabled,
    filterValue,
    setFilterValue,
    searchSessionActive,
    setSearchSessionActive,
    setOpen: handleOpenChange,
    triggerRef,
    openSearchRequest
  };

  return (
    <SelectSearchContext.Provider value={contextValue}>
      <SelectPrimitive.Root {...props} open={open} onOpenChange={handleOpenChange}>
        {children}
      </SelectPrimitive.Root>
    </SelectSearchContext.Provider>
  );
}

export const SelectTrigger = forwardRef(function SelectTrigger({ className, children, onKeyDown, ...props }, ref) {
  const searchContext = useContext(SelectSearchContext);
  const triggerRef = searchContext?.triggerRef || null;

  const setTriggerNode = useCallback((node) => {
    if (triggerRef) {
      triggerRef.current = node;
    }
    if (typeof ref === "function") {
      ref(node);
      return;
    }
    if (ref) ref.current = node;
  }, [triggerRef, ref]);

  function handleKeyDown(event) {
    onKeyDown?.(event);
    if (event.defaultPrevented || !searchContext?.searchEnabled || props.disabled) return;
    const searchKey = getSelectSearchKey(event);
    if (!searchKey) return;
    event.preventDefault();
    searchContext.setSearchSessionActive?.(true);
    searchContext.setOpen(true);
    searchContext.setFilterValue((current) => `${current}${searchKey}`);
  }

  return (
    <SelectPrimitive.Trigger
      ref={setTriggerNode}
      className={cn(
        "relative inline-flex h-9 w-full items-center gap-2 rounded-lg border border-input bg-background/80 pl-3 pr-9 text-sm text-foreground shadow-sm outline-none transition focus:border-ring focus:ring-2 focus:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      onKeyDown={handleKeyDown}
      {...props}
    >
      <span className="min-w-0 flex-1 truncate text-left">
        {children}
      </span>
      <SelectPrimitive.Icon className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground">▾</SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
});

export function SelectValue(props) {
  return <SelectPrimitive.Value {...props} />;
}

export const SelectContent = forwardRef(function SelectContent({
  className,
  children,
  position = "popper",
  onKeyDownCapture,
  searchPlaceholder = DEFAULT_SELECT_SEARCH_PLACEHOLDER,
  emptySearchMessage = "No matching options.",
  ...props
}, ref) {
  const searchContext = useContext(SelectSearchContext);
  const contentRef = useRef(null);
  const searchInputRef = useRef(null);
  const placement = useDropdownPlacement({
    open: Boolean(searchContext?.open),
    anchorRef: searchContext?.triggerRef,
    preferredSide: "bottom",
    desiredHeight: 288,
    offset: 4
  });
  const searchVisible = shouldShowSelectSearchInput({
    searchEnabled: searchContext?.searchEnabled,
    filterValue: searchContext?.filterValue,
    sessionActive: searchContext?.searchSessionActive
  });
  const filteredChildren = useMemo(
    () => hasSelectSearchQuery(searchContext?.filterValue)
      ? filterSelectChildren(children, searchContext?.filterValue)
      : { children, totalItems: 0, matchedItems: 0 },
    [children, searchContext?.filterValue]
  );
  const showEmptySearchState = hasSelectSearchQuery(searchContext?.filterValue)
    && filteredChildren.totalItems > 0
    && filteredChildren.matchedItems === 0;
  const viewportMaxHeight = Math.max(
    0,
    Math.floor(
      (placement.maxHeight || 288) - (searchVisible ? SELECT_SEARCH_HEADER_HEIGHT : 0)
    )
  );

  useEffect(() => {
    if (!searchContext?.open || !searchVisible || typeof window === "undefined") return undefined;
    const frameId = window.requestAnimationFrame(() => {
      const input = searchInputRef.current;
      if (!input) return;
      input.focus();
      const length = input.value.length;
      input.setSelectionRange(length, length);
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [searchContext?.open, searchVisible, searchContext?.openSearchRequest]);

  const setContentNode = useCallback((node) => {
    contentRef.current = node;
    if (typeof ref === "function") {
      ref(node);
      return;
    }
    if (ref) ref.current = node;
  }, [ref]);

  function handleContentKeyDownCapture(event) {
    onKeyDownCapture?.(event);
    if (event.defaultPrevented || event.target === searchInputRef.current || !searchContext?.searchEnabled) return;
    const searchKey = getSelectSearchKey(event);
    if (!searchKey) return;
    event.preventDefault();
    event.stopPropagation();
    searchContext.setSearchSessionActive?.(true);
    searchContext.setFilterValue((current) => `${current}${searchKey}`);
  }

  function handleSearchChange(event) {
    const nextValue = event.target.value;
    searchContext?.setSearchSessionActive?.(true);
    searchContext?.setFilterValue(nextValue);
  }

  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        ref={setContentNode}
        position={position}
        side={position === "popper" ? placement.side : undefined}
        className={cn(
          "z-50 min-w-[8rem] overflow-hidden rounded-xl border border-border/70 bg-popover text-popover-foreground shadow-lg",
          position === "popper" && "data-[side=bottom]:translate-y-1 data-[side=top]:-translate-y-1",
          className
        )}
        onKeyDownCapture={handleContentKeyDownCapture}
        {...props}
      >
        {searchVisible ? (
          <div className="border-b border-border/70 p-1">
            <Input
              ref={searchInputRef}
              data-llm-router-select-search-input="true"
              value={searchContext?.filterValue || ""}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              placeholder={searchPlaceholder}
              className="h-8 border-border/70 bg-background/90"
              onChange={handleSearchChange}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  focusSelectOption(contentRef.current, "first");
                  return;
                }
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  focusSelectOption(contentRef.current, "last");
                  return;
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  searchContext?.setSearchSessionActive?.(false);
                  searchContext?.setFilterValue("");
                  if (typeof window !== "undefined") {
                    window.requestAnimationFrame(() => focusSelectOption(contentRef.current));
                  }
                }
              }}
            />
          </div>
        ) : null}
        <SelectPrimitive.Viewport
          className="px-1 pb-1"
          style={{
            maxHeight: `${viewportMaxHeight}px`
          }}
        >
          {hasSelectSearchQuery(searchContext?.filterValue) ? filteredChildren.children : children}
          {showEmptySearchState ? (
            <div className="px-3 py-2 text-sm text-muted-foreground">{emptySearchMessage}</div>
          ) : null}
        </SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
});

export const SelectItem = forwardRef(function SelectItem({
  className,
  children,
  searchText = "",
  textValue,
  onPointerMove,
  ...props
}, ref) {
  const searchContext = useContext(SelectSearchContext);
  const resolvedTextValue = String(textValue || extractTextFromNode(children) || "").trim();

  function handlePointerMove(event) {
    onPointerMove?.(event);
    if (event.defaultPrevented || !searchContext?.searchEnabled || typeof document === "undefined") return;
    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement && activeElement.getAttribute(SELECT_SEARCH_INPUT_DATA_ATTR) === "true") {
      event.preventDefault();
    }
  }

  return (
    <SelectPrimitive.Item
      ref={ref}
      className={cn(
        "relative flex w-full cursor-default select-none items-center rounded-lg py-2 pl-3 pr-8 text-sm text-foreground outline-none transition-colors hover:bg-accent/60 focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        className
      )}
      textValue={resolvedTextValue}
      onPointerMove={handlePointerMove}
      {...props}
    >
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      <span className="absolute right-2 inline-flex h-4 w-4 items-center justify-center text-xs text-muted-foreground">
        <SelectPrimitive.ItemIndicator>✓</SelectPrimitive.ItemIndicator>
      </span>
    </SelectPrimitive.Item>
  );
});

SelectItem.__LLM_ROUTER_SELECT_ITEM = true;

export function SelectGroup(props) {
  return <SelectPrimitive.Group {...props} />;
}

SelectGroup.__LLM_ROUTER_SELECT_GROUP = true;

export const SelectLabel = forwardRef(function SelectLabel({ className, children, ...props }, ref) {
  return (
    <SelectPrimitive.Label
      ref={ref}
      className={cn(
        "-mt-1 sticky top-0 z-10 -mx-1 mb-1 block border-b border-border/55 bg-background/96 px-4 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-foreground/80 backdrop-blur-sm",
        className
      )}
      {...props}
    >
      {children}
    </SelectPrimitive.Label>
  );
});
