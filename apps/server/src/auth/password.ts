import { createHash, timingSafeEqual } from "node:crypto";
import argon2 from "argon2";

export async function verifyPassword(
  password: string,
  hash: string,
): Promise<boolean> {
  if (hash.startsWith("sha256:")) {
    const candidate = `sha256:${createHash("sha256").update(password).digest("hex")}`;
    const left = Buffer.from(candidate);
    const right = Buffer.from(hash);
    return left.length === right.length && timingSafeEqual(left, right);
  }
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}
