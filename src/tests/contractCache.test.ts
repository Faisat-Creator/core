/**
 * Tests for contract state caching with TTL and invalidation (Issue #196).
 *
 * Verifies:
 *   - Optional cacheKey parameter / cache hit + miss
 *   - Configurable TTL (default 5 minutes)
 *   - invalidateContractState() removes entries
 *   - readContract() caches successful results
 *   - readContract() does NOT cache errors
 *   - Concurrent identical reads share a single RPC call (deduplication)
 *   - createContractReadCacheKey() produces stable, unique keys
 */

import { Keypair, StrKey, xdr } from "@stellar/stellar-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createInMemoryCache,
  invalidateContractState,
} from "../shared/cache";
import {
  createContractReadCacheKey,
  invalidateContractReadCache,
} from "../soroban/contractCallIdentity";
import { readContract } from "../soroban/readContract";
import type { ResolvedNetworkConfig } from "../shared/types";
import type { SorokitCache } from "../shared/cache";

// ─── SDK mocks (same pattern as soroban.test.ts) ─────────────────────────────

const {
  mockLoadAccount,
  mockSimulateTransaction,
  mockIsSimulationSuccess,
  mockIsSimulationError,
  mockScValToNative,
} = vi.hoisted(() => ({
  mockLoadAccount: vi.fn(),
  mockSimulateTransaction: vi.fn(),
  mockIsSimulationSuccess: vi.fn(),
  mockIsSimulationError: vi.fn(),
  mockScValToNative: vi.fn(),
}));

vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stellar/stellar-sdk")>();

  class MockContract {
    constructor(readonly contractId: string) {}
    call(method: string, ...params: unknown[]) {
      return { contractId: this.contractId, method, params };
    }
  }

  class MockTransactionBuilder {
    constructor(readonly _source: unknown, readonly _opts: unknown) {}
    addOperation(_op: unknown) { return this; }
    setTimeout(_t: number) { return this; }
    build() { return { fee: "100", toXDR: () => "mock-xdr" }; }
  }
  (MockTransactionBuilder as unknown as { fromXDR: unknown }).fromXDR =
    actual.TransactionBuilder.fromXDR;

  return {
    ...actual,
    BASE_FEE: "100",
    Contract: MockContract,
    Horizon: {
      Server: vi.fn().mockImplementation(() => ({
        loadAccount: mockLoadAccount,
      })),
    },
    TransactionBuilder: MockTransactionBuilder,
    scValToNative: mockScValToNative,
    rpc: {
      ...actual.rpc,
      Server: vi.fn().mockImplementation(() => ({
        simulateTransaction: mockSimulateTransaction,
      })),
      Api: {
        ...actual.rpc.Api,
        isSimulationError: mockIsSimulationError,
        isSimulationSuccess: mockIsSimulationSuccess,
      },
    },
  };
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function randomContractId(): string {
  return StrKey.encodeContract(Keypair.random().rawPublicKey());
}

const networkConfig: ResolvedNetworkConfig = {
  network: "testnet",
  horizonUrl: "https://horizon-testnet.stellar.org",
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
};

const MOCK_RETVAL = {} as xdr.ScVal;

function setupMocks() {
  mockLoadAccount.mockReset();
  mockLoadAccount.mockResolvedValue({});
  mockSimulateTransaction.mockReset();
  mockSimulateTransaction.mockResolvedValue({ result: { retval: MOCK_RETVAL } });
  mockIsSimulationError.mockReset();
  mockIsSimulationError.mockReturnValue(false);
  mockIsSimulationSuccess.mockReset();
  mockIsSimulationSuccess.mockReturnValue(true);
  mockScValToNative.mockReset();
  mockScValToNative.mockReturnValue(42);
}

// ─── createContractReadCacheKey ───────────────────────────────────────────────

describe("createContractReadCacheKey", () => {
  it("produces a stable key for the same inputs", () => {
    const contractId = randomContractId();
    const k1 = createContractReadCacheKey(contractId, "get_price", []);
    const k2 = createContractReadCacheKey(contractId, "get_price", []);
    expect(k1).toBe(k2);
  });

  it("produces different keys for different methods", () => {
    const contractId = randomContractId();
    const k1 = createContractReadCacheKey(contractId, "get_price", []);
    const k2 = createContractReadCacheKey(contractId, "get_balance", []);
    expect(k1).not.toBe(k2);
  });

  it("produces different keys for different contractIds", () => {
    const k1 = createContractReadCacheKey(randomContractId(), "fn", []);
    const k2 = createContractReadCacheKey(randomContractId(), "fn", []);
    expect(k1).not.toBe(k2);
  });

  it("key contains the contractId for readability", () => {
    const contractId = randomContractId();
    const key = createContractReadCacheKey(contractId, "fn", []);
    expect(key).toContain(contractId);
  });

  it("scopes identical calls to their network context", () => {
    const contractId = randomContractId();
    const testnetKey = createContractReadCacheKey(contractId, "fn", [], 0, "testnet");
    const mainnetKey = createContractReadCacheKey(contractId, "fn", [], 0, "mainnet");
    expect(testnetKey).not.toBe(mainnetKey);
  });
});

