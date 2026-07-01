#!/usr/bin/env node

const DEFAULT_ENDPOINT = "https://ondeckprospect.com/api/rank-trends?run=true";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const arg = process.argv[index];
  if (!arg.startsWith("--")) continue;
  const [key, inlineValue] = arg.slice(2).split("=");
  const value = inlineValue ?? process.argv[index + 1];
  args.set(key, value === undefined || value.startsWith?.("--") ? "true" : value);
  if (inlineValue == null && value && !value.startsWith("--")) index += 1;
}

const endpoint = args.get("endpoint") || process.env.ONDECK_RANK_TRENDS_ENDPOINT || DEFAULT_ENDPOINT;
const url = new URL(endpoint);
url.searchParams.set("run", "true");
if (args.get("force") === "true") {
  url.searchParams.set("force", "true");
}

const response = await fetch(url, {
  method: "POST",
  headers: { Accept: "application/json" },
});

const body = await response.text();
let data;
try {
  data = JSON.parse(body);
} catch {
  data = { raw: body };
}

if (!response.ok) {
  console.error(JSON.stringify(data, null, 2));
  process.exit(1);
}

console.log(JSON.stringify(data, null, 2));
