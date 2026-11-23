import argon2 from "argon2";

const password = process.argv[2];
if (!password) {
  process.stderr.write("Usage: pnpm hash-password <password>\n");
  process.exit(1);
}

argon2
  .hash(password, { type: argon2.argon2id })
  .then((hash) => process.stdout.write(`${hash}\n`))
  .catch((error: unknown) => {
    const message =
      error instanceof Error ? error.message : "Unable to hash password";
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
