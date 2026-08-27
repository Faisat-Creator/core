import { Address, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import { createHash } from "crypto";
import type { SorokitCache } from "../shared/cache";

export interface ContractCallIdentity {
  contractId: string;
  method: string;
  argsXdr: string;
}

export function createContractCallHash(
  contractId: string,
  method: string,
  argsXdr: string,
): string {
  return createHash("sha256").update(contractId + method + argsXdr).digest("hex");
}

export function serializeContractArgs(
  args?: Array<xdr.ScVal | unknown>,
): string {
  try {
    return (
      args
        ?.map((arg) => {
          if (!arg || typeof arg !== "object" || typeof (arg as xdr.ScVal).toXDR !== "function") {
            throw new Error("Argument cannot be serialized to XDR");
          }
          return (arg as xdr.ScVal).toXDR("base64");
        })
        .join("") ?? ""
    );
  } catch {
    return args ? JSON.stringify(args) : "";
  }
}

export function createContractReadCacheKey(
  contractId: string,
  method: string,
  args?: Array<xdr.ScVal | unknown>,
  revision = 0,
  networkContext = "",
): string {
  const argsXdr = serializeContractArgs(args);
  const hash = createHash("sha256")
    .update(`${networkContext}\0${contractId}\0${method}\0${argsXdr}`)
    .digest("hex");
  return `sorokit:contract-read:${contractId}:r${revision}:${hash}`;
}

export function invalidateContractReadCache(
  cache: SorokitCache,
  contractId: string,
  method: string,
  args?: Array<xdr.ScVal | unknown>,
  revision = 0,
  networkContext = "",
): void {
  cache.invalidate(createContractReadCacheKey(contractId, method, args, revision, networkContext));
}

export function createSimulationCacheKey(
  transactionXdr: string,
  networkPassphrase: string,
): string | undefined {
  const identity = extractContractCallIdentity(transactionXdr, networkPassphrase);
  if (!identity) return undefined;

  return `sorokit:simulate:${createContractCallHash(identity.contractId, identity.method, identity.argsXdr)}`;
}

export function extractContractCallIdentity(
  transactionXdr: string,
  networkPassphrase: string,
): ContractCallIdentity | undefined {
  try {
    const tx = TransactionBuilder.fromXDR(transactionXdr, networkPassphrase);
    if (!("operations" in tx)) return undefined;

    const op = tx.operations.find((operation) => operation.type === "invokeHostFunction");
    if (!op) return undefined;

    const hostFn = (op as { func?: { arm?: () => string; invokeContract?: () => {
      contractAddress: () => unknown;
      functionName: () => { toString: (encoding?: string) => string };
      args: () => Array<{ toXDR: (format: string) => string }>;
    } } }).func;
    if (!hostFn || hostFn.arm?.() !== "invokeContract" || !hostFn.invokeContract) {
      return undefined;
    }

    const invokeArgs = hostFn.invokeContract();
    const scAddr = invokeArgs.contractAddress();
    const contractId = Address.fromScAddress(scAddr as Parameters<typeof Address.fromScAddress>[0]).toString();
    const method = invokeArgs.functionName().toString("utf8");
    const argsXdr = invokeArgs.args().map((arg) => arg.toXDR("base64")).join("");

    return { contractId, method, argsXdr };
  } catch {
    return undefined;
  }
}
