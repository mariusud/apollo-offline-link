import { FetchResult, Observable, gql } from "@apollo/client";
import { getMainDefinition } from "@apollo/client/utilities";
import type { RequestHandler } from "@apollo/client/link/core";
import { print } from "graphql";

export type SerializedOperation = {
  query: string;
  variables?: Record<string, unknown>;
  operationName?: string;
  extensions?: Record<string, unknown>;
};

type OperationLike = {
  query: unknown;
  variables?: Record<string, unknown>;
  operationName?: string;
  extensions?: Record<string, unknown>;
  setContext: (next: unknown) => void;
  getContext: () => Record<string, unknown>;
  client?: unknown;
  [key: string]: unknown;
};

type NetInfoState = {
  isConnected?: boolean | null;
  isInternetReachable?: boolean | null;
};

type NetInfoLike = {
  addEventListener: (
    listener: (state: NetInfoState) => void
  ) => (() => void) | { remove?: () => void };
  fetch?: () => Promise<NetInfoState>;
};

type AsyncStorageLike = {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
  removeItem?: (key: string) => Promise<void>;
};

type StoredQueueItem = {
  id: string;
  addedAt: number;
  operation: SerializedOperation;
};

type LinkObserver = {
  next?: (value: FetchResult) => void;
  error?: (error: unknown) => void;
  complete?: () => void;
};

type QueueItem = {
  id: string;
  addedAt: number;
  operation: OperationLike | SerializedOperation;
  observer?: LinkObserver;
  serialized: SerializedOperation;
};

export type OfflineQueueLinkOptions = {
  persist?: boolean;
  queueMutationsOnly?: boolean;
  queueOperations?: string[];
  initialOnline?: boolean;
  autoDetectOnline?: boolean;
  logging?: boolean;
  replayLogging?: boolean;
};

export type OfflineQueueLink = RequestHandler & {
  setOnline: (online: boolean) => void;
  isOnline: () => boolean;
  getQueueLength: () => number;
  flushQueue: () => Promise<void>;
  dispose: () => void;
};

const DEFAULT_STORAGE_KEY = "apollo-offline-queue";

type ForwardFunction = (operation: OperationLike) => Observable<FetchResult>;

