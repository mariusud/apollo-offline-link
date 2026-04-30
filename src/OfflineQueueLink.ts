import type { Observer } from "rxjs";
import { Observable } from "rxjs";

import AsyncStorage from "@react-native-async-storage/async-storage";
import NetInfo from "@react-native-community/netinfo";
import { ApolloLink } from "@apollo/client";
import { createOperation } from "@apollo/client/link/utils";
import type {
  OfflineQueueLinkOptions,
  PersistedQueueEntry,
  PersistedQueueItem,
  QueueItem,
} from "./types";

const STORAGE_KEY = "apollo-offline-link-queue";
const MAX_REPLAY_ATTEMPTS = 5;

/**
 * Apollo Link that queues operations while offline and replays them when back online.
 */
export default class OfflineQueueLink extends ApolloLink {
  private isOnline: boolean;
  private queue: QueueItem[] = [];
  private watchedOperations: Set<string>;
  private isLoggingEnabled: boolean;
  private isReplaying: boolean;
  private client?: ApolloLink.Operation["client"]; // latest seen client stored for replay of serialized operations without original client reference
  private forward?: ApolloLink.ForwardFunction; // latest seen forward stored for replay of serialized operations without original forward reference

  // Hydrate the persisted queue once up front, while accepting the older
  // storage format that only contained serialized operations.
  private ready = AsyncStorage.getItem(STORAGE_KEY).then((storedQueue) => {
    if (storedQueue) {
      this.queue = JSON.parse(storedQueue).map(
        (entry: PersistedQueueEntry | PersistedQueueItem) => {
          if ("operation" in entry) {
            return {
              operation: entry.operation,
              retryCount: entry.retryCount,
              restored: true,
            };
          }

          return {
            operation: entry,
            retryCount: 0,
            restored: true,
          };
        },
      );
    }
  });

  constructor(options?: OfflineQueueLinkOptions) {
    super();
    this.isOnline = true;
    this.watchedOperations = new Set(options?.watchOperations);
    this.isLoggingEnabled = options?.logging ?? false;
    this.isReplaying = false;

    // Subscribe to network status changes
    NetInfo.addEventListener((state) => {
      this.isOnline = state.isInternetReachable === true;
      const reachabilityStatus =
        state.isInternetReachable === true
          ? "internet reachable"
          : state.isInternetReachable === false
            ? "internet not reachable"
            : "internet reachability unknown";
      this.log(reachabilityStatus);

      // Replay gate: network is online & transport available
      if (this.isOnline && this.client && this.forward) {
        this.replayQueue();
      }
    });
  }

  private log(event: string, details?: Record<string, unknown>) {
    if (!this.isLoggingEnabled) {
      return;
    }
    console.log(`[OfflineQueueLink] ${event}`, ...(details ? [details] : []));
  }

  private isNetworkError(error: unknown) {
    const message = (error as Error | undefined)?.message ?? "";
    return /network request (failed|timed out)|failed to fetch/i.test(message);
  }

  private isWatchedOperation(operation: ApolloLink.Operation) {
    const { operationName } = operation;
    return (
      operationName !== undefined && this.watchedOperations.has(operationName)
    );
  }

  // we cant store the full Operation with forward/observer functions
  private serializeOperation(
    operation: ApolloLink.Operation,
  ): PersistedQueueItem {
    return {
      query: operation.query,
      variables: operation.variables,
      extensions: operation.extensions,
      operationName: operation.operationName,
    };
  }

