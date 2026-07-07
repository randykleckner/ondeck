#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const args = parseArgs(process.argv.slice(2));
const common = args.remote ? ["--remote"] : [];
const source = args.source || path.join(repoRoot, "Emerging_cleaned");

run("Import cleaned Emerging workbook/stats snapshots", [
  "scripts/import-emerging-workbook.mjs",
  source,
  "--execute",
  ...common,
]);

run("Refresh card market for Card API candidates only", [
  "scripts/refresh-emerging-card-market.mjs",
  "--limit",
  String(args.marketLimit),
  ...(args.forceMarket ? ["--force"] : []),
  ...(args.paidMarket ? [] : ["--dry-run"]),
  ...common,
]);

run("Generate draft Emerging recommendations", [
  "scripts/generate-emerging-recommendations.mjs",
  "--limit",
  String(args.recommendationLimit),
  ...common,
]);

console.log(JSON.stringify({
  status: "complete",
  source,
  remote: args.remote,
  paidMarketRefresh: args.paidMarket,
  marketLimit: args.marketLimit,
}, null, 2));

function run(label, commandArgs) {
  console.log(`\n=== ${label} ===`);
  execFileSync("node", commandArgs, { cwd: repoRoot, stdio: "inherit" });
}

function parseArgs(argv) {
  const result = {
    source: "",
    remote: false,
    paidMarket: false,
    forceMarket: false,
    marketLimit: 150,
    recommendationLimit: 300,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--source") result.source = argv[++index] || "";
    else if (arg === "--remote") result.remote = true;
    else if (arg === "--paid-market") result.paidMarket = true;
    else if (arg === "--force-market") result.forceMarket = true;
    else if (arg === "--market-limit") result.marketLimit = Math.max(1, Math.min(150, Number(argv[++index]) || 150));
    else if (arg === "--recommendation-limit") result.recommendationLimit = Math.max(1, Math.min(1000, Number(argv[++index]) || 300));
  }
  return result;
}
