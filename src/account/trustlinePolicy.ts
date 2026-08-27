import { StrKey } from "@stellar/stellar-sdk";
import type { ResolvedNetworkConfig } from "../shared/types";
import { err, ok, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import {
  buildBulkTrustlineTransaction,
  getBulkTrustlines,
} from "../transaction/buildTransaction";
import type { TrustlineParams } from "../transaction/types";

export interface TrustlineApprovalPolicy {
  /** Issuer rules. An omitted assets list trusts every valid asset from the issuer. */
  issuers?: Record<string, { assets?: string[] }>;
  /** Exact asset rules, keyed by `CODE:ISSUER`. */
  assets?: Array<{ code: string; issuer: string }>;
}

export interface TrustlineApprovalDecision {
  approved: boolean;
  reason: "approved" | "manual-workflow" | "unapproved-issuer" | "unapproved-asset";
}

export interface ApprovedTrustlineBuild {
  xdr: string | null;
  approved: TrustlineParams[];
  skippedExisting: TrustlineParams[];
  skippedDuplicates: TrustlineParams[];
}

function assetKey(code: string, issuer: string): string {
  return `${code.toUpperCase()}:${issuer}`;
}

function isValidCode(code: unknown): code is string {
  return typeof code === "string" && /^[A-Z0-9]{1,12}$/i.test(code);
}

function isValidIssuer(issuer: unknown): issuer is string {
  return typeof issuer === "string" && StrKey.isValidEd25519PublicKey(issuer);
}

export function evaluateTrustlineApproval(
  asset: { code: string; issuer: string },
  policy?: TrustlineApprovalPolicy,
): SorokitResult<TrustlineApprovalDecision> {
  if (!isValidCode(asset.code) || !isValidIssuer(asset.issuer)) {
    return err(SorokitErrorCode.INVALID_CONFIG, "Trustline asset code or issuer is malformed.");
  }
  if (!policy) return ok({ approved: false, reason: "manual-workflow" });

  const issuerRule = policy.issuers?.[asset.issuer];
  const exactRule = policy.assets?.some(
    (candidate) => candidate.issuer === asset.issuer && candidate.code.toUpperCase() === asset.code.toUpperCase(),
  );
  if (exactRule || (issuerRule !== undefined && issuerRule.assets === undefined)) {
    return ok({ approved: true, reason: "approved" });
  }
  if (issuerRule) return ok({ approved: false, reason: "unapproved-asset" });
  return ok({ approved: false, reason: "unapproved-issuer" });
}

export async function buildApprovedTrustlineTransaction(
  horizonUrl: string,
  networkConfig: ResolvedNetworkConfig,
  sourcePublicKey: string,
  assets: TrustlineParams[],
  options: { policy?: TrustlineApprovalPolicy; sequenceNumber?: string } = {},
): Promise<SorokitResult<ApprovedTrustlineBuild>> {
  if (assets.length === 0) {
    return err(SorokitErrorCode.TX_BUILD_FAILED, "At least one trustline asset is required.");
  }

  const approved: TrustlineParams[] = [];
  const skippedDuplicates: TrustlineParams[] = [];
  const seen = new Set<string>();
  for (const asset of assets) {
    const decision = evaluateTrustlineApproval(
      { code: asset.assetCode, issuer: asset.assetIssuer },
      options.policy,
    );
    if (decision.status === "error") return decision;
    if (!decision.data.approved) {
      return err(
        SorokitErrorCode.INVALID_CONFIG,
        `Trustline asset ${asset.assetCode}:${asset.assetIssuer} is not approved by policy.`,
      );
    }
    const key = assetKey(asset.assetCode, asset.assetIssuer);
    if (seen.has(key)) {
      skippedDuplicates.push(asset);
      continue;
    }
    seen.add(key);
    approved.push(asset);
  }

  const states = await getBulkTrustlines(
    horizonUrl,
    sourcePublicKey,
    approved.map((asset) => ({ code: asset.assetCode, issuer: asset.assetIssuer })),
  );
  if (states.status === "error") return states;
  const existingKeys = new Set(
    states.data.filter((state) => state.exists).map((state) => assetKey(state.assetCode, state.assetIssuer ?? "")),
  );
  const skippedExisting = approved.filter((asset) => existingKeys.has(assetKey(asset.assetCode, asset.assetIssuer)));
  const pending = approved.filter((asset) => !existingKeys.has(assetKey(asset.assetCode, asset.assetIssuer)));

  if (pending.length === 0) {
    return ok({ xdr: null, approved: [], skippedExisting, skippedDuplicates });
  }
  const built = await buildBulkTrustlineTransaction(
    horizonUrl,
    networkConfig,
    sourcePublicKey,
    pending.map((asset) => ({
      code: asset.assetCode,
      issuer: asset.assetIssuer,
      ...(asset.limit !== undefined ? { limit: asset.limit } : {}),
    })),
    options.sequenceNumber ? { sequenceNumber: options.sequenceNumber } : undefined,
  );
  if (built.status === "error") return built;
  return ok({ xdr: built.data, approved: pending, skippedExisting, skippedDuplicates });
}
