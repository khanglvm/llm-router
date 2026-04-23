export function createLlamacppManagedRuntimeRegistry(deps = {}) {
  const instances = new Map();
  const inFlightStarts = new Map();
  let nextPort = 39391;
  const MIN_PORT = 1;
  const MAX_PORT = 65535;

  function resolveSpawnRuntime(overrides = {}) {
    if (typeof overrides.spawnRuntime === "function") return overrides.spawnRuntime;
    if (typeof deps.spawnRuntime === "function") return deps.spawnRuntime;
    return async ({ host = "127.0.0.1", port } = {}) => ({
      pid: undefined,
      host,
      port,
      baseUrl: `http://${host}:${port}/v1`
    });
  }

  function resolveWaitForHealthy(overrides = {}) {
    if (typeof overrides.waitForHealthy === "function") return overrides.waitForHealthy;
    if (typeof deps.waitForHealthy === "function") return deps.waitForHealthy;
    return async (instance) => ({ ...instance, healthy: true });
  }

  function resolveListListeningPids(overrides = {}) {
    if (typeof overrides.listListeningPids === "function") return overrides.listListeningPids;
    if (typeof deps.listListeningPids === "function") return deps.listListeningPids;
    return async () => [];
  }

  function resolveStopProcessByPid(overrides = {}) {
    if (typeof overrides.stopProcessByPid === "function") return overrides.stopProcessByPid;
    if (typeof deps.stopProcessByPid === "function") return deps.stopProcessByPid;
    return async () => {};
  }

  function isTrackedInstanceReusable(instance) {
    if (instance?.healthy !== true) return false;
    const child = instance?.child;
    if (child) {
      return child.exitCode === null && child.killed !== true;
    }
    return true;
  }

  function isChildAlive(child) {
    if (!child) return true;
    return child.exitCode === null && child.killed !== true;
  }

  function normalizeRuntimePort(value, fallback = null) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < MIN_PORT || parsed > MAX_PORT) return fallback;
    return parsed;
  }

  function buildCompatibilityKey(variantKey, profileHash) {
    return `${String(variantKey || "")}::${String(profileHash || "")}`;
  }

  function buildReservedPorts() {
    const reserved = new Set();
    for (const instance of instances.values()) {
      if (!isChildAlive(instance?.child)) continue;
      const port = normalizeRuntimePort(instance?.port);
      if (port !== null) reserved.add(port);
    }
    for (const start of inFlightStarts.values()) {
      const port = normalizeRuntimePort(start?.reservedPort);
      if (port !== null) reserved.add(port);
    }
    return reserved;
  }

  function pruneDeadInstances() {
    for (const [instanceId, instance] of instances.entries()) {
      if (!isChildAlive(instance?.child)) {
        instances.delete(instanceId);
      }
    }
  }

  function allocatePort(preferredPort) {
    const reservedPorts = buildReservedPorts();
    const preferred = normalizeRuntimePort(preferredPort);
    if (preferred !== null && !reservedPorts.has(preferred)) {
      if (preferred >= nextPort) nextPort = preferred + 1;
      return preferred;
    }

    let port = Math.max(39391, nextPort);
    while (reservedPorts.has(port)) {
      port += 1;
    }
    nextPort = port + 1;
    return port;
  }

  async function ensureRuntimeForVariant({ variantKey, profileHash, launchArgs, preferredPort } = {}, runtimeDeps = {}) {
    const spawnRuntime = resolveSpawnRuntime(runtimeDeps);
    const waitForHealthy = resolveWaitForHealthy(runtimeDeps);
    const compatibilityKey = buildCompatibilityKey(variantKey, profileHash);
    pruneDeadInstances();

    for (const instance of instances.values()) {
      if (
        instance.profileHash === profileHash
        && instance.variantKey === variantKey
        && isTrackedInstanceReusable(instance)
      ) {
        return instance;
      }
    }

    const inFlight = inFlightStarts.get(compatibilityKey);
    if (inFlight?.promise) {
      return inFlight.promise;
    }

    const port = allocatePort(preferredPort);
    const startPromise = (async () => {
      const spawned = await spawnRuntime({ variantKey, profileHash, launchArgs, port });
      const healthy = await waitForHealthy(spawned);
      const assignedPort = normalizeRuntimePort(healthy?.port, port);
      if (!isChildAlive(healthy?.child)) {
        throw new Error("Managed runtime exited before becoming healthy.");
      }
      const instance = {
        instanceId: `${variantKey}:${profileHash}:${assignedPort}`,
        owner: "llm-router",
        variantKey,
        profileHash,
        healthy: true,
        ...healthy,
        port: assignedPort
      };
      instances.set(instance.instanceId, instance);
      return instance;
    })().finally(() => {
      inFlightStarts.delete(compatibilityKey);
    });

    inFlightStarts.set(compatibilityKey, { promise: startPromise, reservedPort: port });
    return startPromise;
  }

  async function reconcile(runtimeDeps = {}) {
    const listListeningPids = resolveListListeningPids(runtimeDeps);
    const stopProcessByPid = resolveStopProcessByPid(runtimeDeps);
    for (const [instanceId, instance] of instances.entries()) {
      const livePids = await listListeningPids(instance.port).catch(() => []);
      if (Array.isArray(livePids) && livePids.includes(instance.pid)) continue;
      if (instance.owner === "llm-router") {
        await stopProcessByPid(instance.pid).catch(() => {});
      }
      instances.delete(instanceId);
    }
  }

  async function waitForInFlightStarts() {
    while (inFlightStarts.size > 0) {
      const pending = [...inFlightStarts.values()]
        .map((entry) => entry?.promise)
        .filter(Boolean)
        .map((promise) => promise.catch(() => null));
      if (pending.length === 0) return;
      await Promise.all(pending);
    }
  }

  return {
    ensureRuntimeForVariant,
    reconcile,
    waitForInFlightStarts,
    trackInstance: async (instance) => {
      instances.set(instance.instanceId, { ...instance });
    },
    untrackInstance: async (instanceId) => {
      instances.delete(instanceId);
    },
    clear: async () => {
      instances.clear();
    },
    snapshot: () => [...instances.values()]
  };
}
