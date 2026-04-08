import { ApolloClient, ApolloLink, HttpLink, InMemoryCache } from "@apollo/client";
import { OfflineQueueLink } from "apollo-offline-queue-link";

export const offlineLink = new OfflineQueueLink({
  persist: true,
  queueOperations: ["CreatePost"],
});

const httpLink = new HttpLink({
  uri: "https://graphqlzero.almansi.me/api",
});

export const apolloClient = new ApolloClient({
  link: ApolloLink.from([new ApolloLink(offlineLink), httpLink]),
  cache: new InMemoryCache(),
});
