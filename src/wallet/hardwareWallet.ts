import { err, SorokitErrorCode } from "../shared/response";
import type { SorokitResult } from "../shared/response";
import type { SignTransactionInput } from "./types";

export interface HardwareWalletDevice {
  id: string;
  name?: string;
  model?: string;
}

export interface HardwareWalletCapabilities {
  signTransaction: boolean;
  getPublicKey: boolean;
  supportsBlindSigning?: boolean;
  supportsContractData?: boolean;
  provider?: string;
}

/** Provider adapter contract; device communication stays outside Sorokit core. */
export interface HardwareWalletAdapter {
  readonly provider: string;
  discoverDevices(): Promise<SorokitResult<HardwareWalletDevice[]>>;
  getPublicKey(device: HardwareWalletDevice): Promise<SorokitResult<string>>;
  signTransaction(device: HardwareWalletDevice, input: SignTransactionInput): Promise<SorokitResult<string>>;
  getCapabilities?(device?: HardwareWalletDevice): HardwareWalletCapabilities;
}

export async function discoverHardwareWallets(
  adapter: HardwareWalletAdapter,
): Promise<SorokitResult<HardwareWalletDevice[]>> {
  try {
    return await adapter.discoverDevices();
  } catch (cause) {
    return err(SorokitErrorCode.WALLET_NOT_FOUND, `Unable to discover ${adapter.provider} hardware wallets.`, cause);
  }
}

export async function getHardwareWalletPublicKey(
  adapter: HardwareWalletAdapter,
  device: HardwareWalletDevice,
): Promise<SorokitResult<string>> {
  try {
    return await adapter.getPublicKey(device);
  } catch (cause) {
    return err(SorokitErrorCode.WALLET_CONNECT_FAILED, `Unable to connect to ${adapter.provider} device ${device.id}.`, cause);
  }
}

export async function signTransactionWithHardwareWallet(
  adapter: HardwareWalletAdapter,
  device: HardwareWalletDevice,
  input: SignTransactionInput,
): Promise<SorokitResult<string>> {
  try {
    return await adapter.signTransaction(device, input);
  } catch (cause) {
    return err(SorokitErrorCode.WALLET_SIGN_FAILED, `Hardware wallet ${adapter.provider} failed to sign the transaction.`, cause);
  }
}
