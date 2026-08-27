import type { ExportedTransaction } from "../transaction/exportTransactionHistory";

export interface BalanceForecastTransaction {
  date: string | Date;
  amount: number | string;
  direction?: "in" | "out";
  sourceAccount?: string;
  destination?: string;
  asset?: string;
  status?: "success" | "failed";
}

export interface BalanceForecastOptions {
  account?: string;
  currentBalance: number | string;
  forecastDays?: number;
  historyDays?: number;
  asset?: string;
  now?: Date;
  minimumSamples?: number;
}

export interface BalanceForecastPoint {
  date: string;
  projectedBalance: string;
  projectedNetChange: string;
}

export interface BalanceForecastResult {
  startingBalance: string;
  averageDailyInflow: string;
  averageDailyOutflow: string;
  averageDailyNetChange: string;
  historicalDays: number;
  sampleCount: number;
  confidence: "low" | "medium" | "high";
  projections: BalanceForecastPoint[];
}

function toNumber(value: number | string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid numeric amount: ${String(value)}`);
  return parsed;
}

function timestamp(value: string | Date): number {
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid transaction date: ${String(value)}`);
  return parsed;
}

function decimals(value: number): string {
  return value.toFixed(7).replace(/0+$/, "").replace(/\.$/, "") || "0";
}

function directionOf(transaction: BalanceForecastTransaction, account?: string): "in" | "out" | null {
  if (transaction.direction) return transaction.direction;
  if (!account) return null;
  if (transaction.destination === account) return "in";
  if (transaction.sourceAccount === account) return "out";
  return null;
}

/**
 * Forecast future balances from successful historical transaction activity.
 * The model is intentionally transparent: the mean daily inflow and outflow
 * over the selected history window are carried forward for each forecast day.
 */
export function forecastBalance(
  transactions: BalanceForecastTransaction[] | ExportedTransaction[],
  options: BalanceForecastOptions,
): BalanceForecastResult {
  const now = options.now ?? new Date();
  const forecastDays = Math.max(1, Math.floor(options.forecastDays ?? 30));
  const historyDays = Math.max(1, Math.floor(options.historyDays ?? 30));
  const minimumSamples = Math.max(1, Math.floor(options.minimumSamples ?? 5));
  const start = now.getTime() - historyDays * 86_400_000;
  const asset = options.asset?.toUpperCase();
  let inflow = 0;
  let outflow = 0;
  let sampleCount = 0;

  for (const transaction of transactions) {
    if (transaction.status === "failed" || timestamp(transaction.date) < start) continue;
    if (asset && transaction.asset?.toUpperCase() !== asset) continue;
    const direction = directionOf(transaction, options.account);
    if (!direction) continue;
    const amount = Math.abs(toNumber(transaction.amount));
    if (direction === "in") inflow += amount;
    else outflow += amount;
    sampleCount += 1;
  }

  const dailyInflow = inflow / historyDays;
  const dailyOutflow = outflow / historyDays;
  const dailyNet = dailyInflow - dailyOutflow;
  let balance = toNumber(options.currentBalance);
  const projections: BalanceForecastPoint[] = [];

  for (let day = 1; day <= forecastDays; day += 1) {
    balance += dailyNet;
    projections.push({
      date: new Date(now.getTime() + day * 86_400_000).toISOString(),
      projectedBalance: decimals(balance),
      projectedNetChange: decimals(dailyNet * day),
    });
  }

  return {
    startingBalance: decimals(toNumber(options.currentBalance)),
    averageDailyInflow: decimals(dailyInflow),
    averageDailyOutflow: decimals(dailyOutflow),
    averageDailyNetChange: decimals(dailyNet),
    historicalDays: historyDays,
    sampleCount,
    confidence: sampleCount >= minimumSamples * 4 ? "high" : sampleCount >= minimumSamples ? "medium" : "low",
    projections,
  };
}

export const forecastAccountBalance = forecastBalance;
