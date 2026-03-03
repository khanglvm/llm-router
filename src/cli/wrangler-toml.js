export function hasNoDeployTargets(outputText = "") {
  return /no deploy targets/i.test(String(outputText || ""));
}

export function parseTomlStringField(text, key) {
  const pattern = new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']\\s*$`, "m");
  const match = String(text || "").match(pattern);
  return match?.[1] ? String(match[1]).trim() : "";
}

function topLevelTomlLineInfo(text = "") {
  const lines = String(text || "").split(/\r?\n/g);
  const info = [];
  let currentSection = "";

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (/^\s*\[.*\]\s*$/.test(line)) {
      currentSection = trimmed;
    }
    info.push({
      index,
      line,
      trimmed,
      section: currentSection
    });
  }

  return info;
}

export function hasWranglerDeployTargetConfigured(tomlText = "") {
  const info = topLevelTomlLineInfo(tomlText);

  const hasTopLevelWorkersDev = info.some((entry) =>
    entry.section === "" && /^\s*workers_dev\s*=\s*true\s*$/i.test(entry.line)
  );
  if (hasTopLevelWorkersDev) return true;

  const hasTopLevelRoute = info.some((entry) =>
    entry.section === "" && /^\s*route\s*=\s*["'][^"']+["']\s*$/i.test(entry.line)
  );
  if (hasTopLevelRoute) return true;

  const hasTopLevelRoutes = info.some((entry) =>
    entry.section === "" && /^\s*routes\s*=\s*\[/i.test(entry.line)
  );
  if (hasTopLevelRoutes) return true;

  return false;
}

function stripNonTopLevelRouteDeclarations(text = "") {
  const lines = String(text || "").split(/\r?\n/g);
  const output = [];
  let currentSection = "";
  let skippingRoutesArray = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (/^\s*\[.*\]\s*$/.test(line)) {
      currentSection = trimmed;
      skippingRoutesArray = false;
      output.push(line);
      continue;
    }

    if (currentSection && /^\s*route\s*=/.test(line)) {
      continue;
    }

    if (currentSection && /^\s*routes\s*=\s*\[/.test(line)) {
      skippingRoutesArray = true;
      if (line.includes("]")) {
        skippingRoutesArray = false;
      }
      continue;
    }

    if (skippingRoutesArray) {
      if (trimmed.includes("]")) {
        skippingRoutesArray = false;
      }
      continue;
    }

    output.push(line);
  }

  return output.join("\n");
}

function insertTopLevelBlockBeforeFirstSection(text = "", block = "") {
  const source = String(text || "");
  const blockText = String(block || "").trim();
  if (!blockText) return source;

  const lines = source.split(/\r?\n/g);
  const firstSectionIndex = lines.findIndex((line) => /^\s*\[.*\]\s*$/.test(line));
  if (firstSectionIndex < 0) {
    const prefix = source.trimEnd();
    return `${prefix}${prefix ? "\n" : ""}${blockText}\n`;
  }

  const before = lines.slice(0, firstSectionIndex).join("\n").trimEnd();
  const after = lines.slice(firstSectionIndex).join("\n").trimStart();
  return `${before}${before ? "\n" : ""}${blockText}\n\n${after}\n`;
}

function upsertTomlBooleanField(text, key, value) {
  const normalized = String(text || "");
  const replacement = `${key} = ${value ? "true" : "false"}`;
  if (new RegExp(`^\\s*${key}\\s*=`, "m").test(normalized)) {
    return normalized.replace(new RegExp(`^\\s*${key}\\s*=.*$`, "m"), replacement);
  }
  return `${normalized.trimEnd()}\n${replacement}\n`;
}

function stripTopLevelRouteDeclarations(text = "") {
  const lines = String(text || "").split(/\r?\n/g);
  const output = [];
  let currentSection = "";
  let skippingRoutesArray = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (/^\s*\[.*\]\s*$/.test(line)) {
      currentSection = trimmed;
      skippingRoutesArray = false;
      output.push(line);
      continue;
    }

    if (!currentSection && /^\s*route\s*=/.test(line)) {
      continue;
    }

    if (!currentSection && /^\s*routes\s*=\s*\[/.test(line)) {
      skippingRoutesArray = true;
      if (line.includes("]")) {
        skippingRoutesArray = false;
      }
      continue;
    }

    if (skippingRoutesArray) {
      if (trimmed.includes("]")) {
        skippingRoutesArray = false;
      }
      continue;
    }

    output.push(line);
  }

  return output.join("\n");
}

export function normalizeWranglerRoutePattern(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  let candidate = raw;
  if (/^https?:\/\//i.test(candidate)) {
    try {
      const parsed = new URL(candidate);
      candidate = `${parsed.hostname}${parsed.pathname || "/"}`;
    } catch {
      return "";
    }
  }

  if (candidate.startsWith("/")) return "";
  if (!candidate.includes("*")) {
    if (candidate.endsWith("/")) candidate = `${candidate}*`;
    else if (!candidate.includes("/")) candidate = `${candidate}/*`;
  }

  return candidate;
}

export function buildDefaultWranglerTomlForDeploy({
  name = "llm-router-route",
  main = "src/index.js",
  compatibilityDate = "2024-01-01",
  useWorkersDev = false,
  routePattern = "",
  zoneName = ""
} = {}) {
  const lines = [
    `name = "${String(name || "llm-router-route")}"`,
    `main = "${String(main || "src/index.js")}"`,
    `compatibility_date = "${String(compatibilityDate || "2024-01-01")}"`,
    `workers_dev = ${useWorkersDev ? "true" : "false"}`
  ];

  const normalizedPattern = normalizeWranglerRoutePattern(routePattern);
  const normalizedZone = String(zoneName || "").trim();
  if (!useWorkersDev && normalizedPattern && normalizedZone) {
    lines.push("routes = [");
    lines.push(`  { pattern = "${normalizedPattern}", zone_name = "${normalizedZone}" }`);
    lines.push("]");
  }

  lines.push("preview_urls = false");
  lines.push("");
  lines.push("[vars]");
  lines.push('ENVIRONMENT = "production"');
  lines.push("");
  return `${lines.join("\n")}`;
}

export function applyWranglerDeployTargetToToml(existingToml, {
  useWorkersDev = false,
  routePattern = "",
  zoneName = "",
  replaceExistingTarget = false
} = {}) {
  let next = String(existingToml || "");
  next = stripNonTopLevelRouteDeclarations(next);
  if (replaceExistingTarget) {
    next = stripTopLevelRouteDeclarations(next);
  }
  next = upsertTomlBooleanField(next, "workers_dev", useWorkersDev);

  if (!useWorkersDev) {
    const normalizedPattern = normalizeWranglerRoutePattern(routePattern);
    const normalizedZone = String(zoneName || "").trim();
    if (normalizedPattern && normalizedZone && (replaceExistingTarget || !hasWranglerDeployTargetConfigured(next))) {
      const routeBlock = `routes = [\n  { pattern = "${normalizedPattern}", zone_name = "${normalizedZone}" }\n]`;
      next = insertTopLevelBlockBeforeFirstSection(next, routeBlock);
    }
  }

  if (!/^\s*preview_urls\s*=/mi.test(next)) {
    next = `${next.trimEnd()}\npreview_urls = false\n`;
  }

  return `${next.trimEnd()}\n`;
}

function normalizeHostname(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/:\d+$/, "")
    .replace(/\.$/, "");
}

