import { ApolloLink } from "@apollo/client/link/core";
import type {
  FetchResult,
  NextLink,
  Operation,
  RequestHandler,
} from "@apollo/client/link/core";
import { Observable, gql } from "@apollo/client/utilities";
import { print } from "graphql";
import { createNetInfoMonitor } from "./netinfo";
import { createQueuePersistence } from "./persistence";

export type SerializedOperation = {
  query: string;
  variables?: Record<string, unknown>;
  operationName?: string;
  extensions?: Record<string, unknown>;
};

type LinkObserver = {
  next?: (value: FetchResult) => void;
  error?: (error: unknown) => void;
  complete?: () => void;
};

type QueueItem = {
  id: string;
  addedAt: number;
  operation: Operation | SerializedOperation;
  observer?: LinkObserver;
  serialized: SerializedOperation;
  forward?: NextLink;
};

export type OfflineQueueLinkOptions = {
  persist?: boolean;
  queueOperations?: string[];
  initialOnline?: boolean;
  autoDetectOnline?: boolean;
  logging?: boolean;
  replayLogging?: boolean;
};

export type OfflineQueueLinkHandler = RequestHandler & {
  setOnline: (online: boolean) => void;
  isOnline: () => boolean;
  getQueueLength: () => number;
  flushQueue: () => Promise<void>;
  dispose: () => void;
};

const DEFAULT_STORAGE_KEY = "apollo-offline-queue";

/**
 * Apollo Link that queues selected operations while offline.
 * - Omit `queueOperations` to allow all operations to queue when offline.
 * - Enable `persist` to keep the queue across app restarts (AsyncStorage).
 * - Enable `autoDetectOnline` to listen to NetInfo and replay automatically.
 */
export class OfflineQueueLink extends ApolloLink {
  private readonly storageKey = DEFAULT_STORAGE_KEY;
  private readonly persist: boolean;
  private readonly queueOperations?: string[];
  private readonly autoDetectOnline: boolean;
  private readonly logging: boolean;
  private readonly replayLogging: boolean;

  private online: boolean;
  private queue: QueueItem[] = [];
  private lastForward?: NextLink;
  private lastClient?: unknown;
  private initError?: Error;
  private netInfo?: { ensureOnline: (currentOnline: boolean) => Promise<boolean>; dispose: () => void };
  private flushing = false;
  private idCounter = 0;

  private persistence: ReturnType<typeof createQueuePersistence>;

  private readonly readyPromise: Promise<void>;

  constructor(options: OfflineQueueLinkOptions = {}) {
    super();

    const {
      persist = false,
      queueOperations,
      autoDetectOnline = true,
      initialOnline,
      logging = false,
      replayLogging = true,
    } = options;

    this.persist = persist;
    this.queueOperations = queueOperations;
    this.autoDetectOnline = autoDetectOnline;
    this.logging = logging;
    this.replayLogging = replayLogging;

    this.online = initialOnline ?? (autoDetectOnline ? false : true);

    // Enable persistence lazily in init to avoid calling storage without need.
    this.persistence = createQueuePersistence({
      enabled: persist,
      storageKey: this.storageKey,
      log: this.log,
      isSerializedOperation: (value) => this.isSerializedOperation(value),
    });

    this.readyPromise = this.initialize().catch((error) => {
      this.initError = error instanceof Error ? error : new Error(String(error));
    });
  }

