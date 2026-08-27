export interface ContractStorageEntry {
  key: unknown;
  value: unknown;
  /** Optional ledger-entry byte size when supplied by the RPC provider. */
  sizeBytes?: number;
  durability?: "temporary" | "persistent";
}

export interface StorageAnalysisOptions {
  largeValueBytes?: number;
  repeatedValueThreshold?: number;
  contractId?: string;
}

export interface StorageEntryReport {
  key: string;
  sizeBytes: number;
  durability?: ContractStorageEntry["durability"];
  repeatedValueCount: number;
  unusuallyLarge: boolean;
}

export interface StorageRecommendation {
  code: "large-value" | "repeated-value" | "temporary-entry";
  severity: "info" | "warning";
  message: string;
  keys: string[];
}

export interface StorageAnalysisReport {
  contractId?: string;
  entryCount: number;
  totalSizeBytes: number;
  averageSizeBytes: number;
  largestEntry?: StorageEntryReport;
  repeatedValueGroups: Array<{ fingerprint: string; count: number; keys: string[] }>;
  entries: StorageEntryReport[];
  recommendations: StorageRecommendation[];
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(",")}}`;
}

function encodedSize(value: unknown): number {
  return new TextEncoder().encode(stableSerialize(value)).byteLength;
}

function displayKey(key: unknown): string {
  return typeof key === "string" ? key : stableSerialize(key);
}

/** Analyze RPC-provided contract storage entries without mutating chain state. */
export function analyzeContractStorage(
  entries: ContractStorageEntry[],
  options: StorageAnalysisOptions = {},
): StorageAnalysisReport {
  const largeValueBytes = options.largeValueBytes ?? 1024;
  const repeatedValueThreshold = Math.max(2, options.repeatedValueThreshold ?? 3);
  const groups = new Map<string, string[]>();
  const reports = entries.map((entry) => {
    const key = displayKey(entry.key);
    const fingerprint = stableSerialize(entry.value);
    const keys = groups.get(fingerprint) ?? [];
    keys.push(key);
    groups.set(fingerprint, keys);
    const sizeBytes = entry.sizeBytes ?? encodedSize(entry.value);
    return { key, sizeBytes, durability: entry.durability, repeatedValueCount: 0, unusuallyLarge: sizeBytes >= largeValueBytes };
  });

  const repeatedValueGroups = Array.from(groups.entries())
    .filter(([, keys]) => keys.length >= repeatedValueThreshold)
    .map(([fingerprint, keys]) => ({ fingerprint, count: keys.length, keys }));
  const repeatedByKey = new Map(repeatedValueGroups.flatMap((group) => group.keys.map((key) => [key, group.count] as const)));
  for (const report of reports) report.repeatedValueCount = repeatedByKey.get(report.key) ?? 1;

  const recommendations: StorageRecommendation[] = [];
  const largeKeys = reports.filter((entry) => entry.unusuallyLarge).map((entry) => entry.key);
  if (largeKeys.length) recommendations.push({ code: "large-value", severity: "warning", message: "Large values can increase read/write and rent costs; consider packing only required fields or splitting infrequently used data.", keys: largeKeys });
  for (const group of repeatedValueGroups) recommendations.push({ code: "repeated-value", severity: "info", message: "The same value is stored under multiple keys; consider normalization or a shared reference where contract semantics allow it.", keys: group.keys });
  const temporaryKeys = reports.filter((entry) => entry.durability === "temporary").map((entry) => entry.key);
  if (temporaryKeys.length) recommendations.push({ code: "temporary-entry", severity: "info", message: "Temporary entries should be reviewed for suitable expiration and lifecycle cleanup.", keys: temporaryKeys });

  const totalSizeBytes = reports.reduce((sum, entry) => sum + entry.sizeBytes, 0);
  const largestEntry = reports.reduce<StorageEntryReport | undefined>(
    (largest, entry) => (!largest || entry.sizeBytes > largest.sizeBytes ? entry : largest),
    undefined,
  );
  return {
    ...(options.contractId !== undefined ? { contractId: options.contractId } : {}),
    entryCount: reports.length,
    totalSizeBytes,
    averageSizeBytes: reports.length ? totalSizeBytes / reports.length : 0,
    ...(largestEntry !== undefined ? { largestEntry } : {}),
    repeatedValueGroups,
    entries: reports,
    recommendations,
  };
}