export function extractHostnameFromRoutePattern(value) {
  const route = String(value || "").trim();
  if (!route) return "";

  if (/^https?:\/\//i.test(route)) {
    try {
      return normalizeHostname(new URL(route).hostname);
    } catch {
      return "";
    }
  }

  const left = route.split("/")[0] || "";
  return normalizeHostname(left.replace(/\*+$/g, ""));
}

export function inferZoneNameFromHostname(hostname) {
  const host = normalizeHostname(hostname);
  if (!host || !host.includes(".")) return "";
  const labels = host.split(".").filter(Boolean);
  if (labels.length <= 2) return host;
  return labels.slice(-2).join(".");
}

export function isHostnameUnderZone(hostname, zoneName) {
  const host = normalizeHostname(hostname);
  const zone = normalizeHostname(zoneName);
  if (!host || !zone) return false;
  return host === zone || host.endsWith(`.${zone}`);
}

export function suggestZoneNameForHostname(hostname, zones = []) {
  const host = normalizeHostname(hostname);
  if (!host) return "";

  let best = "";
  for (const zone of zones || []) {
    const candidate = normalizeHostname(zone?.name || zone);
    if (!candidate) continue;
    if (host === candidate || host.endsWith(`.${candidate}`)) {
      if (!best || candidate.length > best.length) {
        best = candidate;
      }
    }
  }
  return best;
}

export function buildCloudflareDnsManualGuide({
  hostname = "",
  zoneName = "",
  routePattern = ""
} = {}) {
  const host = normalizeHostname(hostname || extractHostnameFromRoutePattern(routePattern));
  const zone = normalizeHostname(zoneName || inferZoneNameFromHostname(host));
  const subdomain = host && zone && host.endsWith(`.${zone}`)
    ? host.slice(0, -(`.${zone}`).length)
    : "";
  const label = subdomain || "<subdomain>";

  return [
    "Custom domain checklist:",
    `- Route target: ${routePattern || `${host || "<host>"}/*`} (zone: ${zone || "<zone>"})`,
    `- DNS: create/update CNAME \`${label}\` -> \`@\` in zone \`${zone || "<zone>"}\``,
    "- Proxy status must be ON (orange cloud / proxied)",
    host ? `- Verify DNS: dig +short ${host} @1.1.1.1` : "- Verify DNS: dig +short <host> @1.1.1.1",
    host ? `- Verify HTTP: curl -I https://${host}/anthropic` : "- Verify HTTP: curl -I https://<host>/anthropic",
    "- Claude base URL must NOT include :8787 for Cloudflare Worker deployments"
  ].join("\n");
}