export const createOfflineQueueLink = (
  options: OfflineQueueLinkOptions = {}
): OfflineQueueLink => {
  let storage: AsyncStorageLike | undefined;
  const storageKey = DEFAULT_STORAGE_KEY;
  const {
    persist = false,
    queueMutationsOnly = true,
    queueOperations,
    autoDetectOnline = true,
    initialOnline,
    logging = false,
    replayLogging = true,
  } = options;

  let online = initialOnline ?? (autoDetectOnline ? false : true);

  let queue: QueueItem[] = [];
  let forwardFn: ForwardFunction | undefined;
  let lastClient: unknown;
  let initError: Error | undefined;
  let netInfoUnsubscribe: (() => void) | undefined;
  let netInfoInstance: NetInfoLike | undefined;
  let flushing = false;
  let idCounter = 0;

  const readyPromise = initialize().catch((error) => {
    initError = error instanceof Error ? error : new Error(String(error));
  });

  const setOnline = (nextOnline: boolean) => {
    online = nextOnline;
    log("setOnline", { online: nextOnline });
    if (nextOnline) {
      void flushQueue();
    }
  };

  const isOnline = () => online;

  const getQueueLength = () => queue.length;

  const dispose = () => {
    netInfoUnsubscribe?.();
    netInfoUnsubscribe = undefined;
  };

  const flushQueue = async () => {
    await readyPromise;
    if (initError) {
      return;
    }
    if (!forwardFn || !online || flushing) {
      return;
    }

    flushing = true;
    try {
      log("flush:start", { size: queue.length });
      while (queue.length > 0 && online) {
        const item = queue[0];
        const operation = getOperationForItem(item);
        const result = await executeOperation(operation, item.observer);

        if (result.success) {
          queue.shift();
          await persistQueue();
          continue;
        }

        if (result.isNetworkError) {
          log("flush:paused", { reason: "network-error" });
          break;
        }

        queue.shift();
        await persistQueue();
      }
      log("flush:done", { size: queue.length });
    } finally {
      flushing = false;
    }
  };

  const handler: OfflineQueueLink = Object.assign(
    (operation: OperationLike, forward: ForwardFunction) => {
      if (!forwardFn) {
        forwardFn = forward;
      }
      if (hasClient(operation)) {
        lastClient = operation.client;
      }

      return new Observable<FetchResult>((observer) => {
        let subscription: { unsubscribe?: () => void } | null = null;
        let queued = false;

        const start = async () => {
          if (initError) {
            observer.error?.(initError);
            return;
          }

          if (shouldRetryOperation(operation)) {
            const canSend = await ensureOnlineBeforeSend();
            if (!canSend && shouldQueueNow(operation)) {
              log("queue:enqueue", { operationName: operation.operationName });
              enqueue(operation, observer);
              queued = true;
              return;
            }
          }

          if (shouldQueueNow(operation)) {
            log("queue:enqueue", { operationName: operation.operationName });
            enqueue(operation, observer);
            queued = true;
            return;
          }

          subscription = forward(operation).subscribe({
            next: (value) => observer.next?.(value),
            error: (error) => {
              if (shouldQueueOnError(operation, error)) {
                log("queue:onError", {
                  operationName: operation.operationName,
                });
                enqueue(operation, observer, error);
                setOnline(false);
                queued = true;
                return;
              }
              observer.error?.(error);
            },
            complete: () => observer.complete?.(),
          });
        };

        void readyPromise.then(start).catch((error) => observer.error?.(error));

        return () => {
          if (subscription?.unsubscribe) {
            subscription.unsubscribe();
          }
          if (queued) {
            removeFromQueueByObserver(observer);
          }
        };
      });
    },
    { setOnline, isOnline, getQueueLength, flushQueue, dispose }
  );

  return handler;

  function shouldQueueNow(operation: OperationLike) {
    if (!shouldRetryOperation(operation)) {
      return false;
    }

    if (!online && isRetryableOperation(operation)) {
      return true;
    }

    return false;
  }

  function shouldQueueOnError(operation: OperationLike, error: unknown) {
    if (!shouldRetryOperation(operation)) {
      return false;
    }

    if (!isRetryableOperation(operation)) {
      return false;
    }

    return isNetworkError(error);
  }

  function shouldRetryOperation(operation: OperationLike) {
    if (!queueOperations || queueOperations.length === 0) {
      return true;
    }

    if (!operation.operationName) {
      return false;
    }

    return queueOperations.includes(operation.operationName);
  }

  function isRetryableOperation(operation: OperationLike) {
    if (queueOperations && operation.operationName) {
      return queueOperations.includes(operation.operationName);
    }

    if (!queueMutationsOnly) {
      return true;
    }

    const definition = getMainDefinition(operation.query);
    return (
      definition.kind === "OperationDefinition" &&
      definition.operation === "mutation"
    );
  }

  function isNetworkError(error: unknown) {
    if (hasProperty(error, "networkError")) {
      const networkError = error.networkError;
      if (typeof networkError === "string") {
        return isNetworkMessage(networkError);
      }
      if (hasProperty(networkError, "message")) {
        const message = networkError.message;
        if (typeof message === "string") {
          return isNetworkMessage(message);
        }
      }
      return Boolean(networkError);
    }

    if (hasProperty(error, "message") && typeof error.message === "string") {
      return isNetworkMessage(error.message);
    }

    return false;
  }

  function isNetworkMessage(message: string) {
    return (
      message.includes("Network request failed") ||
      message.includes("Network request timed out") ||
      message.includes("Failed to fetch") ||
      message.includes("Network Error")
    );
  }

  function enqueue(
    operation: OperationLike,
    observer?: LinkObserver,
    error?: unknown
  ) {
    const serialized = serializeOperation(operation);
    const item: QueueItem = {
      id: nextId(),
      addedAt: Date.now(),
      operation,
      observer,
      serialized,
    };

    queue.push(item);
    log("queue:added", { size: queue.length, operationName: operation.operationName });
    void persistQueue();

    if (error && !isNetworkError(error)) {
      observer?.error?.(error);
    }
  }

  function removeFromQueueByObserver(observer: LinkObserver) {
    const index = queue.findIndex((item) => item.observer === observer);
    if (index === -1) {
      return;
    }

    queue.splice(index, 1);
    log("queue:removed", { size: queue.length });
    void persistQueue();
  }

  async function initialize() {
    log("init:start");
    if (persist) {
      storage = await loadAsyncStorage();
    }

    await hydrateQueue();

    if (autoDetectOnline) {
      void setupNetInfo();
    }
    log("init:ready", { online, size: queue.length });
  }

  async function loadAsyncStorage() {
    const module = await import("@react-native-async-storage/async-storage");
    const candidate = module.default ?? module;

    if (!isAsyncStorage(candidate)) {
      throw new Error(
        "AsyncStorage is not available. Install @react-native-async-storage/async-storage."
      );
    }

    return candidate;
  }

  async function setupNetInfo() {
    if (netInfoUnsubscribe) {
      return;
    }

    const instance = await loadNetInfo();
    if (!instance) {
      return;
    }
    netInfoInstance = instance;

    if (instance.fetch) {
      try {
        const state = await instance.fetch();
        updateOnlineFromState(state);
      } catch {
        // Ignore fetch failures; listener will still update when possible.
      }
    }

    const unsubscribe = instance.addEventListener((state) => {
      updateOnlineFromState(state);
    });
    netInfoUnsubscribe =
      typeof unsubscribe === "function"
        ? unsubscribe
        : () => unsubscribe.remove?.();
  }

  async function loadNetInfo(): Promise<NetInfoLike | undefined> {
    try {
      const module = await import("@react-native-community/netinfo");
      const candidate = module.default ?? module;
      if (isNetInfo(candidate)) {
        return candidate;
      }
    } catch {
      return undefined;
    }

    return undefined;
  }

  async function ensureOnlineBeforeSend() {
    if (!netInfoInstance?.fetch) {
      return online;
    }

    try {
      const state = await netInfoInstance.fetch();
      if (typeof state.isInternetReachable === "boolean") {
        setOnline(state.isInternetReachable);
        return state.isInternetReachable;
      }
      if (state.isConnected === false) {
        setOnline(false);
        return false;
      }
    } catch {
      return online;
    }

    return online;
  }

  function updateOnlineFromState(state: NetInfoState) {
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

  async function hydrateQueue() {
    if (!storage) {
      return;
    }

    const raw = await storage.getItem(storageKey);
    if (!raw) {
      return;
    }

    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        throw new Error("Invalid queue payload");
      }

      for (const entry of parsed) {
        if (!isStoredQueueItem(entry)) {
          throw new Error("Invalid queue payload");
        }
        queue.push({
          id: entry.id,
          addedAt: entry.addedAt,
          operation: entry.operation,
          serialized: entry.operation,
        });
      }
    } catch {
      await storage.removeItem?.(storageKey);
    }
  }

  async function persistQueue() {
    if (!storage) {
      return;
    }

    const stored: StoredQueueItem[] = queue.map((item) => ({
      id: item.id,
      addedAt: item.addedAt,
      operation: item.serialized,
    }));

    if (stored.length === 0) {
      await storage.removeItem?.(storageKey);
      return;
    }

    await storage.setItem(storageKey, JSON.stringify(stored));
  }

  function serializeOperation(operation: OperationLike): SerializedOperation {
    return {
      query: print(operation.query),
      variables: operation.variables,
      operationName: operation.operationName,
      extensions: operation.extensions,
    };
  }

  function getOperationForItem(item: QueueItem): OperationLike {
    if (isSerializedOperation(item.operation)) {
      return deserializeOperation(item.operation);
    }

    return item.operation;
  }

  function isSerializedOperation(operation: unknown): operation is SerializedOperation {
    return (
      hasProperty(operation, "query") && typeof operation.query === "string"
    );
  }

  function deserializeOperation(serialized: SerializedOperation): OperationLike {
    const context: Record<string, unknown> = {};
    return {
      query: gql(serialized.query),
      variables: serialized.variables ?? {},
      operationName: serialized.operationName,
      extensions: serialized.extensions,
      setContext: (next) => {
        const nextContext =
          typeof next === "function" ? next(context) : { ...context, ...next };
        Object.assign(context, nextContext);
      },
      getContext: () => context,
    };
  }

  async function executeOperation(
    operation: OperationLike,
    observer?: LinkObserver
  ) {
    if (!forwardFn) {
      return { success: false, isNetworkError: false };
    }

    if (!hasClient(operation)) {
      if (lastClient !== undefined) {
        operation.client = lastClient;
      } else {
        log("forward:skip", { reason: "missing-client" });
        return { success: false, isNetworkError: true };
      }
    }

    logReplay(operation);
    log("forward:start", { operationName: operation.operationName });
    return new Promise<{ success: boolean; isNetworkError: boolean }>((resolve) => {
      forwardFn(operation).subscribe({
        next: (value) => observer?.next?.(value),
        error: (error) => {
          observer?.error?.(error);
          log("forward:error", {
            operationName: operation.operationName,
            networkError: isNetworkError(error),
            message:
              hasProperty(error, "message") && typeof error.message === "string"
                ? error.message
                : undefined,
            networkMessage:
              hasProperty(error, "networkError") &&
              hasProperty(error.networkError, "message") &&
              typeof error.networkError.message === "string"
                ? error.networkError.message
                : undefined,
          });
          resolve({ success: false, isNetworkError: isNetworkError(error) });
        },
        complete: () => {
          observer?.complete?.();
          log("forward:complete", { operationName: operation.operationName });
          resolve({ success: true, isNetworkError: false });
        },
      });
    });
  }

  function nextId() {
    idCounter += 1;
    return `${Date.now()}-${idCounter}`;
  }

  function hasProperty(
    value: unknown,
    key: string
  ): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && key in value;
  }

  function hasClient(operation: OperationLike): operation is OperationLike {
    return hasProperty(operation, "client") && operation.client !== undefined;
  }

  function isAsyncStorage(value: unknown): value is AsyncStorageLike {
    return (
      hasProperty(value, "getItem") &&
      typeof value.getItem === "function" &&
      hasProperty(value, "setItem") &&
      typeof value.setItem === "function"
    );
  }

  function isNetInfo(value: unknown): value is NetInfoLike {
    return hasProperty(value, "addEventListener");
  }

  function isStoredQueueItem(value: unknown): value is StoredQueueItem {
    return (
      hasProperty(value, "id") &&
      typeof value.id === "string" &&
      hasProperty(value, "addedAt") &&
      typeof value.addedAt === "number" &&
      hasProperty(value, "operation") &&
      isSerializedOperation(value.operation)
    );
  }

  function log(event: string, details?: Record<string, unknown>) {
    if (!logging) {
      return;
    }
    if (details) {
      console.log(`[apollo-offline-link] ${event}`, details);
      return;
    }
    console.log(`[apollo-offline-link] ${event}`);
  }

  function logReplay(operation: OperationLike) {
    if (!replayLogging) {
      return;
    }
    console.log(`[apollo-offline-link] replay`, {
      operationName: operation.operationName,
    });
  }
};
