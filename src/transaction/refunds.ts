import { Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { buildPaymentTransaction, buildReverseTransaction } from "./buildTransaction";
import type { PaymentParams, ReverseTransactionParams } from "./types";
import type { ResolvedNetworkConfig } from "../shared/types";
import { err, ok, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { isXdrInvalidError } from "../shared/errors";

export interface RefundParams extends Omit<ReverseTransactionParams, "fee"> {
  /** Refund amount; omitted to refund the full original payment amount. */
  amount?: string;
  /** Required when the original payment source cannot be inferred safely. */
  destination?: string;
  fee?: string;
  memo?: string;
}

export interface RefundDetails {
  destination: string;
  amount: string;
  assetCode?: string;
  assetIssuer?: string;
  partial: boolean;
  originalXdr: string;
}

function decimalToUnits(value: string): bigint | null {
  if (!/^\d+(?:\.\d{1,7})?$/.test(value)) return null;
  const parts = value.split(".");
  const whole = parts[0];
  const fraction = parts[1] ?? "";
  if (whole === undefined) return null;
  return BigInt(whole) * 10_000_000n + BigInt(fraction.padEnd(7, "0"));
}

function paymentDetails(
  networkConfig: ResolvedNetworkConfig,
  originalXdr: string,
): SorokitResult<{ payment: Operation.Payment; transaction: ReturnType<typeof TransactionBuilder.fromXDR> }> {
  if (isXdrInvalidError(originalXdr)) {
    return err(SorokitErrorCode.TX_BUILD_FAILED, "The original transaction XDR is malformed.");
  }
  try {
    const transaction = TransactionBuilder.fromXDR(originalXdr, networkConfig.networkPassphrase);
    const operations = transaction.operations;
    if (operations.length !== 1 || operations[0]?.type !== "payment") {
      return err(
        SorokitErrorCode.TX_BUILD_FAILED,
        "Refunds currently support exactly one payment operation; provide explicit reversal parameters for other transaction types.",
      );
    }
    return ok({ payment: operations[0] as Operation.Payment, transaction });
  } catch (cause) {
    return err(SorokitErrorCode.TX_BUILD_FAILED, "Unable to inspect the original transaction.", cause);
  }
}

export async function reverseTransaction(
  horizonUrl: string,
  networkConfig: ResolvedNetworkConfig,
  sourcePublicKey: string,
  originalXdr: string,
  params?: ReverseTransactionParams,
): Promise<SorokitResult<string>> {
  return buildReverseTransaction(horizonUrl, networkConfig, sourcePublicKey, originalXdr, params);
}

export async function issueRefund(
  horizonUrl: string,
  networkConfig: ResolvedNetworkConfig,
  sourcePublicKey: string,
  originalXdr: string,
  params: RefundParams = {},
): Promise<SorokitResult<RefundDetails & { xdr: string }>> {
  const details = paymentDetails(networkConfig, originalXdr);
  if (details.status === "error") return details;
  const { payment } = details.data;
  const destination = params.destination ?? payment.source;
  if (!destination) {
    return err(
      SorokitErrorCode.INVALID_ADDRESS,
      "Refund destination is ambiguous; provide an explicit destination confirmation.",
    );
  }

  const originalAmount = decimalToUnits(payment.amount);
  const refundAmount = decimalToUnits(params.amount ?? payment.amount);
  if (originalAmount === null || refundAmount === null || refundAmount <= 0n) {
    return err(SorokitErrorCode.TX_BUILD_FAILED, "Original and refund amounts must be positive decimal amounts.");
  }
  if (refundAmount > originalAmount) {
    return err(SorokitErrorCode.TX_BUILD_FAILED, "Refund amount cannot exceed the original payment amount.");
  }

  const asset = payment.asset;
  const paymentParams: PaymentParams = {
    destination,
    amount: params.amount ?? payment.amount,
  };
  if (!asset.isNative()) {
    paymentParams.assetCode = asset.getCode();
    paymentParams.assetIssuer = asset.getIssuer();
  }
  if (params.memo !== undefined) paymentParams.memo = params.memo;
  if (params.sequenceNumber !== undefined) paymentParams.sequenceNumber = params.sequenceNumber;
  if (params.estimatedFee !== undefined) paymentParams.estimatedFee = params.estimatedFee;
  const built = await buildPaymentTransaction(
    horizonUrl,
    networkConfig,
    sourcePublicKey,
    paymentParams,
  );
  if (built.status === "error") return built;
  const result: RefundDetails & { xdr: string } = {
    xdr: built.data,
    destination,
    amount: paymentParams.amount,
    partial: refundAmount < originalAmount,
    originalXdr,
  };
  if (paymentParams.assetCode !== undefined) result.assetCode = paymentParams.assetCode;
  if (paymentParams.assetIssuer !== undefined) result.assetIssuer = paymentParams.assetIssuer;
  return ok(result);
}
