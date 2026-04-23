export function createLlamacppManagedRuntimeRegistry(deps = {}) {
  const instances = new Map();
  let nextPort = 39391;

  const spawnRuntime = typeof deps.spawnRuntime === "function"
    ? deps.spawnRuntime
    : async ({ host = "127.0.0.1", port } = {}) => ({
      pid: undefined,
      host,
      port,
      baseUrl: `http://${host}:${port}/v1`
    });
  const waitForHealthy = typeof deps.waitForHealthy === "function"
    ? deps.waitForHealthy
    : async (instance) => ({ ...instance, healthy: true });
  const listListeningPids = typeof deps.listListeningPids === "function"
    ? deps.listListeningPids
    : async () => [];
  const stopProcessByPid = typeof deps.stopProcessByPid === "function"
    ? deps.stopProcessByPid
    : async () => {};

  async function ensureRuntimeForVariant({ variantKey, profileHash, launchArgs, preferredPort } = {}) {
    for (const instance of instances.values()) {
      if (instance.profileHash === profileHash && instance.variantKey === variantKey && instance.healthy === true) {
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

  async function reconcile() {
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
    snapshot: () => [...instances.values()]
  };
}
