import {
  Children,
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
import { getSelectSearchKey, hasSelectSearchQuery, optionMatchesSelectQuery } from "../../select-search-utils.js";

const SelectSearchContext = createContext(null);
const DEFAULT_SELECT_SEARCH_PLACEHOLDER = "Enter character to filter";

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
    return cloneElement(child, undefined, nested.children);
  });

  return {
    children: filteredChildren,
    totalItems,
    matchedItems
  };
}

export function Select({ open: openProp, defaultOpen = false, onOpenChange, searchEnabled = true, children, ...props }) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(Boolean(defaultOpen));
  const [filterValue, setFilterValue] = useState("");
  const open = openProp !== undefined ? openProp : uncontrolledOpen;

  function handleOpenChange(nextOpen) {
    if (openProp === undefined) setUncontrolledOpen(nextOpen);
    onOpenChange?.(nextOpen);
    if (!nextOpen) setFilterValue("");
  }

  const contextValue = {
    open,
    searchEnabled,
    filterValue,
    setFilterValue,
    setOpen: handleOpenChange
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

  function handleKeyDown(event) {
    onKeyDown?.(event);
    if (event.defaultPrevented || !searchContext?.searchEnabled || props.disabled) return;
    const searchKey = getSelectSearchKey(event);
    if (!searchKey) return;
    event.preventDefault();
    searchContext.setOpen(true);
    searchContext.setFilterValue((current) => `${current}${searchKey}`);
  }

  return (
    <SelectPrimitive.Trigger
      ref={ref}
      className={cn(
        "inline-flex h-9 w-full items-center justify-between gap-2 rounded-lg border border-input bg-background/80 px-3 text-sm text-foreground shadow-sm outline-none transition focus:border-ring focus:ring-2 focus:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      onKeyDown={handleKeyDown}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon className="text-muted-foreground">▾</SelectPrimitive.Icon>
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
  const searchVisible = Boolean(searchContext?.searchEnabled) && hasSelectSearchQuery(searchContext?.filterValue);
  const filteredChildren = useMemo(
    () => searchVisible ? filterSelectChildren(children, searchContext?.filterValue) : { children, totalItems: 0, matchedItems: 0 },
    [children, searchContext?.filterValue, searchVisible]
  );
  const showEmptySearchState = searchVisible
    && filteredChildren.totalItems > 0
    && filteredChildren.matchedItems === 0;

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
  }, [searchContext?.open, searchVisible]);

  function setContentNode(node) {
    contentRef.current = node;
    if (typeof ref === "function") {
      ref(node);
      return;
    }
    if (ref) ref.current = node;
  }

  function handleContentKeyDownCapture(event) {
    onKeyDownCapture?.(event);
    if (event.defaultPrevented || event.target === searchInputRef.current || !searchContext?.searchEnabled) return;
    const searchKey = getSelectSearchKey(event);
    if (!searchKey) return;
    event.preventDefault();
    event.stopPropagation();
    searchContext.setFilterValue((current) => `${current}${searchKey}`);
  }

  function handleSearchChange(event) {
    const nextValue = event.target.value;
    searchContext?.setFilterValue(nextValue);
    if (!hasSelectSearchQuery(nextValue) && typeof window !== "undefined") {
      window.requestAnimationFrame(() => focusSelectOption(contentRef.current));
    }
  }

  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        ref={setContentNode}
        position={position}
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
                  searchContext?.setFilterValue("");
                  if (typeof window !== "undefined") {
                    window.requestAnimationFrame(() => focusSelectOption(contentRef.current));
                  }
                }
              }}
            />
          </div>
        ) : null}
        <SelectPrimitive.Viewport className="max-h-[18rem] p-1">
          {searchVisible ? filteredChildren.children : children}
          {showEmptySearchState ? (
            <div className="px-3 py-2 text-sm text-muted-foreground">{emptySearchMessage}</div>
          ) : null}
        </SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
});

export const SelectItem = forwardRef(function SelectItem({ className, children, searchText = "", textValue, ...props }, ref) {
  const resolvedTextValue = String(textValue || extractTextFromNode(children) || "").trim();
  return (
    <SelectPrimitive.Item
      ref={ref}
      className={cn(
        "relative flex w-full cursor-default select-none items-center rounded-lg py-2 pl-3 pr-8 text-sm text-foreground outline-none transition focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        className
      )}
      textValue={resolvedTextValue}
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
