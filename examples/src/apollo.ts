import { ApolloClient, ApolloLink, HttpLink, InMemoryCache } from "@apollo/client";
import OfflineQueueLink from "apollo-offline-queue-link/src/OfflineQueueLink";

type OfflineQueueLinkInternal = OfflineQueueLink & {
  isOnline?: boolean;
  queue?: unknown[];
  replayQueue?: () => Promise<void>;
};

export const offlineLink = new OfflineQueueLink();
const offlineLinkInternal = offlineLink as OfflineQueueLinkInternal;

const httpLink = new HttpLink({
  uri: "https://graphqlzero.almansi.me/api",
});

export const apolloClient = new ApolloClient({
  link: ApolloLink.from([offlineLink, httpLink]),
  cache: new InMemoryCache(),
});

export const getQueueLength = () => {
  const queue = offlineLinkInternal.queue;
  return Array.isArray(queue) ? queue.length : 0;
};

export const setForcedOffline = (forcedOffline: boolean) => {
  offlineLinkInternal.isOnline = !forcedOffline;
  if (!forcedOffline) {
    void offlineLinkInternal.replayQueue?.();
  }
};