  private persistQueue() {
    if (this.queue.length === 0) {
      return AsyncStorage.removeItem(STORAGE_KEY);
    }

    return AsyncStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(
        this.queue.map((item) => ({
          operation: item.operation,
          retryCount: item.retryCount,
        })),
      ),
    );
  }

  // queue functionality
  private enqueue(
    operation: ApolloLink.Operation,
    observer: Observer<ApolloLink.Result>,
    forward: ApolloLink.ForwardFunction,
  ) {
    this.queue.push({
      operation: this.serializeOperation(operation),
      retryCount: 0,
      observer,
      forward,
      client: operation.client,
      restored: false,
    });
    void this.persistQueue();

    this.log("Added item to queue", {
      name: operation.operationName,
      variables: operation.variables,
    });
  }

  private async replayQueue() {
    if (this.isReplaying) {
      this.log("Replay already in progress, skipping");
      return;
    }

    this.isReplaying = true;

    try {
      await this.ready;

      while (this.queue.length > 0) {
        this.log("Attempting to replay queue", { size: this.queue.length });

        // Keep the head item in place until it succeeds or exhausts retries.
        const item = this.queue[0];
        // Live items keep their original transport; restored items fall back to
        // the latest transport observed after startup.
        const forward = item.forward ?? this.forward;
        const client = item.client ?? this.client;

        if (!forward || !client) {
          this.log("Missing replay transport for queued item", {
            name: item.operation.operationName,
            restored: item.restored ?? false,
          });
          return;
        }

        try {
          const operation = createOperation(item.operation, {
            client,
          });
          // Replay the operation through the resolved transport and mirror the
          // downstream observer events back to the original caller when possible.
          await new Promise<void>((resolve, reject) => {
            forward(operation).subscribe({
              next: (result) => {
                console.log("Replay next:", result);
                item.observer?.next(result);
              },
              error: (error) => {
                console.log("Replay error", error);
                reject(error);
              },
              complete: () => {
                console.log("Replay complete:", item.operation.operationName);
                item.observer?.complete();
                resolve();
              },
            });
          });
          this.log("Successfully replayed item", {
            name: item.operation.operationName,
            variables: item.operation.variables,
          });

          // Only remove persisted state after a confirmed successful replay.
          this.queue.shift();
          await this.persistQueue();
        } catch (error) {
          item.retryCount += 1;
          this.log("Failed to replay item", {
            name: item.operation.operationName,
            variables: item.operation.variables,
            retryCount: item.retryCount,
            error: (error as Error)?.message,
          });

          if (item.retryCount >= MAX_REPLAY_ATTEMPTS) {
            item.observer?.error(error);
            this.queue.shift();
            await this.persistQueue();
            continue;
          }

          // Leave the item at the head and try again on the next replay trigger.
          await this.persistQueue();
          return;
        }
      }
    } finally {
      this.isReplaying = false;
    }
  }

  // request flow:
  // - remember the latest transport for restored-item fallback
  // - if the operation is unwatched, or we're already online, forward it now
  // - if a watched operation hits a network error, mark offline and enqueue it
  // - if a watched operation starts while offline, enqueue it immediately
  // - when connectivity returns, replay queued operations in order
  public request(
    operation: ApolloLink.Operation,
    forward: ApolloLink.ForwardFunction,
  ): Observable<ApolloLink.Result> {
    const hadTransport = !!this.forward && !!this.client;

    this.client = operation.client;
    this.forward = forward;
    const isWatched = this.isWatchedOperation(operation);

    if (!hadTransport && this.isOnline && this.queue.length > 0) {
      this.replayQueue();
    }

    if (!isWatched || this.isOnline) {
      return new Observable<ApolloLink.Result>((observer) => {
        // Subscribe to the downstream link so we can react to network failures
        // and re-synchronize the queue when connectivity returns.
        const subscription = forward(operation).subscribe({
          next: (result) => {
            if (!this.isOnline) {
              this.log("Successful response while offline, marking as online");
              this.isOnline = true;
              this.replayQueue();
            }
            observer.next(result);
          },
          error: (error) => {
            if (isWatched && this.isNetworkError(error)) {
              this.isOnline = false;
              this.log("request:network-error:queued");
              this.enqueue(operation, observer, forward);
              return;
            }
            observer.error(error);
          },
          complete: () => {
            observer.complete();
          },
        });

        return () => subscription.unsubscribe();
      });
    }

    return new Observable<ApolloLink.Result>((observer) => {
      this.enqueue(operation, observer, forward);
    });
  }
}
