import type {
  NetInfoState,
  NetInfoSubscription,
} from "@react-native-community/netinfo";

type NetInfoOptions = {
  enabled: boolean;
  setOnline: (online: boolean) => void;
  log: (event: string, details?: Record<string, unknown>) => void;
};

type NetInfoMonitor = {
  ensureOnline: (currentOnline: boolean) => Promise<boolean>;
  dispose: () => void;
};

type NetInfoModule = {
  addEventListener: (
    listener: (state: NetInfoState) => void
  ) => NetInfoSubscription | (() => void);
  fetch?: () => Promise<NetInfoState>;
};

// NetInfo integration for auto-detecting connectivity changes.
export async function createNetInfoMonitor(
  options: NetInfoOptions
): Promise<NetInfoMonitor> {
  const { enabled, setOnline, log } = options;

  if (!enabled) {
    return { ensureOnline: async (current) => current, dispose: () => {} };
  }

  const instance = await loadNetInfo(log);
  if (!instance) {
    return { ensureOnline: async (current) => current, dispose: () => {} };
  }

  if (instance.fetch) {
    try {
      const state = await instance.fetch();
      updateOnlineFromState(state, setOnline, log);
    } catch {
      // Ignore fetch failures; listener will still update when possible.
    }
  }

  const unsubscribe = instance.addEventListener((state) => {
    updateOnlineFromState(state, setOnline, log);
  });

  const dispose = () => {
    if (typeof unsubscribe === "function") {
      unsubscribe();
      return;
    }
    unsubscribe?.remove?.();
  };

  const ensureOnline = async (currentOnline: boolean) => {
    if (!instance.fetch) {
      return currentOnline;
    }

    try {
      const state = await instance.fetch();
      if (typeof state.isInternetReachable === "boolean") {
        setOnline(state.isInternetReachable);
        return state.isInternetReachable;
      }
      if (state.isConnected === false) {
        setOnline(false);
        return false;
      }
    } catch {
      return currentOnline;
    }

    return currentOnline;
  };

  return { ensureOnline, dispose };
}

async function loadNetInfo(
  log: NetInfoOptions["log"]
): Promise<NetInfoModule | undefined> {
  try {
    const module = await import("@react-native-community/netinfo");
    const candidate = module.default ?? module;
    if (candidate && typeof candidate.addEventListener === "function") {
      return candidate as NetInfoModule;
    }
  } catch (error) {
    log("netinfo:disabled", {
      reason: "netinfo-unavailable",
      message: error instanceof Error ? error.message : String(error),
    });
  }

  return undefined;
}

function updateOnlineFromState(
  state: NetInfoState,
  setOnline: (online: boolean) => void,
  log: (event: string, details?: Record<string, unknown>) => void
) {
  if (typeof state.isInternetReachable === "boolean") {
    log("netinfo", { online: state.isInternetReachable, source: "reachable" });
    setOnline(state.isInternetReachable);
    return;
  }

  if (state.isConnected === false) {
    log("netinfo", { online: false, source: "connected:false" });
    setOnline(false);
  }
}
