import { describe, expect, it, vi } from "vitest";
import { gql, type ApolloClient, type ApolloLink } from "@apollo/client";
import type { OperationTypeNode } from "graphql";
import { Observable } from "rxjs";

import OfflineQueueLink from "../src/OfflineQueueLink";

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
    expect((link as { queue: unknown[] }).queue.length).toBe(0);
  });
});
