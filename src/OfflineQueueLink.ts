import type { Observer } from "rxjs";
import { Observable } from "rxjs";

import NetInfo from "@react-native-community/netinfo";
import { ApolloLink } from "@apollo/client";

type OfflineQueueLinkOptions = {
  watchOperations: string[];
  logging?: boolean;
};

interface QueueItem {
  operation: ApolloLink.Operation;
  forward: ApolloLink.ForwardFunction;
  observer: Observer<ApolloLink.Result>;
}

/**
 * Apollo Link that queues operations while offline and replays them when back online.
 */
export default class OfflineQueueLink extends ApolloLink {
  private isOnline: boolean;
  private queue: QueueItem[] = [];
  private watchedOperations: Set<string>;
  private isLoggingEnabled: boolean;

  constructor(options?: OfflineQueueLinkOptions) {
    super();
    this.isOnline = true;
    this.watchedOperations = new Set(options?.watchOperations);
    this.isLoggingEnabled = options?.logging ?? false;

    // Subscribe to network status changes
    NetInfo.addEventListener((state) => {
      this.isOnline = state.isInternetReachable === true;
      this.log("netinfo - isInternetReachable? " + state.isInternetReachable);

      if (this.isOnline) {
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
    return this.watchedOperations.has(operation.operationName || "");
  }

  // queue functionality
  private enqueue(item: QueueItem) {
    this.queue.push(item);

    this.log("Added item to queue", {
      name: item.operation.operationName,
      variables: item.operation.variables,
    });
  }

  private async replayQueue() {
    while (this.queue.length > 0) {
      this.log("Attempting to replay queue", { size: this.queue.length });
      const item = this.queue.shift()!;
      try {
        await new Promise<void>((resolve, reject) => {
          item.forward(item.operation).subscribe({
            next: (result) => {
              item.observer.next(result);
            },
            error: (error) => {
              item.observer.error(error);
              reject(error);
            },
            complete: () => {
              item.observer.complete();
              resolve();
            },
          });
        });
        this.log("Successfully replayed item", {
          name: item.operation.operationName,
          variables: item.operation.variables,
        });
      } catch (error) {
        this.log("Failed to replay item", {
          name: item.operation.operationName,
          variables: item.operation.variables,
          error: (error as Error)?.message,
        });
      }
    }
  }

  // brief overview of the implementation:
  // - if we're offline, add it to the queue with a timestamp
  // - if we're online or not watching operation, just forward the operation as normal
  // - if a watched operation fails with a network error, mark us as offline and add it to the queue
  // - when we come back online, we replay the queued operations in order, waiting for each to complete before starting the next
  public request(
    operation: ApolloLink.Operation,
    forward: ApolloLink.ForwardFunction,
  ): Observable<ApolloLink.Result> {
    // offline and of interest, add to queue
    if (!this.isOnline && this.isWatchedOperation(operation)) {
      this.log("Offline, enqueuing operation", {
        name: operation.operationName,
        variables: operation.variables,
      });
      return new Observable<ApolloLink.Result>((observer) => {
        this.enqueue({
          operation,
          forward,
          observer,
        });
      });
    }

    // online or dont care operation, forward
    return new Observable<ApolloLink.Result>((observer) => {
      const subscription = forward(operation).subscribe({
        // got a successful response,
        // if offline, go "online" and replay queue
        next: (result) => {
          if (!this.isOnline) {
            this.log("Successful response while offline, marking as online");
            this.isOnline = true;
            this.replayQueue();
          }
          observer.next(result);
        },
        // Error
        // if its watched and a network error, turn offline and queue
        error: (error) => {
          if (
            this.isWatchedOperation(operation) &&
            this.isNetworkError(error)
          ) {
            this.isOnline = false;
            this.log("request:network-error:queued");
            this.enqueue({
              operation,
              forward,
              observer,
            });
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
}
