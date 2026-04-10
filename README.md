# apollo-offline-link

A simple Apollo Link that queues specific operations while offline and replays them when connectivity returns.

## Install

```bash
npm i apollo-offline-link
npm i @apollo/client graphql @react-native-community/netinfo
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

- If online, operations pass through immediately.
- If offline and the operation name is listed in `watchOperations`, the operation is queued.
- When connectivity returns, the queue is replayed in order.
- If a watched operation fails with a network error, it is queued and the link marks itself offline.

By default, no operations are queued unless `watchOperations` is provided.

## API

### Options

- `watchOperations`: list of operation names to queue while offline (default: `[]`).

## Notes

- Operation matching is by `operationName`, so ensure your operations are named.
- NetInfo is used for online/offline detection and can be flaky; the link will also mark itself online when a successful response arrives.
