import { describe, expect, it, vi } from "vitest";
import { forecastBalance } from "../account/balanceForecast";
import { analyzeContractStorage } from "../soroban/storageAnalysis";
import { CongestionMonitor } from "../network/congestionMonitor";
import {
  discoverHardwareWallets,
  getHardwareWalletPublicKey,
  signTransactionWithHardwareWallet,
} from "../wallet/hardwareWallet";
import { SorokitErrorCode } from "../shared/response";

describe("balance forecasting", () => {
  it("projects the average historical net flow", () => {
    const result = forecastBalance(
      [
        { date: "2024-01-02", amount: "10", direction: "in" },
        { date: "2024-01-03", amount: "4", direction: "out" },
      ],
      { currentBalance: "100", historyDays: 4, forecastDays: 2, now: new Date("2024-01-05T00:00:00Z") },
    );
    expect(result.averageDailyNetChange).toBe("1.5");
    expect(result.projections.map((point) => point.projectedBalance)).toEqual(["101.5", "103"]);
    expect(result.confidence).toBe("low");
  });
});

describe("Soroban storage analysis", () => {
  it("reports large and repeated values", () => {
    const result = analyzeContractStorage(
      [
        { key: "a", value: { shared: "x" } },
        { key: "b", value: { shared: "x" } },
        { key: "c", value: { shared: "x" } },
        { key: "large", value: "x".repeat(20), sizeBytes: 2048 },
      ],
      { largeValueBytes: 1024 },
    );
    expect(result.entryCount).toBe(4);
    expect(result.repeatedValueGroups[0]?.count).toBe(3);
    expect(result.recommendations.map(({ code }) => code)).toEqual(expect.arrayContaining(["large-value", "repeated-value"]));
  });
});

describe("congestion monitoring", () => {
  it("reduces concurrency when failures or latency rise", () => {
    const monitor = new CongestionMonitor({ maxConcurrency: 8, windowSize: 3 });
    expect(monitor.snapshot().recommendedConcurrency).toBe(8);
    monitor.record({ latencyMs: 2500, success: false });
    const snapshot = monitor.record({ latencyMs: 2500, success: false, confirmationMs: 3000 });
    expect(snapshot.level).toBe("congested");
    expect(snapshot.recommendedConcurrency).toBe(1);
    expect(snapshot.averageConfirmationMs).toBe(3000);
  });
});

describe("hardware wallet adapter", () => {
  const input = { transactionXdr: "xdr", networkPassphrase: "passphrase" };
  it("normalizes adapter failures without leaking provider details", async () => {
    const adapter = {
      provider: "test-device",
      discoverDevices: vi.fn().mockRejectedValue(new Error("disconnected")),
      getPublicKey: vi.fn().mockRejectedValue(new Error("disconnected")),
      signTransaction: vi.fn().mockRejectedValue(new Error("disconnected")),
    };
    const discovered = await discoverHardwareWallets(adapter);
    const key = await getHardwareWalletPublicKey(adapter, { id: "one" });
    const signed = await signTransactionWithHardwareWallet(adapter, { id: "one" }, input);
    expect(discovered).toMatchObject({ status: "error", error: { code: SorokitErrorCode.WALLET_NOT_FOUND } });
    expect(key).toMatchObject({ status: "error", error: { code: SorokitErrorCode.WALLET_CONNECT_FAILED } });
    expect(signed).toMatchObject({ status: "error", error: { code: SorokitErrorCode.WALLET_SIGN_FAILED } });
  });
});
