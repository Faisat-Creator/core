/**
 * Soroban module public types.
 */
import type { xdr } from "@stellar/stellar-sdk";
import type { ContractStateTracker } from "./contractStateTracker";
export type { ContractStateTracker };
import {
  DEFAULT_POLL_MAX_ATTEMPTS,
  DEFAULT_POLL_INTERVAL_MS,
} from "../shared/constants";

export interface ContractMethodInput {
  name: string;
  type: string;
}

export interface ContractAbiField {
  name: string;
  type: string | ContractAbiTypeDescriptor;
}

export interface ContractAbiTypeDescriptor {
  type: string;
  valueType?: string | ContractAbiTypeDescriptor;
  keyType?: string | ContractAbiTypeDescriptor;
  elementType?: string | ContractAbiTypeDescriptor;
  fields?: ContractAbiField[];
  variants?: ContractAbiField[];
}

/**
 * Visibility level of a contract method.
 * - "public"   — callable by any account
 * - "private"  — callable only from within the contract
 * - "admin"    — callable only by designated admin accounts
 * - "restricted" — callable only by accounts meeting authorization requirements
 */
export type ContractMethodVisibility =
  | "public"
  | "private"
  | "admin"
  | "restricted";

/**
 * Authorization requirements for a contract method.
 * When present, `prepareCall()` validates that the invoking account
 * satisfies these requirements before constructing the invocation.
 */
export interface ContractAuthorizationRequirement {
  /** List of public keys authorized to call this method. */
  requiredSigners?: string[];
}

export interface ContractMethod {
  name: string;
  inputs: ContractMethodInput[];
  returnType: string | null;
  /**
   * Optional visibility declaration. When absent, the method is treated as
   * callable — existing contracts that do not expose visibility metadata
   * remain compatible with the current behavior.
   */
  visibility?: ContractMethodVisibility;
  /**
   * Optional authorization requirements. Validated against the invoking
   * public key when available. Not exposed in error messages to avoid
   * leaking sensitive authorization data.
   */
  authorizationRequirements?: ContractAuthorizationRequirement;
}

export interface ContractAbiMethod {
  name: string;
  args: unknown[];
  returns?: unknown;
}

export interface ContractAbiObject {
  methods: ContractAbiMethod[];
}

export interface ContractAbiFunctionObject {
  functions: ContractAbiMethod[];
}

export interface ContractAbiSpec {
  funcs(): xdr.ScSpecFunctionV0[];
}

export type ContractAbi =
  | ContractAbiObject
  | ContractAbiFunctionObject
  | ContractAbiSpec
  | xdr.ScSpecFunctionV0[];

export interface ContractInvokeParams {
  contractId: string;
  method: string;
  args?: xdr.ScVal[];
  cachedMetadata?: ContractMethod[];
  /** Optional ABI used to validate method name and argument count before simulation */
  contractAbi?: ContractAbi;
  /** Optional tracker for cache invalidation based on contract state changes */
  stateTracker?: ContractStateTracker;
  /** Public key of the invoking account */
  publicKey: string;
}

export interface ContractReadParams {
  contractId: string;
  method: string;
  args?: xdr.ScVal[];
  cachedMetadata?: ContractMethod[];
  /** Optional ABI used to validate method name and argument count before simulation */
  contractAbi?: ContractAbi;
  /**
   * Public key of a funded account to use as the simulation source.
   * Required — the Soroban RPC needs a real account to simulate against.
   */
  publicKey: string;
  /** Optional cache for contract read results */
  cache?: import("../shared/cache").SorokitCache;
  /** Bypass cache lookup, deduplication, and writes for this request */
  bypassCache?: boolean;
  /** Optional tracker for cache invalidation based on contract state changes */
  stateTracker?: ContractStateTracker;
  /** Optional TTL for cache entries in milliseconds (default: 5 minutes) */
  ttlMs?: number;
}

export interface ContractCallResult {
  /** Raw ScVal result */
  result: xdr.ScVal;
  /** Convenience: result decoded to a native JS value where possible */
  value: unknown;
}

export interface PreparedContractCall {
  /** XDR-encoded transaction ready for signing */
  transactionXdr: string;
  /** Estimated fee in stroops */
  fee: string;
}

/**
 * Configuration for the polling loop in invokeContract().
 */
export interface SorobanPollConfig {
  /**
   * Maximum number of polling attempts before giving up.
   * @default DEFAULT_POLL_MAX_ATTEMPTS (20)
   */
  maxAttempts?: number;
  /**
   * Milliseconds between polling attempts.
   * @default DEFAULT_POLL_INTERVAL_MS (1500)
   */
  intervalMs?: number;
}

/**
 * Result of a pre-flight transaction simulation.
 * Returned by soroban.simulate() — used for fee estimation and pre-flight checks.
 */
export interface SimulateTransactionResult {
  /** Estimated fee in stroops */
  fee: string;
  /** Whether the simulation succeeded */
  success: boolean;
  /** Error message if simulation failed */
  error?: string;
  /** Detailed ledger resource usage returned by Soroban RPC, when available */
  resourceUsage?: SorobanSimulationResourceUsage;
  /** Fee components derived from the RPC simulation response */
  feeBreakdown?: SorobanSimulationFeeBreakdown;
}

export interface SorobanSimulationResourceUsage {
  instructions?: string;
  readBytes?: number;
  writeBytes?: number;
  readLedgerEntries?: number;
  writeLedgerEntries?: number;
  footprint?: {
    readOnly?: number;
    readWrite?: number;
  };
}

export interface SorobanSimulationFeeBreakdown {
  minResourceFee: string;
  refundableFee?: string;
  nonRefundableFee?: string;
  total?: string;
}

/** A single contract invocation in a batch. */
export interface BatchContractInvocation {
  contractId: string;
  method: string;
  args?: xdr.ScVal[];
  publicKey: string;
  cachedMetadata?: ContractMethod[];
  contractAbi?: ContractAbi;
  stateTracker?: ContractStateTracker;
}

/** Result for one invocation within a batch — preserves contractId and method for correlation. */
export type BatchContractResult =
  | { status: "ok"; data: string; contractId: string; method: string }
  | {
      status: "error";
      error: { code: string; message: string };
      contractId: string;
      method: string;
    };

export type ContractResultType =
  | "bool"
  | "u32"
  | "i32"
  | "u64"
  | "i64"
  | "u128"
  | "i128"
  | "string"
  | "symbol"
  | "bytes"
  | "void"
  | "vec"
  | "map"
  | "address";

export interface ParsedContractResult {
  type: string;
  value: unknown;
}
