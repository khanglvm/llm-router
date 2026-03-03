import { buildTimeoutSignal } from "../shared/timeout-signal.js";

const CLOUDFLARE_API_BASE_URL = "https://api.cloudflare.com/client/v4";
const CLOUDFLARE_VERIFY_TOKEN_URL = `${CLOUDFLARE_API_BASE_URL}/user/tokens/verify`;
const CLOUDFLARE_MEMBERSHIPS_URL = `${CLOUDFLARE_API_BASE_URL}/memberships`;
const CLOUDFLARE_ZONES_URL = `${CLOUDFLARE_API_BASE_URL}/zones`;
const CLOUDFLARE_API_PREFLIGHT_TIMEOUT_MS = 10_000;

export const CLOUDFLARE_API_TOKEN_ENV_NAME = "CLOUDFLARE_API_TOKEN";
export const CLOUDFLARE_API_TOKEN_ALT_ENV_NAME = "CF_API_TOKEN";
export const CLOUDFLARE_ACCOUNT_ID_ENV_NAME = "CLOUDFLARE_ACCOUNT_ID";
const CLOUDFLARE_API_TOKEN_PRESET_NAME = "Edit Cloudflare Workers";
const CLOUDFLARE_API_TOKEN_DASHBOARD_URL = "https://dash.cloudflare.com/profile/api-tokens";
const CLOUDFLARE_API_TOKEN_GUIDE_URL = "https://developers.cloudflare.com/fundamentals/api/get-started/create-token/";

