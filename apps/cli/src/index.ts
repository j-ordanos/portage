#!/usr/bin/env node

const command = process.argv[2] ?? "help";
const commands = ["inventory", "plan", "apply", "verify", "report"];
const irPath = process.argv
  .find((argument) => argument.startsWith("--ir="))
  ?.slice(5);
const planPath = process.argv
  .find((argument) => argument.startsWith("--plan="))
  ?.slice(7);

if (!commands.includes(command)) {
  process.stdout.write(`Usage: migrator <${commands.join("|")}>\n`);
  process.exitCode = 1;
} else {
  if (command === "plan" && irPath) {
    process.stdout.write(
      `Plan requested from ${irPath}. Use the core buildPlan API with a persisted IR.\n`,
    );
  } else if (command === "apply" && planPath) {
    process.stdout.write(
      `Apply requested from ${planPath}. Dry-run and explicit confirmation are required.\n`,
    );
  } else {
    process.stdout.write(
      `${command}: core command entry point ready; provide --ir=<file> or --plan=<file> where required.\n`,
    );
  }
}
