# Apollo Offline Queue Link (React Native)

Queues failed/offline mutations and retries when connectivity returns.

## Motivation

Mobile apps are often offline or on unreliable networks. This link keeps
mutations safe by queueing them while offline and replaying them in order
once connectivity returns, without forcing you to wire NetInfo manually.

Apollo Link design principles:

- Incrementally adoptable: optional persistence and NetInfo auto-detection.
- Universally compatible: no hard runtime dependencies.
- Simple to get started with: minimal setup, sensible defaults.
- Inspectable and understandable: small, direct API surface.
- Built for interactive apps: retries when connectivity returns.
- Small and flexible: mutation-only queueing by default, configurable behavior.
- Community driven: open to feedback and contributions.

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
import { createOfflineQueueLink } from "apollo-offline-queue-link";

const offlineLink = createOfflineQueueLink({
  persist: true,
  queueOperations: ["CreatePost", "UpdateProfile"],
  logging: true,
  replayLogging: true,
});

const client = new ApolloClient({
  link: ApolloLink.from([
    new ApolloLink(offlineLink),
    new HttpLink({ uri: "https://example.com/graphql" }),
  ]),
  cache: new InMemoryCache(),
});
```

## Notes

- By default, only mutations are queued.
- NetInfo is auto-detected when installed; set `autoDetectOnline: false` to manage `setOnline` manually.
- When auto-detect is enabled and `initialOnline` is not provided, the link starts offline until NetInfo confirms reachability.
- Mutations are replayed in order once online connectivity returns.
- `createOfflineQueueLink` returns a RequestHandler; wrap it with `new ApolloLink(...)` for Apollo Client v4.
- Set `persist: true` to persist the queue across app restarts (uses AsyncStorage).
- Use `queueOperations` to restrict which operations are queued and retried.
- Listed operations are retried even if `queueMutationsOnly` stays `true`.
- Set `logging: true` to print queue/flush activity to the console.
- Set `replayLogging: true` to always log when a queued operation is replayed.
- If NetInfo reports `isConnected: true` without `isInternetReachable`, the link will keep the previous online state to avoid false positives.
- When a network error is detected, the link switches to offline to queue subsequent operations.
- After app restart, queued items will flush once a client is available; if no client is present yet, flush waits.
- Operations listed in `queueOperations` perform a NetInfo reachability check before sending.

## Options

- `persist`: persist the queue in AsyncStorage across app restarts.
- `queueOperations`: only queue/retry operations with these names.
- `queueMutationsOnly`: set to `false` to allow non-mutation operations (still filtered by `queueOperations`).
- `autoDetectOnline`: disable to control online state manually via `setOnline`.
- `logging`: enable console logs for queueing and flushing.
- `replayLogging`: log when queued operations are replayed (separate from `logging`).

## Examples

- `examples/README.md`