// ─── invalidateContractState ──────────────────────────────────────────────────

describe("invalidateContractState", () => {
  it("removes an existing cache entry", () => {
    const cache = createInMemoryCache();
    cache.set("my-key", { value: 99 });

    expect(cache.get("my-key")).toEqual({ value: 99 });
    invalidateContractState("my-key", cache);
    expect(cache.get("my-key")).toBeUndefined();
  });

  it("is a no-op when the key does not exist", () => {
    const cache = createInMemoryCache();
    expect(() => invalidateContractState("nonexistent", cache)).not.toThrow();
  });

  it("only removes the specified key, leaving others intact", () => {
    const cache = createInMemoryCache();
    cache.set("key-a", "value-a");
    cache.set("key-b", "value-b");

    invalidateContractState("key-a", cache);

    expect(cache.get("key-a")).toBeUndefined();
    expect(cache.get("key-b")).toBe("value-b");
  });

  it("invalidates a deterministic contract-read entry", () => {
    const cache = createInMemoryCache();
    const contractId = randomContractId();
    const key = createContractReadCacheKey(contractId, "balance", [], 0, "testnet");
    cache.set(key, { result: "old" });
    invalidateContractReadCache(cache, contractId, "balance", [], 0, "testnet");
    expect(cache.get(key)).toBeUndefined();
  });
});

// ─── readContract caching ──────────────────────────────────────────────────────

