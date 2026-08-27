import { Keypair } from "@stellar/stellar-sdk";
import {
  SorokitErrorCategory,
  SorokitErrorCode,
  err,
} from "../shared/response";
import {
  approveRecovery,
  cancelRecovery,
  executeRecovery,
  initiateRecovery,
  isRecoveryReady,
  registerRecoveryContacts,
} from "../account/recoveryWorkflow";

const account = Keypair.random().publicKey();
const guardianOne = Keypair.random().publicKey();
const guardianTwo = Keypair.random().publicKey();
const replacement = Keypair.random().publicKey();

describe("issues #465, #467, and #477", () => {
  it("classifies errors and redacts sensitive context", () => {
    const result = err(
      SorokitErrorCode.NETWORK_ERROR,
      "RPC unavailable",
      undefined,
      undefined,
      {
        context: {
          operation: "readContract",
          parameters: { contractId: "C123", apiKey: "hidden", nested: { token: "hidden" } },
        },
      },
    );
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.category).toBe(SorokitErrorCategory.NETWORK);
      expect(result.error.recovery?.retryable).toBe(true);
      expect(result.error.context?.parameters).toEqual({
        contractId: "C123",
        apiKey: "[REDACTED]",
        nested: { token: "[REDACTED]" },
      });
    }
  });

  it("registers unique guardians and enforces a delayed threshold workflow", () => {
    const configResult = registerRecoveryContacts(
      [
        { address: guardianOne, permissions: ["initiate", "approve", "cancel"] },
        { address: guardianTwo, permissions: ["approve", "cancel"] },
      ],
      2,
      60,
    );
    expect(configResult.status).toBe("ok");
    if (configResult.status !== "ok") return;
    const config = configResult.data;
    const started = initiateRecovery(
      config,
      {
        id: "recovery-1",
        account,
        replacementSigners: [{ key: replacement, weight: 1 }],
        compromisedKeys: [],
      },
      guardianOne,
      1_000,
    );
    expect(started.status).toBe("ok");
    if (started.status !== "ok") return;
    expect(isRecoveryReady(config, started.data, 1_000)).toBe(false);
    expect(executeRecovery(config, started.data, 1_001).status).toBe("error");

    const approved = approveRecovery(config, started.data, guardianTwo);
    expect(approved.status).toBe("ok");
    if (approved.status !== "ok") return;
    expect(isRecoveryReady(config, approved.data, 61_000)).toBe(true);
    const completed = executeRecovery(config, approved.data, 61_000);
    expect(completed.status).toBe("ok");
    expect(approved.data.status).toBe("completed");
    expect(executeRecovery(config, approved.data, 61_001).status).toBe("error");
  });

  it("supports cancellation and rejects invalid guardian configuration", () => {
    const duplicate = registerRecoveryContacts(
      [
        { address: guardianOne, permissions: ["initiate"] },
        { address: guardianOne, permissions: ["approve"] },
      ],
      1,
      0,
    );
    expect(duplicate.status).toBe("error");

    const configResult = registerRecoveryContacts(
      [{ address: guardianOne, permissions: ["initiate", "cancel"] }],
      1,
      0,
    );
    expect(configResult.status).toBe("ok");
    if (configResult.status !== "ok") return;
    const started = initiateRecovery(
      configResult.data,
      { id: "recovery-2", account, replacementSigners: [{ key: replacement, weight: 1 }], compromisedKeys: [] },
      guardianOne,
    );
    expect(started.status).toBe("ok");
    if (started.status !== "ok") return;
    const cancelled = cancelRecovery(configResult.data, started.data, guardianOne);
    expect(cancelled.status).toBe("ok");
    if (cancelled.status === "ok") expect(cancelled.data.status).toBe("cancelled");
  });
});
