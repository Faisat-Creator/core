import { describe, expect, it } from "vitest";
import { Account, Asset, Keypair, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { issueRefund } from "../transaction/refunds";
import { resolveNetwork } from "../network/resolveNetwork";

const source = Keypair.random();
const payer = Keypair.random();
const network = resolveNetwork("testnet");
if (network.status === "error") throw new Error(network.error.message);

function originalPaymentXdr(): string {
  return new TransactionBuilder(new Account(source.publicKey(), "1"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        source: payer.publicKey(),
        destination: source.publicKey(),
        asset: Asset.native(),
        amount: "10",
      }),
    )
    .setTimeout(300)
    .build()
    .toXDR();
}

describe("refund workflows", () => {
  it("builds a full refund without modifying the original XDR", async () => {
    const original = originalPaymentXdr();
    const result = await issueRefund(
      "https://horizon-testnet.stellar.org",
      network.data,
      source.publicKey(),
      original,
      { sequenceNumber: "2", estimatedFee: "100" },
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.amount).toMatch(/^10(?:\.0+)?$/);
      expect(result.data.partial).toBe(false);
      expect(result.data.originalXdr).toBe(original);
    }
  });

  it("supports partial refunds and rejects over-refunds", async () => {
    const original = originalPaymentXdr();
    const partial = await issueRefund(
      "https://horizon-testnet.stellar.org",
      network.data,
      source.publicKey(),
      original,
      { amount: "2.5", destination: payer.publicKey(), sequenceNumber: "2", estimatedFee: "100" },
    );
    expect(partial.status).toBe("ok");
    if (partial.status === "ok") expect(partial.data.partial).toBe(true);

    const excessive = await issueRefund(
      "https://horizon-testnet.stellar.org",
      network.data,
      source.publicKey(),
      original,
      { amount: "10.1", destination: payer.publicKey(), sequenceNumber: "2", estimatedFee: "100" },
    );
    expect(excessive.status).toBe("error");
    if (excessive.status === "error") expect(excessive.error.message).toMatch(/exceed/i);
  });

  it("returns structured errors for malformed and unsupported originals", async () => {
    const malformed = await issueRefund(
      "https://horizon-testnet.stellar.org",
      network.data,
      source.publicKey(),
      "not-xdr",
    );
    expect(malformed.status).toBe("error");

    const unsupported = new TransactionBuilder(new Account(source.publicKey(), "1"), {
      fee: "100",
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(Operation.accountMerge({ destination: payer.publicKey() }))
      .setTimeout(300)
      .build()
      .toXDR();
    const result = await issueRefund(
      "https://horizon-testnet.stellar.org",
      network.data,
      source.publicKey(),
      unsupported,
    );
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.error.message).toMatch(/support exactly one payment/i);
  });
});
