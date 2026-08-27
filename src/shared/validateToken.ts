import { err, SorokitErrorCode } from "./response";
import type { SorokitResult } from "./response";

/**
 * Represents a token asset with code and optional issuer.
 */
export interface TokenAsset {
  code: string;
  issuer: string | null;
}

/**
 * Validate that an asset code is a non-empty string.
 */
export function validateAssetCode(code: string): SorokitResult<void> {
  if (!code || typeof code !== "string" || code.trim().length === 0) {
    return err(SorokitErrorCode.INVALID_CONFIG, "Asset code must be a non-empty string");
  }
  return { status: "ok", data: undefined, error: null };
}

/**
 * Validate that an asset issuer is either null (native) or a valid string.
 */
export function validateAssetIssuer(
  issuer: string | null,
): SorokitResult<void> {
  if (issuer !== null && (typeof issuer !== "string" || issuer.length === 0)) {
    return err(
      SorokitErrorCode.INVALID_CONFIG,
      "Asset issuer must be null (native) or a non-empty string",
    );
  }
  return { status: "ok", data: undefined, error: null };
}

/**
 * Validate a token asset (code + issuer combination).
 */
export function validateTokenAsset(asset: TokenAsset): SorokitResult<void> {
  const codeResult = validateAssetCode(asset.code);
  if (codeResult.status === "error") return codeResult;

  const issuerResult = validateAssetIssuer(asset.issuer);
  if (issuerResult.status === "error") return issuerResult;

  return { status: "ok", data: undefined, error: null };
}

/**
 * Check if two token assets are the same.
 */
export function isSameAsset(asset1: TokenAsset, asset2: TokenAsset): boolean {
  return asset1.code === asset2.code && asset1.issuer === asset2.issuer;
}

/**
 * Generate a consistent pair ID from two assets (sorted alphabetically by code).
 */
export function normalizePairId(
  asset1: TokenAsset,
  asset2: TokenAsset,
): string {
  const [first, second]: [TokenAsset, TokenAsset] =
    asset1.code.localeCompare(asset2.code) <= 0
      ? [asset1, asset2]
      : [asset2, asset1];
  return `${first.code}/${second.code}`;
}
