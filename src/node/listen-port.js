import { FIXED_LOCAL_ROUTER_PORT } from "./local-server-settings.js";

const DEFAULT_LISTEN_PORT = FIXED_LOCAL_ROUTER_PORT;

/**
 * Resolve the local router listen port.
 * The router port is currently fixed and user overrides are ignored.
 */
export function resolveListenPort() {
  return DEFAULT_LISTEN_PORT;
}
