import { describe, expect, it, vi } from "vitest";
import { gql } from "@apollo/client";
import type { Operation } from "@apollo/client/link/core";
import { Observable } from "@apollo/client/utilities";
import { OfflineQueueLink } from "../src/OfflineQueueLink";

const asyncStorageMock = {
  getItem: vi.fn(async () => null),
  setItem: vi.fn(async () => undefined),
  removeItem: vi.fn(async () => undefined),
};

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: asyncStorageMock,
}));

type ObserverEvents = {
  next: unknown[];
  error: unknown[];
  complete: number;
};

const createObserver = () => {
  const events: ObserverEvents = { next: [], error: [], complete: 0 };
  return {
    events,
    observer: {
      next: (value: unknown) => events.next.push(value),
      error: (value: unknown) => events.error.push(value),
      complete: () => {
        events.complete += 1;
      },
    },
  };
};

const createOperation = (
  operationName = "TestMutation",
  type: "mutation" | "query" = "mutation"
): Operation => {
  const context: Record<string, unknown> = {};
  return {
    query: gql`
      ${type} ${operationName}($value: String) {
        doThing(value: $value)
      }
    `,
    variables: { value: "test" },
    operationName,
    extensions: {},
    setContext: (next) => {
      const nextContext =
        typeof next === "function" ? next(context) : { ...context, ...next };
      Object.assign(context, nextContext);
    },
    getContext: () => context,
  };
};

const flushPromises = () => new Promise((resolve) => setTimeout(resolve, 0));

const createForward = (handler: (op: Operation) => Observable<unknown>) =>
  vi.fn((op: Operation) => handler(op));

describe("OfflineQueueLink", () => {
  it("queues operations while offline and replays when online", async () => {
    const link = new OfflineQueueLink({ initialOnline: false });
    const forward = createForward((op) =>
      new Observable((observer) => {
        observer.next({ data: { ok: true, name: op.operationName } });
        observer.complete();
      })
    );

    const { observer, events } = createObserver();
    link.request(createOperation(), forward)?.subscribe(observer);

    await flushPromises();

    expect(forward).toHaveBeenCalledTimes(0);
    expect(link.getQueueLength()).toBe(1);

    link.setOnline(true);
    await flushPromises();

    expect(forward).toHaveBeenCalledTimes(1);
    expect(link.getQueueLength()).toBe(0);
    expect(events.next.length).toBe(1);
    expect(events.complete).toBe(1);
  });

  it("queues operation on network error", async () => {
    const link = new OfflineQueueLink();
    const forward = createForward(() =>
      new Observable((observer) => {
        observer.error({ networkError: new Error("offline") });
      })
    );

    const { observer, events } = createObserver();
    link.request(createOperation(), forward)?.subscribe(observer);

    await flushPromises();

    expect(link.getQueueLength()).toBe(1);
    expect(events.error.length).toBe(0);
  });

  it("skips queueing when operation is not in queueOperations", async () => {
    const link = new OfflineQueueLink({
      initialOnline: false,
      queueOperations: ["KeepMe"],
    });
    const forward = createForward((op) =>
      new Observable((observer) => {
        observer.next({ data: { ok: true, name: op.operationName } });
        observer.complete();
      })
    );

    link.request(createOperation("SkipMe"), forward)?.subscribe({});
    await flushPromises();

    expect(link.getQueueLength()).toBe(0);
  });

  it("queues a listed query when it matches queueOperations", async () => {
    const link = new OfflineQueueLink({
      initialOnline: false,
      queueOperations: ["HeatmapQuery"],
    });
    const forward = createForward((op) =>
      new Observable((observer) => {
        observer.next({ data: { ok: true, name: op.operationName } });
        observer.complete();
      })
    );

    link.request(createOperation("HeatmapQuery", "query"), forward)?.subscribe({});
    await flushPromises();

    expect(link.getQueueLength()).toBe(1);
  });

  it("persists queued operations when persist is enabled", async () => {
    asyncStorageMock.getItem.mockResolvedValueOnce(null);
    const link = new OfflineQueueLink({
      initialOnline: false,
      persist: true,
    });
    const forward = createForward(() =>
      new Observable((observer) => {
        observer.next({ data: { ok: true } });
        observer.complete();
      })
    );

    link.request(createOperation(), forward)?.subscribe({});
    await flushPromises();

    expect(asyncStorageMock.setItem).toHaveBeenCalledTimes(1);
    const payload = asyncStorageMock.setItem.mock.calls[0]?.[1];
    expect(typeof payload).toBe("string");
    if (typeof payload === "string") {
      const stored = JSON.parse(payload);
      expect(Array.isArray(stored)).toBe(true);
      if (Array.isArray(stored)) {
        expect(stored.length).toBe(1);
        const entry = stored[0];
        expect(entry && typeof entry === "object").toBe(true);
      }
    }
  });
});
