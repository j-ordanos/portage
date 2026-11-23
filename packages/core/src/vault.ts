export interface Vault {
  put(value: string): Promise<string>;
  get(ref: string): Promise<string>;
  purge(): Promise<void>;
}

export class MemoryVault implements Vault {
  private readonly values = new Map<string, string>();

  async put(value: string): Promise<string> {
    const ref = `v_${randomId()}`;
    this.values.set(ref, value);
    return ref;
  }

  async get(ref: string): Promise<string> {
    const value = this.values.get(ref);
    if (value === undefined)
      throw new Error(`Vault reference unavailable: ${ref}`);
    return value;
  }

  async purge(): Promise<void> {
    this.values.clear();
  }
}

function randomId(): string {
  if (!globalThis.crypto)
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}