function parseJsonSafely(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function resolveCloudflareApiTokenFromEnv(env = process.env) {
  const primary = String(env?.[CLOUDFLARE_API_TOKEN_ENV_NAME] || "").trim();
  if (primary) {
    return {
      token: primary,
      source: CLOUDFLARE_API_TOKEN_ENV_NAME
    };
  }

  const fallback = String(env?.[CLOUDFLARE_API_TOKEN_ALT_ENV_NAME] || "").trim();
  if (fallback) {
    return {
      token: fallback,
      source: CLOUDFLARE_API_TOKEN_ALT_ENV_NAME
    };
  }

  return {
    token: "",
    source: "none"
  };
}

export function buildCloudflareApiTokenSetupGuide() {
  return [
    `Cloudflare deploy requires ${CLOUDFLARE_API_TOKEN_ENV_NAME}.`,
    `Create a User Profile API token in dashboard: ${CLOUDFLARE_API_TOKEN_DASHBOARD_URL}`,
    "Do not use Account API Tokens for this deploy flow.",
    `Token docs: ${CLOUDFLARE_API_TOKEN_GUIDE_URL}`,
    `Recommended preset: ${CLOUDFLARE_API_TOKEN_PRESET_NAME}.`,
    `Then set ${CLOUDFLARE_API_TOKEN_ENV_NAME} in your shell/CI environment.`
  ].join("\n");
}

export function validateCloudflareApiTokenInput(value) {
  const candidate = String(value || "").trim();
  if (!candidate) return `${CLOUDFLARE_API_TOKEN_ENV_NAME} is required for deploy.`;
  return undefined;
}

export function buildCloudflareApiTokenTroubleshooting(preflightMessage = "") {
  return [
    preflightMessage,
    "Required token capabilities for wrangler deploy:",
    "- User details: Read",
    "- User memberships: Read",
    `- Account preset/template: ${CLOUDFLARE_API_TOKEN_PRESET_NAME}`,
    `Verify token manually: curl "${CLOUDFLARE_VERIFY_TOKEN_URL}" -H "Authorization: Bearer $${CLOUDFLARE_API_TOKEN_ENV_NAME}"`,
    buildCloudflareApiTokenSetupGuide()
  ].filter(Boolean).join("\n");
}

function normalizeCloudflareMembershipAccount(entry) {
  if (!entry || typeof entry !== "object") return null;
  const accountObj = entry.account && typeof entry.account === "object" ? entry.account : {};
  const accountId = String(
    accountObj.id
    || entry.account_id
    || entry.accountId
    || entry.id
    || ""
  ).trim();
  if (!accountId) return null;

  const accountName = String(
    accountObj.name
    || entry.account_name
    || entry.accountName
    || entry.name
    || `Account ${accountId.slice(0, 8)}`
  ).trim();

  return {
    accountId,
    accountName: accountName || `Account ${accountId.slice(0, 8)}`
  };
}

export function extractCloudflareMembershipAccounts(payload) {
  const list = Array.isArray(payload?.result) ? payload.result : [];
  const map = new Map();
  for (const entry of list) {
    const normalized = normalizeCloudflareMembershipAccount(entry);
    if (!normalized) continue;
    if (!map.has(normalized.accountId)) {
      map.set(normalized.accountId, normalized);
    }
  }
  return Array.from(map.values());
}

function cloudflareErrorFromPayload(payload, fallback) {
  const base = String(fallback || "Unknown Cloudflare API error");
  if (!payload || typeof payload !== "object") return base;

  const errors = Array.isArray(payload.errors) ? payload.errors : [];
  const first = errors.find((entry) => entry && typeof entry === "object");
  if (!first) return base;

  const code = Number.isFinite(first.code) ? `code ${first.code}` : "";
  const message = String(first.message || first.error || "").trim();
  if (code && message) return `${message} (${code})`;
  if (message) return message;
  if (code) return code;
  return base;
}

export function evaluateCloudflareTokenVerifyResult(payload) {
  const status = String(payload?.result?.status || "").toLowerCase();
  const active = payload?.success === true && status === "active";
  if (active) {
    return { ok: true, message: "Token is active." };
  }
  return {
    ok: false,
    message: cloudflareErrorFromPayload(
      payload,
      "Token verification failed. Ensure token is valid and active."
    )
  };
}

export function evaluateCloudflareMembershipsResult(payload) {
  if (payload?.success !== true || !Array.isArray(payload?.result)) {
    return {
      ok: false,
      message: cloudflareErrorFromPayload(
        payload,
        "Could not list Cloudflare memberships for this token."
      )
    };
  }

  if (payload.result.length === 0) {
    return {
      ok: false,
      message: "Token can authenticate but has no accessible memberships."
    };
  }

  const accounts = extractCloudflareMembershipAccounts(payload);
  return {
    ok: true,
    message: `Token has access to ${payload.result.length} membership(s).`,
    count: payload.result.length,
    accounts
  };
}

async function cloudflareApiGetJson(url, token) {
  const timeoutControl = buildTimeoutSignal(CLOUDFLARE_API_PREFLIGHT_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`
      },
      signal: timeoutControl.signal
    });
    const rawText = await response.text();
    const payload = parseJsonSafely(rawText) || {};
    return {
      ok: response.ok,
      status: response.status,
      payload
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      payload: null,
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    timeoutControl.cleanup();
  }
}

export async function preflightCloudflareApiToken(token) {
  const verified = await cloudflareApiGetJson(CLOUDFLARE_VERIFY_TOKEN_URL, token);
  if (verified.status === 0) {
    return {
      ok: false,
      stage: "verify",
      message: `Cloudflare token preflight failed while verifying token: ${verified.error || "network error"}`
    };
  }

  const verifyEval = evaluateCloudflareTokenVerifyResult(verified.payload);
  if (!verified.ok || !verifyEval.ok) {
    return {
      ok: false,
      stage: "verify",
      message: `Cloudflare token verification failed: ${verifyEval.message}`
    };
  }

  const memberships = await cloudflareApiGetJson(CLOUDFLARE_MEMBERSHIPS_URL, token);
  if (memberships.status === 0) {
    return {
      ok: false,
      stage: "memberships",
      message: `Cloudflare token preflight failed while checking memberships: ${memberships.error || "network error"}`
    };
  }

  const membershipEval = evaluateCloudflareMembershipsResult(memberships.payload);
  if (!memberships.ok || !membershipEval.ok) {
    return {
      ok: false,
      stage: "memberships",
      message: `Cloudflare memberships check failed: ${membershipEval.message}`
    };
  }

  return {
    ok: true,
    stage: "ready",
    message: membershipEval.message,
    memberships: membershipEval.accounts || []
  };
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

export async function cloudflareListZones(token, accountId = "") {
  const params = new URLSearchParams({ per_page: "50" });
  if (accountId) params.set("account.id", accountId);
  const result = await cloudflareApiGetJson(`${CLOUDFLARE_ZONES_URL}?${params.toString()}`, token);
  if (!result.ok || !Array.isArray(result.payload?.result)) return [];
  return result.payload.result
    .map((zone) => ({ id: String(zone?.id || "").trim(), name: normalizeHostname(zone?.name || "") }))
    .filter((zone) => zone.id && zone.name);
}
