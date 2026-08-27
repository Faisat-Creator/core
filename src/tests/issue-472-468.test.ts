import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import {
  evaluateTrustlineApproval,
  forecastTransactionCosts,
  analyzeTransactionCosts,
} from "../index";

describe("trustline approval policy", () => {
  const issuer = Keypair.random().publicKey();

  it("approves an exact asset and rejects an unknown issuer", () => {
    const approved = evaluateTrustlineApproval(
      { code: "USDC", issuer },
      { assets: [{ code: "USDC", issuer }] },
    );
    expect(approved.status).toBe("ok");
    if (approved.status === "ok") expect(approved.data.approved).toBe(true);

    const rejected = evaluateTrustlineApproval(
      { code: "USDC", issuer: Keypair.random().publicKey() },
      { assets: [{ code: "USDC", issuer }] },
    );
    expect(rejected.status).toBe("ok");
    if (rejected.status === "ok") expect(rejected.data.reason).toBe("unapproved-issuer");
  });

  it("supports issuer-wide rules with optional asset restrictions", () => {
    const issuerWide = evaluateTrustlineApproval({ code: "EURC", issuer }, { issuers: { [issuer]: {} } });
    expect(issuerWide.status).toBe("ok");
    if (issuerWide.status === "ok") expect(issuerWide.data.approved).toBe(true);

    const restricted = evaluateTrustlineApproval(
      { code: "EURC", issuer },
      { issuers: { [issuer]: { assets: ["USDC"] } } },
    );
    expect(restricted.status).toBe("ok");
    if (restricted.status === "ok") expect(restricted.data.reason).toBe("unapproved-asset");
  });
});

describe("transaction cost analysis", () => {
  it("aggregates operation-level fees and ignores unavailable fees", () => {
    const result = analyzeTransactionCosts([
      { hash: "1", status: "confirmed", fee: "100", operationTypes: ["payment"] },
      { hash: "2", status: "confirmed", fee: "300", operationTypes: ["payment", "changeTrust"] },
      { hash: "3", status: "pending", operationTypes: ["payment"] },
    ]);
    expect(result.totalFee).toBe("400");
    expect(result.analyzedCount).toBe(2);
    expect(result.missingFeeCount).toBe(1);
    expect(result.byOperation.payment.transactionCount).toBe(2);
  });

  it("forecasts planned operations and reports budget overruns", () => {
    const result = forecastTransactionCosts(
      [{ type: "payment", count: 5, feePerOperation: "100" }],
      { budget: "400" },
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.projectedFee).toBe("500");
      expect(result.data.overBudget).toBe(true);
      expect(result.data.warning).toMatch(/budget/i);
    }
  });
});
