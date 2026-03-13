function normalizeSelectSearchText(value) {
  return String(value || "").trim().toLowerCase();
}

export function hasSelectSearchQuery(value) {
  return normalizeSelectSearchText(value).length > 0;
}

export function shouldShowSelectSearchInput({
  searchEnabled = true,
} = {}) {
  return Boolean(searchEnabled);
}

export function getSelectSearchKey(event) {
  const key = String(event?.key || "");
  if (!key || key.length !== 1) return "";
  if (event?.ctrlKey || event?.metaKey || event?.altKey) return "";
  return key.trim() ? key : "";
}

export function optionMatchesSelectQuery(option = {}, query = "") {
  const normalizedQuery = normalizeSelectSearchText(query);
  if (!normalizedQuery) return true;

  const haystack = [
    option?.label,
    option?.value,
    option?.hint,
    option?.textValue,
    option?.searchText
  ]
    .map((entry) => String(entry || "").toLowerCase())
    .join(" ");

  return haystack.includes(normalizedQuery);
}

export function filterSelectOptions(options = [], query = "") {
  const normalizedOptions = Array.isArray(options) ? options : [];
  return normalizedOptions.filter((option) => optionMatchesSelectQuery(option, query));
}
