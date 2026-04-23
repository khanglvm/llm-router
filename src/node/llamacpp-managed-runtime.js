export function createLlamacppManagedRuntimeRegistry(deps = {}) {
  const instances = new Map();
  let nextPort = 39391;

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

  async function ensureRuntimeForVariant({ variantKey, profileHash, launchArgs, preferredPort } = {}, runtimeDeps = {}) {
    const spawnRuntime = resolveSpawnRuntime(runtimeDeps);
    const waitForHealthy = resolveWaitForHealthy(runtimeDeps);
    for (const instance of instances.values()) {
      if (
        instance.profileHash === profileHash
        && instance.variantKey === variantKey
        && isTrackedInstanceReusable(instance)
      ) {
        return instance;
      }
    }

    const parsedPort = Number(preferredPort);
    const port = Number.isInteger(parsedPort) ? parsedPort : nextPort++;
    const spawned = await spawnRuntime({ variantKey, profileHash, launchArgs, port });
    const healthy = await waitForHealthy(spawned);
    const instance = {
      instanceId: `${variantKey}:${profileHash}:${port}`,
      owner: "llm-router",
      variantKey,
      profileHash,
      healthy: true,
      ...healthy
    };
    instances.set(instance.instanceId, instance);
    return instance;
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

  return {
    ensureRuntimeForVariant,
    reconcile,
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
