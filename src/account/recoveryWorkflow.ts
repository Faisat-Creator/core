import { err, ok, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import { isValidStellarPublicKey, type RecoveryReplacementSigner } from "./keyRotation";

export type RecoveryPermission = "initiate" | "approve" | "cancel";

export interface RecoveryContact {
  address: string;
  permissions: RecoveryPermission[];
}

export interface RecoveryConfig {
  contacts: RecoveryContact[];
  approvalThreshold: number;
  delaySeconds: number;
}

export interface RecoveryRequest {
  id: string;
  account: string;
  replacementSigners: RecoveryReplacementSigner[];
  compromisedKeys: string[];
  createdAt: number;
  executeAfter: number;
  expiresAt: number;
  approvals: string[];
  completedAt?: number;
  status: "pending" | "cancelled" | "completed" | "expired";
}

export interface RecoveryExecutionPlan {
  requestId: string;
  account: string;
  replacementSigners: RecoveryReplacementSigner[];
  compromisedKeys: string[];
  authorizedBy: string[];
}

const invalid = <T>(message: string): SorokitResult<T> =>
  err(SorokitErrorCode.INVALID_ADDRESS, message);

function uniqueContacts(contacts: RecoveryContact[]): boolean {
  return new Set(contacts.map((contact) => contact.address)).size === contacts.length;
}

function hasPermission(config: RecoveryConfig, address: string, permission: RecoveryPermission): boolean {
  return config.contacts.some(
    (contact) => contact.address === address && contact.permissions.includes(permission),
  );
}

export function registerRecoveryContacts(
  contacts: RecoveryContact[],
  approvalThreshold: number,
  delaySeconds: number,
): SorokitResult<RecoveryConfig> {
  if (!Array.isArray(contacts) || contacts.length === 0) {
    return invalid("At least one recovery contact is required.");
  }
  if (!uniqueContacts(contacts)) return invalid("Recovery contacts must be unique.");
  if (!Number.isInteger(approvalThreshold) || approvalThreshold < 1 || approvalThreshold > contacts.length) {
    return err(SorokitErrorCode.INVALID_CONFIG, "Approval threshold must be between 1 and the contact count.");
  }
  if (!Number.isInteger(delaySeconds) || delaySeconds < 0) {
    return err(SorokitErrorCode.INVALID_CONFIG, "Recovery delay must be a non-negative integer.");
  }
  for (const contact of contacts) {
    if (!isValidStellarPublicKey(contact.address)) return invalid(`Invalid recovery contact: ${contact.address}`);
    if (!contact.permissions.length) return err(SorokitErrorCode.INVALID_CONFIG, `Contact ${contact.address} has no permissions.`);
  }
  return ok({
    contacts: contacts.map((contact) => ({ ...contact, permissions: [...new Set(contact.permissions)] })),
    approvalThreshold,
    delaySeconds,
  });
}

/** Alias for applications that call recovery participants guardians. */
export const configureGuardians = registerRecoveryContacts;

export function initiateRecovery(
  config: RecoveryConfig,
  request: Omit<RecoveryRequest, "createdAt" | "executeAfter" | "expiresAt" | "approvals" | "completedAt" | "status">,
  initiator: string,
  now = Date.now(),
): SorokitResult<RecoveryRequest> {
  if (!hasPermission(config, initiator, "initiate")) {
    return err(SorokitErrorCode.WALLET_SIGN_FAILED, "Recovery initiator is not an authorized contact.");
  }
  if (!isValidStellarPublicKey(request.account)) return invalid(`Invalid recovery account: ${request.account}`);
  if (!request.id.trim()) return err(SorokitErrorCode.INVALID_CONFIG, "Recovery request id is required.");
  if (!Array.isArray(request.replacementSigners) || request.replacementSigners.length === 0) {
    return err(SorokitErrorCode.INVALID_CONFIG, "At least one replacement signer is required.");
  }
  const keys = request.replacementSigners.map((signer) => signer.key);
  if (new Set(keys).size !== keys.length || keys.some((key) => !isValidStellarPublicKey(key))) {
    return invalid("Replacement signer keys must be valid and unique.");
  }
  if (request.compromisedKeys.some((key) => !isValidStellarPublicKey(key))) {
    return invalid("Compromised signer keys must be valid Stellar public keys.");
  }
  return ok({
    ...request,
    createdAt: now,
    executeAfter: now + config.delaySeconds * 1000,
    expiresAt: now + config.delaySeconds * 1000 + 7 * 24 * 60 * 60 * 1000,
    approvals: [initiator],
    status: "pending",
  });
}

export function approveRecovery(
  config: RecoveryConfig,
  request: RecoveryRequest,
  guardian: string,
): SorokitResult<RecoveryRequest> {
  if (request.status !== "pending") return err(SorokitErrorCode.TX_SUBMIT_FAILED, "Only pending recovery requests can be approved.");
  if (!hasPermission(config, guardian, "approve")) return err(SorokitErrorCode.WALLET_SIGN_FAILED, "Guardian is not authorized to approve recovery.");
  if (request.approvals.includes(guardian)) return ok(request);
  return ok({ ...request, approvals: [...request.approvals, guardian] });
}

export function cancelRecovery(
  config: RecoveryConfig,
  request: RecoveryRequest,
  guardian: string,
): SorokitResult<RecoveryRequest> {
  if (request.status !== "pending") return err(SorokitErrorCode.TX_SUBMIT_FAILED, "Only pending recovery requests can be cancelled.");
  if (!hasPermission(config, guardian, "cancel")) return err(SorokitErrorCode.WALLET_SIGN_FAILED, "Guardian is not authorized to cancel recovery.");
  return ok({ ...request, status: "cancelled" });
}

export function executeRecovery(
  config: RecoveryConfig,
  request: RecoveryRequest,
  now = Date.now(),
): SorokitResult<RecoveryExecutionPlan> {
  if (request.status !== "pending") return err(SorokitErrorCode.TX_SUBMIT_FAILED, "Recovery request has already been finalized and cannot be replayed.");
  if (now > request.expiresAt) return err(SorokitErrorCode.TX_SUBMIT_FAILED, "Recovery request has expired and must be initiated again.");
  if (now < request.executeAfter) return err(SorokitErrorCode.TX_SUBMIT_FAILED, `Recovery is time-locked until ${new Date(request.executeAfter).toISOString()}.`);
  const approvals = request.approvals.filter((address) => hasPermission(config, address, "approve") || hasPermission(config, address, "initiate"));
  if (new Set(approvals).size < config.approvalThreshold) return err(SorokitErrorCode.WALLET_SIGN_FAILED, `Recovery requires ${config.approvalThreshold} guardian approvals; received ${new Set(approvals).size}.`);
  request.status = "completed";
  request.completedAt = now;
  return ok({
    requestId: request.id,
    account: request.account,
    replacementSigners: request.replacementSigners.map((signer) => ({ ...signer })),
    compromisedKeys: [...request.compromisedKeys],
    authorizedBy: [...new Set(approvals)],
  });
}

export function isRecoveryReady(config: RecoveryConfig, request: RecoveryRequest, now = Date.now()): boolean {
  return request.status === "pending" && now <= request.expiresAt && now >= request.executeAfter &&
    new Set(request.approvals.filter((address) => hasPermission(config, address, "approve") || hasPermission(config, address, "initiate"))).size >= config.approvalThreshold;
}
