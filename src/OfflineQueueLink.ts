import type { Observer } from "rxjs";
import { Observable } from "rxjs";

import { uuid } from "expo-modules-core";
import NetInfo, { fetch } from "@react-native-community/netinfo";
import { ApolloLink } from "@apollo/client";

const DEFAULT_STORAGE_KEY = "apollo-offline-queue";

type OfflineQueueLinkOptions = {
  storageKey?: string;
};

interface QueueItem {
  id: string;
  addedAt: number;
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

  constructor(options?: OfflineQueueLinkOptions) {
    super();
    this.isOnline = true;

    // Subscribe to network status changes
    NetInfo.addEventListener((state) => {
      this.isOnline = state.isInternetReachable ?? false;

      if (this.isOnline) {
        this.replayQueue();
      }
    });
  }

  private log(event: string, details?: Record<string, unknown>) {
    console.log(`[OfflineQueueLink] ${event}`, details);
  }

  private getNetworkState() {
    fetch().then((state) => {
      this.log("netinfo", {
        isInternetReachable: state.isInternetReachable,
        type: state.type,
      });
      this.isOnline = state.isInternetReachable ?? false;
    });
  }

  // queue functionality
  private enqueue(item: QueueItem) {
    this.queue.push(item);

    this.log("queue:enqueue", {
      id: item.id,
      addedAt: item.addedAt,
      size: this.queue.length,
    });
  }

  private async replayQueue() {
    this.log("queue:replay:start", { size: this.queue.length });

    while (this.queue.length > 0) {
      const item = this.queue.shift()!;
      try {
        this.log("queue:replay:item", { id: item.id, addedAt: item.addedAt });
        const result = await new Promise<ApolloLink.Result>(
          (resolve, reject) => {
            item.forward(item.operation).subscribe({
              next: resolve,
              error: reject,
              complete: () => {},
            });
          },
        );
        item.observer.next(result);
        item.observer.complete();
        this.log("queue:replay:success", { id: item.id });
      } catch (error) {
        item.observer.error(error);
        this.log("queue:replay:error", {
          id: item.id,
          error: (error as Error)?.message,
        });
      }
    }
    this.log("queue:replay:done");
  }

  // https://www.apollographql.com/docs/react/api/link/apollo-link#apollolinkrequest
  public request(
    operation: ApolloLink.Operation,
    forward: ApolloLink.ForwardFunction,
  ): Observable<ApolloLink.Result> {
    // brief overview of the implementation:
    // - if we're online, just forward the operation as normal
    // - if we're offline, add it to the queue with a timestamp
    // - when we come back online, we replay the queued operations in order, waiting for each to complete before starting the next

    this.getNetworkState();

    // offline, queue the operation
    if (!this.isOnline) {
      this.log("request:queued");
      return new Observable<ApolloLink.Result>((observer) => {
        this.enqueue({
          id: uuid.v4(),
          addedAt: Date.now(),
          operation,
          forward,
          observer,
        });
      });
    }

    // online, just forward the operation
    this.log("request:forward");
    return forward(operation);
  }
}
