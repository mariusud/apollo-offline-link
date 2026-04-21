import { ApolloLink } from "@apollo/client";
import type { Observer } from "rxjs";

export type PersistedQueueItem = ApolloLink.Request & {
  operationName?: string;
};

export interface PersistedQueueEntry {
  operation: PersistedQueueItem;
  retryCount: number;
}

// Live items may also keep the original observer/transport so same-process
// retries behave exactly like the initial request.
export interface QueueItem {
  operation: PersistedQueueItem;
  retryCount: number;
  observer?: Observer<ApolloLink.Result>;
  forward?: ApolloLink.ForwardFunction;
  client?: ApolloLink.Operation["client"];
  restored?: boolean;
}

export type OfflineQueueLinkOptions = {
  watchOperations: string[];
  logging?: boolean;
};
