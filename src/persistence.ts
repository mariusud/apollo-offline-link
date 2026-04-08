import type AsyncStorageStatic from "@react-native-async-storage/async-storage";
import type { SerializedOperation } from "./OfflineQueueLink";

type PersistenceOptions = {
  enabled: boolean;
  storageKey: string;
  log: (event: string, details?: Record<string, unknown>) => void;
  isSerializedOperation: (value: unknown) => value is SerializedOperation;
};

type StoredQueueItem = {
  id: string;
  addedAt: number;
  operation: SerializedOperation;
};

type QueuePersistence = {
  hydrateQueue: () => Promise<StoredQueueItem[]>;
  persistQueue: (
    queue: Array<{ id: string; addedAt: number; serialized: SerializedOperation }>
  ) => Promise<void>;
};

// Queue persistence powered by AsyncStorage. No-op when disabled or unavailable.
export function createQueuePersistence(options: PersistenceOptions): QueuePersistence {
  const { enabled, storageKey, log, isSerializedOperation } = options;
  let storage: AsyncStorageStatic | undefined;

  const hydrateQueue = async () => {
    if (!enabled) {
      return [];
    }

    storage = await loadAsyncStorage();
    if (!storage) {
      return [];
    }

    const raw = await storage.getItem(storageKey);
    if (!raw) {
      return [];
    }

    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        throw new Error("Invalid queue payload");
      }

      const items: StoredQueueItem[] = [];
      for (const entry of parsed) {
        if (!isStoredQueueItem(entry, isSerializedOperation)) {
          throw new Error("Invalid queue payload");
        }
        items.push(entry);
      }
      return items;
    } catch {
      await storage.removeItem?.(storageKey);
      return [];
    }
  };

  const persistQueue = async (
    queue: Array<{ id: string; addedAt: number; serialized: SerializedOperation }>
  ) => {
    if (!storage) {
      return;
    }

    const stored = queue.map((item) => ({
      id: item.id,
      addedAt: item.addedAt,
      operation: item.serialized,
    }));

    if (stored.length === 0) {
      await storage.removeItem?.(storageKey);
      return;
    }

    await storage.setItem(storageKey, JSON.stringify(stored));
  };

  return { hydrateQueue, persistQueue };

  async function loadAsyncStorage() {
    try {
      const module = await import("@react-native-async-storage/async-storage");
      const candidate = module.default ?? module;

      if (!isAsyncStorage(candidate)) {
        throw new Error(
          "AsyncStorage is not available. Install @react-native-async-storage/async-storage."
        );
      }

      return candidate;
    } catch (error) {
      log("persist:disabled", {
        reason: "async-storage-unavailable",
        message: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }
}

function isAsyncStorage(value: unknown): value is AsyncStorageStatic {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as { getItem?: unknown; setItem?: unknown };
  return (
    typeof candidate.getItem === "function" &&
    typeof candidate.setItem === "function"
  );
}

function isStoredQueueItem(
  value: unknown,
  isSerializedOperation: (value: unknown) => value is SerializedOperation
): value is StoredQueueItem {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const entry = value as { id?: unknown; addedAt?: unknown; operation?: unknown };
  return (
    typeof entry.id === "string" &&
    typeof entry.addedAt === "number" &&
    isSerializedOperation(entry.operation)
  );
}
