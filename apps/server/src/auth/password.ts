import argon2 from "argon2";

/** argon2id only; the hash comes from ADMIN_PASSWORD_HASH (`pnpm hash-password`). */
export async function verifyPassword(
  password: string,
  hash: string,
): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}