  // ApolloLink request hook
  public request(operation: Operation, forward?: NextLink): Observable<FetchResult> | null {
    if (!forward) {
      return null;
    }

    this.lastForward = forward;
    if (this.hasClient(operation)) {
      this.lastClient = operation.client;
    }

    return new Observable<FetchResult>((observer) => {
      let subscription: { unsubscribe?: () => void } | null = null;
      let queued = false;

      const start = async () => {
        if (this.initError) {
          observer.error?.(this.initError);
          return;
        }

        if (this.isQueueable(operation)) {
          await this.ensureOnlineBeforeSend();
          if (this.shouldQueueNow(operation)) {
            this.log("queue:enqueue", { operationName: operation.operationName });
            this.enqueue(operation, observer, forward);
            queued = true;
            return;
          }
        }

        subscription = forward(operation).subscribe({
          next: (value) => observer.next?.(value),
          error: (error) => {
            if (this.shouldQueueOnError(operation, error)) {
              this.log("queue:onError", { operationName: operation.operationName });
              this.enqueue(operation, observer, forward, error);
              this.setOnline(false);
              queued = true;
              return;
            }
            observer.error?.(error);
          },
          complete: () => observer.complete?.(),
        });
      };

      void this.readyPromise.then(start).catch((error) => observer.error?.(error));

      return () => {
        subscription?.unsubscribe?.();
        if (queued) {
          this.removeFromQueueByObserver(observer);
        }
      };
    });
  }

  public setOnline(nextOnline: boolean) {
    this.online = nextOnline;
    this.log("setOnline", { online: nextOnline });
    if (nextOnline) {
      void this.flushQueue();
    }
  }

  public isOnline() {
    return this.online;
  }

  public getQueueLength() {
    return this.queue.length;
  }

  public dispose() {
    this.netInfo?.dispose();
    this.netInfo = undefined;
  }

  public async flushQueue() {
    await this.readyPromise;
    if (this.initError || !this.online || this.flushing) {
      return;
    }

    this.flushing = true;
    try {
      this.log("flush:start", { size: this.queue.length });
      while (this.queue.length > 0 && this.online) {
        const item = this.queue[0];
        const operation = this.getOperationForItem(item);
        const result = await this.executeOperation(operation, item.observer, item.forward);

        if (result.success) {
          this.queue.shift();
          await this.persistence.persistQueue(this.queue);
          continue;
        }

        if (result.isNetworkError) {
          this.log("flush:paused", { reason: "network-error" });
          break;
        }

        this.queue.shift();
        await this.persistence.persistQueue(this.queue);
      }
      this.log("flush:done", { size: this.queue.length });
    } finally {
      this.flushing = false;
    }
  }

  // Queueing rules
  private shouldQueueNow(operation: Operation) {
    return this.isQueueable(operation) && !this.online;
  }

  private shouldQueueOnError(operation: Operation, error: unknown) {
    return this.isQueueable(operation) && this.isNetworkError(error);
  }

  private isQueueable(operation: Operation) {
    if (!this.queueOperations || this.queueOperations.length === 0) {
      return true;
    }

    return Boolean(
      operation.operationName && this.queueOperations.includes(operation.operationName)
    );
  }

  // Queue storage
  private enqueue(
    operation: Operation,
    observer?: LinkObserver,
    forward?: NextLink,
    error?: unknown
  ) {
    const serialized = this.serializeOperation(operation);
    const item: QueueItem = {
      id: this.nextId(),
      addedAt: Date.now(),
      operation,
      observer,
      serialized,
      forward,
    };

    this.queue.push(item);
    this.log("queue:added", {
      size: this.queue.length,
      operationName: operation.operationName,
    });
    void this.persistence.persistQueue(this.queue);

    if (error && !this.isNetworkError(error)) {
      observer?.error?.(error);
    }
  }

  private removeFromQueueByObserver(observer: LinkObserver) {
    const index = this.queue.findIndex((item) => item.observer === observer);
    if (index === -1) {
      return;
    }

    this.queue.splice(index, 1);
    this.log("queue:removed", { size: this.queue.length });
    void this.persistence.persistQueue(this.queue);
  }

  // Init lifecycle
  private async initialize() {
    this.log("init:start");

    const storedItems = await this.persistence.hydrateQueue();
    for (const entry of storedItems) {
      this.queue.push({
        id: entry.id,
        addedAt: entry.addedAt,
        operation: entry.operation,
        serialized: entry.operation,
      });
    }

    if (this.autoDetectOnline) {
      this.netInfo = await createNetInfoMonitor({
        enabled: true,
        setOnline: (online) => this.setOnline(online),
        log: this.log,
      });
    }

    this.log("init:ready", { online: this.online, size: this.queue.length });
  }

