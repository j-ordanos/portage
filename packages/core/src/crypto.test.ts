import { describe, expect, it } from "vitest";
import { decodeMasterKey, openSealed, seal } from "./crypto.js";

const key = Buffer.alloc(32, 7).toString("base64");

describe("AES-GCM secrets", () => {
  it("seals and opens values", () => {
    expect(openSealed(seal("canary-secret", key), key)).toBe("canary-secret");
  });

  it("rejects tampered ciphertext", () => {
    const sealed = seal("canary-secret", key);
    const bytes = Buffer.from(sealed, "base64");
    const last = bytes[bytes.length - 1];
    if (last !== undefined) bytes[bytes.length - 1] = last ^ 1;
    expect(() => openSealed(bytes.toString("base64"), key)).toThrow(
      "Tampered ciphertext",
    );
  });

  it("requires an exact 32-byte master key", () => {
    expect(() => decodeMasterKey(Buffer.alloc(16).toString("base64"))).toThrow(
      "32 bytes",
    );
  });
});
