import { ok } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { err, SorokitErrorCode } from "../shared/response";
import type { AssetBalance } from "./types";
import { getAccount } from "./getAccount";
import { validateIssuer } from "../shared/validateIssuer";
import { StrKey } from "@stellar/stellar-sdk";

/**
 * Filter criteria for getAssetBalances().
 * All fields are optional — omitting all returns every balance.
 */
export interface AssetBalanceFilter {
  /**
   * Return only balances matching this asset code.
   * Case-insensitive. Use "XLM" for native.
   */
  assetCode?: string;
  /**
   * Return only balances matching this issuer.
   * Ignored for native (XLM) balances.
   */
  assetIssuer?: string;
  /**
   * Return only balances of the given asset type(s).
   */
  assetType?: AssetBalance["assetType"] | AssetBalance["assetType"][];
  /**
   * Exclude zero balances. Default: false.
   */
  excludeZero?: boolean;
}

/**
 * Fetch balances for an account, with optional filtering by asset code,
 * issuer, type, or zero-balance exclusion.
 *
 * Returns the full `AssetBalance` shape — same as `getBalances()` but filterable.
 * When `trustedIssuers` is provided every non-native balance issuer is validated
 * against the list and `TX_BUILD_FAILED` is returned if any issuer is untrusted.
 *
 * @param horizonUrl     - Base URL of the Horizon server.
 * @param publicKey      - Stellar G-address of the account.
 * @param filter         - Optional filter criteria. Omit to return all balances.
 * @param trustedIssuers - Optional whitelist of trusted issuer G-addresses.
 * @returns `ok(AssetBalance[])` on success, or an `error` SorokitResult on failure.
 *
 * @example
 * // All non-zero balances
 * const result = await getAssetBalances(horizonUrl, publicKey, { excludeZero: true });
 *
 * @example
 * // A specific issued asset
 * const result = await getAssetBalances(horizonUrl, publicKey, {
 *   assetCode: "USDC",
 *   assetIssuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
 * });
 */
export async function getAssetBalances(
  horizonUrl: string,
  publicKey: string,
  filter?: AssetBalanceFilter,
  trustedIssuers?: string[] | null,
  options?: { signal?: AbortSignal | undefined },
): Promise<SorokitResult<AssetBalance[]>> {
  // Validate issuer format before making any API call
  if (filter?.assetIssuer !== undefined && filter.assetIssuer !== null && filter.assetIssuer !== "") {
    if (!StrKey.isValidEd25519PublicKey(filter.assetIssuer)) {
      return err(
        SorokitErrorCode.ACCOUNT_FETCH_FAILED,
        `Invalid asset issuer address format: "${filter.assetIssuer}"`,
      );
    }
  }

  const result = await getAccount(horizonUrl, publicKey, options);
  if (result.status === "error") return result;

  let balances = result.data.balances;

  // Validate issuers against whitelist if configured
  if (trustedIssuers !== null && trustedIssuers !== undefined && trustedIssuers.length > 0) {
    for (const balance of balances) {
      // Skip native asset validation — only validate issued assets
      if (balance.assetIssuer !== null) {
        try {
          validateIssuer(balance.assetIssuer, trustedIssuers);
        } catch (cause: unknown) {
          return err(
            ((cause as any)?.code || SorokitErrorCode.TX_BUILD_FAILED) as SorokitErrorCode,
            (cause as Error)?.message || String(cause),
            cause,
          );
        }
      }
    }
  }

  if (!filter) return ok(balances);

  const { assetCode, assetIssuer, assetType, excludeZero } = filter;

  if (assetCode !== undefined) {
    const code = assetCode.toUpperCase();
    balances = balances.filter((b) => b.assetCode.toUpperCase() === code);
  }

  if (assetIssuer !== undefined) {
    balances = balances.filter(
      (b) => b.assetIssuer !== null && b.assetIssuer === assetIssuer,
    );
  }

  if (assetType !== undefined) {
    const types = Array.isArray(assetType) ? assetType : [assetType];
    balances = balances.filter((b) => types.includes(b.assetType));
  }

  if (excludeZero) {
    balances = balances.filter((b) => b.balanceFloat > 0);
  }

  return ok(balances);
}