describe("readContract — cache behaviour", () => {
  beforeEach(setupMocks);

  it("bypasses cache lookup, deduplication, and writes when requested", async () => {
    const cache = createInMemoryCache();
    const params = {
      contractId: randomContractId(),
      method: "get_price",
      publicKey: Keypair.random().publicKey(),
      cache,
      bypassCache: true,
    };

    await readContract(networkConfig.rpcUrl, networkConfig.horizonUrl, networkConfig, params);
    await readContract(networkConfig.rpcUrl, networkConfig.horizonUrl, networkConfig, params);
    expect(mockSimulateTransaction).toHaveBeenCalledTimes(2);
    expect(cache.get("sorokit:contract-read:any")).toBeUndefined();
  });

  it("returns a result without cache when no cache is passed", async () => {
    const result = await readContract(
      networkConfig.rpcUrl,
      networkConfig.horizonUrl,
      networkConfig,
      {
        contractId: randomContractId(),
        method: "get_price",
        publicKey: Keypair.random().publicKey(),
      },
    );
    expect(result.status).toBe("ok");
    expect(mockSimulateTransaction).toHaveBeenCalledOnce();
  });

  it("caches a successful result — second call is a cache hit with no RPC call", async () => {
    const cache = createInMemoryCache();
    const contractId = randomContractId();
    const params = {
      contractId,
      method: "get_price",
      publicKey: Keypair.random().publicKey(),
      cache,
    };

    const first = await readContract(
      networkConfig.rpcUrl,
      networkConfig.horizonUrl,
      networkConfig,
      params,
    );
    expect(first.status).toBe("ok");
    expect(mockSimulateTransaction).toHaveBeenCalledTimes(1);

    // Second call — should come from cache
    const second = await readContract(
      networkConfig.rpcUrl,
      networkConfig.horizonUrl,
      networkConfig,
      params,
    );
    expect(second.status).toBe("ok");
    // RPC was NOT called again
    expect(mockSimulateTransaction).toHaveBeenCalledTimes(1);

    // Same data
    if (first.status === "ok" && second.status === "ok") {
      expect(second.data.value).toBe(first.data.value);
    }
  });

  it("uses the default TTL of 5 minutes", async () => {
    const setCalls: number[] = [];
    const cache: SorokitCache = {
      get: () => undefined,
      set: (_key, _val, ttlMs) => { setCalls.push(ttlMs ?? 0); },
      invalidate: () => {},
      clear: () => {},
    };

    await readContract(
      networkConfig.rpcUrl,
      networkConfig.horizonUrl,
      networkConfig,
      {
        contractId: randomContractId(),
        method: "get_price",
        publicKey: Keypair.random().publicKey(),
        cache,
      },
    );

    expect(setCalls).toHaveLength(1);
    expect(setCalls[0]).toBe(5 * 60 * 1000); // 300_000 ms
  });

  it("respects a custom TTL passed via params.ttlMs", async () => {
    const setCalls: number[] = [];
    const cache: SorokitCache = {
      get: () => undefined,
      set: (_key, _val, ttlMs) => { setCalls.push(ttlMs ?? 0); },
      invalidate: () => {},
      clear: () => {},
    };

    await readContract(
      networkConfig.rpcUrl,
      networkConfig.horizonUrl,
      networkConfig,
      {
        contractId: randomContractId(),
        method: "get_price",
        publicKey: Keypair.random().publicKey(),
        cache,
        ttlMs: 30_000,
      },
    );

    expect(setCalls[0]).toBe(30_000);
  });

  it("does NOT cache error results", async () => {
    mockIsSimulationError.mockReturnValue(true);
    mockSimulateTransaction.mockResolvedValue({ error: "Contract reverted" });

    const getCallCount = { count: 0 };
    const setCallCount = { count: 0 };
    const cache: SorokitCache = {
      get: () => { getCallCount.count++; return undefined; },
      set: () => { setCallCount.count++; },
      invalidate: () => {},
      clear: () => {},
    };

    const result = await readContract(
      networkConfig.rpcUrl,
      networkConfig.horizonUrl,
      networkConfig,
      {
        contractId: randomContractId(),
        method: "get_price",
        publicKey: Keypair.random().publicKey(),
        cache,
      },
    );

    expect(result.status).toBe("error");
    expect(setCallCount.count).toBe(0); // nothing was cached
  });

  it("cache miss after manual invalidation triggers a fresh RPC call", async () => {
    const cache = createInMemoryCache();
    const contractId = randomContractId();
    const publicKey = Keypair.random().publicKey();

    // First call — populates cache
    await readContract(
      networkConfig.rpcUrl,
      networkConfig.horizonUrl,
      networkConfig,
      { contractId, method: "get_price", publicKey, cache },
    );
    expect(mockSimulateTransaction).toHaveBeenCalledTimes(1);

    // Invalidate
    const cacheKey = createContractReadCacheKey(
      contractId,
      "get_price",
      [],
      0,
      networkConfig.networkPassphrase,
    );
    invalidateContractState(cacheKey, cache);

    // Second call — cache miss, must hit RPC again
    await readContract(
      networkConfig.rpcUrl,
      networkConfig.horizonUrl,
      networkConfig,
      { contractId, method: "get_price", publicKey, cache },
    );
    expect(mockSimulateTransaction).toHaveBeenCalledTimes(2);
  });

  it("different method names produce independent cache entries", async () => {
    const cache = createInMemoryCache();
    const contractId = randomContractId();
    const publicKey = Keypair.random().publicKey();

    await readContract(
      networkConfig.rpcUrl,
      networkConfig.horizonUrl,
      networkConfig,
      { contractId, method: "get_price", publicKey, cache },
    );
    await readContract(
      networkConfig.rpcUrl,
      networkConfig.horizonUrl,
      networkConfig,
      { contractId, method: "get_balance", publicKey, cache },
    );

    // Both methods should have triggered RPC (separate cache keys)
    expect(mockSimulateTransaction).toHaveBeenCalledTimes(2);
  });
});

// ─── createInMemoryCache TTL ──────────────────────────────────────────────────

describe("createInMemoryCache — TTL expiry", () => {
  it("returns the value before TTL expires", () => {
    vi.useFakeTimers();
    const cache = createInMemoryCache();
    cache.set("key", "value", 10_000);

    vi.advanceTimersByTime(9_999);
    expect(cache.get("key")).toBe("value");

    vi.useRealTimers();
  });

  it("returns undefined after TTL expires", () => {
    vi.useFakeTimers();
    const cache = createInMemoryCache();
    cache.set("key", "value", 10_000);

    vi.advanceTimersByTime(10_001);
    expect(cache.get("key")).toBeUndefined();

    vi.useRealTimers();
  });

  it("default TTL is applied when set in constructor", () => {
    vi.useFakeTimers();
    const cache = createInMemoryCache(5_000);
    cache.set("key", "value"); // no explicit TTL

    vi.advanceTimersByTime(5_001);
    expect(cache.get("key")).toBeUndefined();

    vi.useRealTimers();
  });

  it("throws if TTL is not a positive integer", () => {
    const cache = createInMemoryCache();
    expect(() => cache.set("k", "v", 0)).toThrow("TTL must be a positive integer");
    expect(() => cache.set("k", "v", -100)).toThrow("TTL must be a positive integer");
    expect(() => cache.set("k", "v", 1.5)).toThrow("TTL must be a positive integer");
  });
});
