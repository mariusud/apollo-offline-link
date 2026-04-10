# Apollo Offline Queue Link (React Native)

A tiny Apollo Link that queues operations while offline and replays them when connectivity returns.

## Install

```bash
npm i @apollo/client graphql
npm i @react-native-community/netinfo @react-native-async-storage/async-storage
```

## Usage

```ts
import {
  ApolloClient,
  InMemoryCache,
  HttpLink,
  ApolloLink,
} from "@apollo/client";
import { OfflineQueueLink } from "apollo-offline-queue-link";

const offlineLink = new OfflineQueueLink({
  persist: true,
  initialOnline: true,
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
- If offline, operations are queued in memory (and AsyncStorage when enabled).
- When connectivity returns, the queue is replayed in order.

## Options

- `persist`: store the queue in AsyncStorage (default: `true`).
- `storageKey`: AsyncStorage key for persisted queue.
- `initialOnline`: starting online state (default: `true`).
- `autoDetectOnline`: use NetInfo to update online state (default: `true`).

## Manual Online Control

Disable auto-detection and set online state yourself:

```ts
const offlineLink = new OfflineQueueLink({ autoDetectOnline: false });

// Later
offlineLink.setOnline(true);
```

## Notes

- If AsyncStorage or NetInfo are not available, the link falls back gracefully.
- Queued operations replay in order once online.
