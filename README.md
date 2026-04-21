# apollo-offline-link

A simple Apollo link that queues selected operations while offline, persists them with AsyncStorage, and replays them when connectivity returns.

## Install

```bash
npm i apollo-offline-link
npm i @apollo/client graphql @react-native-community/netinfo @react-native-async-storage/async-storage
```

## Usage

```ts
import {
  ApolloClient,
  InMemoryCache,
  HttpLink,
  ApolloLink,
} from "@apollo/client";
import { OfflineQueueLink } from "apollo-offline-link";

const offlineLink = new OfflineQueueLink({
  watchOperations: ["UpdateProfile", "SubmitOrder"],
});

const client = new ApolloClient({
  link: ApolloLink.from([
    offlineLink,
    new HttpLink({ uri: "https://example.com/graphql" }),
  ]),
  cache: new InMemoryCache(),
});
```

## How It Works

- If online, or an operation is not watched it will pass through immediately.
- Operations listed in `watchOperations` will be queued when offline.
- If a watched operation is attempted and hits a network error, it is added to the queue and the link marks itself offline.
- The queue is persisted with AsyncStorage, so queued operations survive app restarts.
- When connectivity returns, queued operations are replayed in order.
- Failed replays stay at the head of the queue and are retried later. After 5 failed replay attempts, the queued item is dropped.

By default, no operations are queued unless `watchOperations` is provided.

## API

### Options

- `watchOperations`: list of operation names to queue while offline.
- `logging`: enable console logging (default: `false`).

## Notes

- NetInfo is used for online/offline detection, and the link also uses request outcomes to refine its online/offline state.
- To enable logging, set {logging: true} and it will emit logs with [apollo-offline-link] prefix
