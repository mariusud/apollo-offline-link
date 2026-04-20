import { beforeEach, describe, expect, it, vi } from "vitest";
import { gql, type ApolloClient, type ApolloLink } from "@apollo/client";
import type { OperationTypeNode } from "graphql";
import { Observable } from "rxjs";

import OfflineQueueLink from "../src/OfflineQueueLink";

type QueueItemShape = {
  retryCount: number;
};

const { storage } = vi.hoisted(() => {
  const storage = {
    value: null as string | null,
    getItem: vi.fn(async () => storage.value),
    setItem: vi.fn(async (_key: string, value: string) => {
      storage.value = value;
    }),
    removeItem: vi.fn(async () => {
      storage.value = null;
    }),
  };

  return { storage };
});

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: storage,
}));

vi.mock("@react-native-community/netinfo", () => ({
  default: {
    addEventListener: vi.fn((_listener) => () => {}),
  },
}));

const createOperation = (name: string): ApolloLink.Operation => {
  const context: Record<string, unknown> = {};
  return {
    operationName: name,
    operationType: "query" as OperationTypeNode,
    variables: {},
    query: gql`
      query ${name} {
        __typename
      }
    `,
    getContext: () => context,
    setContext: (next) => {
      const update = typeof next === "function" ? next(context) : next;
      Object.assign(context, update);
    },
    extensions: {},
    client: {} as ApolloClient,
  };
};

describe("OfflineQueueLink", () => {
  beforeEach(() => {
    storage.value = null;
    storage.getItem.mockClear();
    storage.setItem.mockClear();
    storage.removeItem.mockClear();
  });

  it("queues watched operations when offline", async () => {
    const link = new OfflineQueueLink({ watchOperations: ["WatchedOp"] });
    (link as { isOnline: boolean }).isOnline = false;

    const forward = vi.fn(
      () =>
        new Observable<ApolloLink.Result>((observer) => {
          observer.next({ data: { ok: true } });
          observer.complete();
        }),
    );

    const operation = createOperation("WatchedOp");

    const result = link.request(operation, forward);
    result.subscribe({ error: () => {} });

    expect(forward).not.toHaveBeenCalled();
    expect((link as { queue: unknown[] }).queue.length).toBe(1);

    (link as { isOnline: boolean }).isOnline = true;
    await (link as { replayQueue: () => Promise<void> }).replayQueue();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(forward).toHaveBeenCalledTimes(1);
    expect((link as { queue: unknown[] }).queue.length).toBe(0);
  });

  it("forwards non-watched operations even when offline", () => {
    const link = new OfflineQueueLink({ watchOperations: ["WatchedOp"] });
    (link as { isOnline: boolean }).isOnline = false;

    const forward = vi.fn(
      () =>
        new Observable<ApolloLink.Result>((observer) => {
          observer.next({ data: { ok: true } });
          observer.complete();
        }),
    );

    const operation = createOperation("OtherOp");
    const result = link.request(operation, forward);
    result.subscribe({ error: () => {} });

    expect(forward).toHaveBeenCalledTimes(1);
    expect((link as { queue: unknown[] }).queue.length).toBe(0);
  });

  it("queues watched operations on network error", async () => {
    const link = new OfflineQueueLink({ watchOperations: ["WatchedOp"] });

    const forward = vi.fn(
      () =>
        new Observable<ApolloLink.Result>((observer) => {
          observer.error(new TypeError("Network request timed out"));
        }),
    );

    const operation = createOperation("WatchedOp");
    const result = link.request(operation, forward);
    result.subscribe({ error: () => {} });

    expect(forward).toHaveBeenCalledTimes(1);
    expect((link as { queue: unknown[] }).queue.length).toBe(1);

    (link as { isOnline: boolean }).isOnline = true;
    await (link as { replayQueue: () => Promise<void> }).replayQueue();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((link as { queue: QueueItemShape[] }).queue).toHaveLength(1);
    expect((link as { queue: QueueItemShape[] }).queue[0]?.retryCount).toBe(1);
  });

  it("keeps failed replay items queued and increments retryCount", async () => {
    const link = new OfflineQueueLink({ watchOperations: ["WatchedOp"] });
    (link as { isOnline: boolean }).isOnline = false;

    link.request(createOperation("WatchedOp"), vi.fn()).subscribe({
      error: () => {},
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    const replayForward = vi.fn(
      () =>
        new Observable<ApolloLink.Result>((observer) => {
          observer.error(new TypeError("Network request timed out"));
        }),
    );

    link.request(createOperation("OtherOp"), replayForward).subscribe({
      error: () => {},
    });

    (link as { isOnline: boolean }).isOnline = true;
    await (link as { replayQueue: () => Promise<void> }).replayQueue();

    expect((link as { queue: QueueItemShape[] }).queue).toHaveLength(1);
    expect((link as { queue: QueueItemShape[] }).queue[0]?.retryCount).toBe(1);
    expect(storage.value).toContain('"retryCount":1');
  });

  it("drops replay items after five failed attempts", async () => {
    const link = new OfflineQueueLink({ watchOperations: ["WatchedOp"] });
    (link as { isOnline: boolean }).isOnline = false;

    link.request(createOperation("WatchedOp"), vi.fn()).subscribe({
      error: () => {},
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    const replayForward = vi.fn(
      () =>
        new Observable<ApolloLink.Result>((observer) => {
          observer.error(new TypeError("Network request timed out"));
        }),
    );

    link.request(createOperation("OtherOp"), replayForward).subscribe({
      error: () => {},
    });

    (link as { isOnline: boolean }).isOnline = true;

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await (link as { replayQueue: () => Promise<void> }).replayQueue();
    }

    expect((link as { queue: unknown[] }).queue).toHaveLength(0);
    expect(storage.removeItem).toHaveBeenCalledTimes(1);
  });

  it("restores queued operations from storage after reload", async () => {
    const firstLink = new OfflineQueueLink({
      watchOperations: ["WatchedOp"],
    });
    (firstLink as { isOnline: boolean }).isOnline = false;

    const firstForward = vi.fn(
      () =>
        new Observable<ApolloLink.Result>((observer) => {
          observer.next({ data: { ok: true } });
          observer.complete();
        }),
    );

    firstLink
      .request(createOperation("WatchedOp"), firstForward)
      .subscribe({ error: () => {} });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(storage.setItem).toHaveBeenCalledTimes(1);

    const secondLink = new OfflineQueueLink({
      watchOperations: ["WatchedOp"],
    });
    const secondForward = vi.fn(
      () =>
        new Observable<ApolloLink.Result>((observer) => {
          observer.next({ data: { ok: true } });
          observer.complete();
        }),
    );

    secondLink.request(createOperation("OtherOp"), secondForward).subscribe({
      error: () => {},
    });

    (secondLink as { isOnline: boolean }).isOnline = true;
    await (secondLink as { replayQueue: () => Promise<void> }).replayQueue();

    expect(secondForward).toHaveBeenCalledTimes(2);
    expect(storage.removeItem).toHaveBeenCalledTimes(1);
    expect((secondLink as { queue: unknown[] }).queue.length).toBe(0);
  });
});
