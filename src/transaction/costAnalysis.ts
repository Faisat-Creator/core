import type { TransactionResult } from "./types";
import { err, ok, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";

export interface TransactionCostRecord extends TransactionResult {
  operationTypes?: string[];
  operationCount?: number;
  feeCharged?: string;
}

export interface TransactionCostAnalysis {
  transactionCount: number;
  analyzedCount: number;
  totalFee: string;
  averageFee: string;
  byOperation: Record<string, { transactionCount: number; fee: string }>;
  missingFeeCount: number;
}

export interface CostSummary {
  from: string;
  to: string;
  transactionCount: number;
  totalFee: string;
  averageFee: string;
  missingFeeCount: number;
}

export interface PlannedOperation {
  type: string;
  count: number;
  feePerOperation?: string;
  operationsPerTransaction?: number;
}

export interface CostForecast {
  plannedTransactions: number;
  projectedFee: string;
  averageFeePerTransaction: string;
  budget?: string;
  overBudget: boolean;
  warning?: string;
}

const asNonNegativeBigInt = (value: unknown): bigint | null => {
  if (typeof value !== "string" && typeof value !== "number") return null;
  if (!/^(?:0|[1-9]\d*)$/.test(String(value))) return null;
  return BigInt(String(value));
};

const toNumberString = (value: bigint): string => value.toString();

function feeOf(record: TransactionCostRecord): bigint | null {
  return asNonNegativeBigInt(record.feeCharged ?? record.fee);
}

export function analyzeTransactionCosts(
  transactions: TransactionCostRecord[],
): TransactionCostAnalysis {
  const byOperation: TransactionCostAnalysis["byOperation"] = {};
  let total = 0n;
  let analyzedCount = 0;
  let missingFeeCount = 0;

  for (const transaction of transactions) {
    const fee = feeOf(transaction);
    if (fee === null) {
      missingFeeCount += 1;
      continue;
    }
    total += fee;
    analyzedCount += 1;
    const types = transaction.operationTypes?.length ? transaction.operationTypes : ["unknown"];
    for (const type of types) {
      const entry = byOperation[type] ?? { transactionCount: 0, fee: "0" };
      entry.transactionCount += 1;
      entry.fee = toNumberString(BigInt(entry.fee) + fee / BigInt(types.length));
      byOperation[type] = entry;
    }
  }

  return {
    transactionCount: transactions.length,
    analyzedCount,
    totalFee: toNumberString(total),
    averageFee: analyzedCount ? toNumberString(total / BigInt(analyzedCount)) : "0",
    byOperation,
    missingFeeCount,
  };
}

export function summarizeTransactionCosts(
  transactions: TransactionCostRecord[],
  range: { from: Date | string; to: Date | string },
): CostSummary {
  const from = new Date(range.from);
  const to = new Date(range.to);
  const selected = transactions.filter((transaction) => {
    const created = transaction.createdAt ? new Date(transaction.createdAt) : null;
    return created !== null && !Number.isNaN(created.valueOf()) && created >= from && created <= to;
  });
  const analysis = analyzeTransactionCosts(selected);
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    transactionCount: analysis.transactionCount,
    totalFee: analysis.totalFee,
    averageFee: analysis.averageFee,
    missingFeeCount: analysis.missingFeeCount,
  };
}

export function forecastTransactionCosts(
  planned: PlannedOperation[],
  options: { averageFeePerTransaction?: string; budget?: string } = {},
): SorokitResult<CostForecast> {
  if (planned.some((item) => !Number.isInteger(item.count) || item.count < 0)) {
    return err(SorokitErrorCode.INVALID_CONFIG, "Planned operation counts must be non-negative integers.");
  }
  const plannedTransactions = planned.reduce((sum, item) => sum + item.count, 0);
  const defaultFee = asNonNegativeBigInt(options.averageFeePerTransaction ?? "100") ?? 100n;
  let projected = 0n;
  for (const item of planned) {
    const fee = asNonNegativeBigInt(item.feePerOperation) ?? defaultFee;
    projected += fee * BigInt(item.count);
  }
  const budget = options.budget === undefined ? undefined : asNonNegativeBigInt(options.budget);
  if (options.budget !== undefined && budget === null) {
    return err(SorokitErrorCode.INVALID_CONFIG, "Budget must be a non-negative integer string.");
  }
  const normalizedBudget = budget === null ? undefined : budget;
  const overBudget = normalizedBudget !== undefined && projected > normalizedBudget;
  const forecast: CostForecast = {
    plannedTransactions,
    projectedFee: toNumberString(projected),
    averageFeePerTransaction: plannedTransactions ? toNumberString(projected / BigInt(plannedTransactions)) : "0",
    overBudget,
  };
  if (normalizedBudget !== undefined) forecast.budget = toNumberString(normalizedBudget);
  if (overBudget) forecast.warning = "Projected transaction costs exceed the configured budget.";
  return ok(forecast);
}
