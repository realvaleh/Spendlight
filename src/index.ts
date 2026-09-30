#!/usr/bin/env node
import { HELP, isWildcardBind, loadConfig, parseArgs } from "./config.js";
import { createApp, listen } from "./server.js";

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  process.stdout.write(HELP);
  process.exit(0);
}
if (args.version) {
  process.stdout.write("spendlight 0.1.0\n");
  process.exit(0);
}

const config = loadConfig(args.configPath);
const app = createApp(config);
const url = await listen(app);

console.log(`Spendlight listening on ${url}`);
console.log(`  dashboard  ${url}/`);
console.log(`  openai     ${url}/v1`);
console.log(`  receipts   ${url}/receipt.md  ${url}/receipt.svg  ${url}/badge.svg`);
console.log(`  export     ${url}/api/export.csv`);
console.log(`  db         ${config.dbPath}`);
console.log(`  upstream   ${config.upstreamBaseUrl}`);
if (config.budgets.period === "day") {
  console.log(`  budget     day (${config.budgets.timezone})`);
} else {
  console.log(`  budget     lifetime`);
}
if (!config.upstreamApiKey) {
  console.log("  note       OPENAI_API_KEY unset; clients must send Authorization");
}
if (isWildcardBind(config.host)) {
  console.log("  warn       Bound on all interfaces with no dashboard auth.");
  console.log("             Do not expose this port publicly; prefer 127.0.0.1.");
}

const shutdown = async () => {
  await app.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