  // NetInfo and explicit setOnline both flow through this.
  private async ensureOnlineBeforeSend() {
    if (!this.netInfo) {
      return this.online;
    }
    return this.netInfo.ensureOnline(this.online);
  }

  // Serialization
  private serializeOperation(operation: Operation): SerializedOperation {
    return {
      query: print(operation.query),
      variables: operation.variables,
      operationName: operation.operationName,
      extensions: operation.extensions,
    };
  }

  private getOperationForItem(item: QueueItem): Operation {
    if (this.isSerializedOperation(item.operation)) {
      return this.deserializeOperation(item.operation);
    }

    return item.operation;
  }

  private isSerializedOperation(operation: unknown): operation is SerializedOperation {
    return (
      this.hasProperty(operation, "query") && typeof operation.query === "string"
    );
  }

  private deserializeOperation(serialized: SerializedOperation): Operation {
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

  // Execution
  private async executeOperation(
    operation: Operation,
    observer?: LinkObserver,
    forward?: NextLink
  ) {
    const next = forward ?? this.lastForward;
    if (!next) {
      return { success: false, isNetworkError: true };
    }

    if (!this.hasClient(operation)) {
      if (this.lastClient !== undefined) {
        operation.client = this.lastClient;
      } else {
        this.log("forward:skip", { reason: "missing-client" });
        return { success: false, isNetworkError: true };
      }
    }

    this.logReplay(operation);
    this.log("forward:start", { operationName: operation.operationName });
    return new Promise<{ success: boolean; isNetworkError: boolean }>((resolve) => {
      next(operation).subscribe({
        next: (value) => observer?.next?.(value),
        error: (error) => {
          observer?.error?.(error);
          this.log("forward:error", {
            operationName: operation.operationName,
            networkError: this.isNetworkError(error),
            message:
              this.hasProperty(error, "message") && typeof error.message === "string"
                ? error.message
                : undefined,
            networkMessage:
              this.hasProperty(error, "networkError") &&
              this.hasProperty(error.networkError, "message") &&
              typeof error.networkError.message === "string"
                ? error.networkError.message
                : undefined,
          });
          resolve({ success: false, isNetworkError: this.isNetworkError(error) });
        },
        complete: () => {
          observer?.complete?.();
          this.log("forward:complete", { operationName: operation.operationName });
          resolve({ success: true, isNetworkError: false });
        },
      });
    });
  }

  // Error detection
  private isNetworkError(error: unknown) {
    if (this.hasProperty(error, "networkError")) {
      const networkError = error.networkError;
      if (typeof networkError === "string") {
        return this.isNetworkMessage(networkError);
      }
      if (this.hasProperty(networkError, "message")) {
        const message = networkError.message;
        if (typeof message === "string") {
          return this.isNetworkMessage(message);
        }
      }
      return Boolean(networkError);
    }

    if (this.hasProperty(error, "message") && typeof error.message === "string") {
      return this.isNetworkMessage(error.message);
    }

    return false;
  }

  private isNetworkMessage(message: string) {
    return (
      message.includes("Network request failed") ||
      message.includes("Network request timed out") ||
      message.includes("Failed to fetch") ||
      message.includes("Network Error")
    );
  }

  // Helpers
  private nextId() {
    this.idCounter += 1;
    return `${Date.now()}-${this.idCounter}`;
  }

  private hasProperty(value: unknown, key: string): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && key in value;
  }

  private hasClient(operation: Operation) {
    return this.hasProperty(operation, "client") && operation.client !== undefined;
  }

  // Logging
  private log = (event: string, details?: Record<string, unknown>) => {
    if (!this.logging) {
      return;
    }
    if (details) {
      console.log(`[apollo-offline-link] ${event}`, details);
      return;
    }
    console.log(`[apollo-offline-link] ${event}`);
  };

  private logReplay(operation: Operation) {
    if (!this.replayLogging) {
      return;
    }
    console.log(`[apollo-offline-link] replay`, {
      operationName: operation.operationName,
    });
  }
}
