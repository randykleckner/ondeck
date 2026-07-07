#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const defaultSource = "/Users/randykleckner/Documents/Bowman Card tracker/Card Codes-Table 1.csv";
const sourcePath = process.argv[2] || defaultSource;
const outDir = process.argv[3] || path.join(repoRoot, "data");

const DATA_DIR = path.join(repoRoot, "data");
const top100 = parseCsv(fs.readFileSync(path.join(DATA_DIR, "mlb-top100-2026.csv"), "utf8"));
const existing = parseCsv(fs.readFileSync(path.join(DATA_DIR, "card-targets.csv"), "utf8"));
const attached = parseCsv(fs.readFileSync(sourcePath, "utf8"));

const corrections = new Map([
  ["felnin celsten", "felnin celesten"],
  ["xaiver neyens", "xavier neyens"],
  ["braylong doughty", "braylon doughty"],
]);

const topByName = new Map(top100.map((row) => [normalizeName(row.player_name), row]));
const existingByName = new Map(existing.map((row) => [normalizeName(row.player_name), row]));
const attachedByName = new Map();

for (const row of attached) {
  const name = cleanText(row.player);
  const key = correctedNameKey(name);
  if (!key || key === "player" || key === "graduated") continue;
  attachedByName.set(key, { ...row, player: name });
}

const rows = top100.map((player) => targetForPlayer(player));
const topNames = new Set(top100.map((row) => normalizeName(row.player_name)));

for (const row of attached) {
  const playerName = cleanText(row.player);
  const key = correctedNameKey(playerName);
  if (!key || key === "player" || key === "graduated" || topNames.has(key)) continue;
  if (!cleanText(row.card_number) && !cleanText(row.notes)) continue;
  rows.push(targetForExtra(row, playerName));
}

fs.mkdirSync(outDir, { recursive: true });

const header = [
  "player_id",
  "player_name",
  "card_code",
  "card_query",
  "enabled",
  "sell_through_30",
  "sell_through_90",
  "sellers_30",
  "sellers_90",
  "card_year",
  "notes",
];

fs.writeFileSync(
  path.join(outDir, "card-targets.csv"),
  [csvLine(header), ...rows.map((row) => csvLine(header.map((key) => row[key])))].join("\n") + "\n",
);

const values = rows.map((row) => `(${[
  sqlString(row.player_id),
  sqlString(row.player_name),
  sqlString(row.card_code),
  sqlString(row.card_query),
  row.enabled === "true" ? "1" : "0",
  sqlNumber(row.sell_through_30),
  sqlNumber(row.sell_through_90),
  sqlInteger(row.sellers_30),
  sqlInteger(row.sellers_90),
  sqlString(row.card_year),
  sqlString(row.notes),
].join(", ")})`);

fs.writeFileSync(
  path.join(outDir, "card-targets-import.sql"),
  [
    "-- Generated from Card Codes-Table 1.csv. Run after migrations/0005_card_targets.sql.",
    "INSERT INTO card_targets (player_id, player_name, card_code, card_query, enabled, sell_through_30, sell_through_90, sellers_30, sellers_90, card_year, notes) VALUES",
    values.join(",\n"),
    `ON CONFLICT(player_id) DO UPDATE SET
  player_name = excluded.player_name,
  card_code = excluded.card_code,
  card_query = excluded.card_query,
  enabled = excluded.enabled,
  sell_through_30 = excluded.sell_through_30,
  sell_through_90 = excluded.sell_through_90,
  sellers_30 = excluded.sellers_30,
  sellers_90 = excluded.sellers_90,
  card_year = excluded.card_year,
  notes = excluded.notes,
  updated_at = CURRENT_TIMESTAMP;
`,
  ].join("\n"),
);

console.log(JSON.stringify({
  sourcePath,
  outDir,
  rows: rows.length,
  top100Rows: top100.length,
  enabled: rows.filter((row) => row.enabled === "true").length,
  disabled: rows.filter((row) => row.enabled !== "true").length,
}, null, 2));

function targetForPlayer(player) {
  const key = normalizeName(player.player_name);
  const source = attachedByName.get(key) || existingByName.get(key) || {};
  return buildTarget({
    playerId: player.player_id,
    playerName: player.player_name,
    source,
  });
}

function targetForExtra(source, playerName) {
  return buildTarget({
    playerId: `code-${slugify(playerName)}`,
    playerName,
    source,
  });
}

function buildTarget({ playerId, playerName, source }) {
  const rawCode = cleanText(source.card_number || source.card_code);
  const rawSellThrough30 = cleanText(source["30_day_sell_through"]);
  let notes = cleanText(source.notes);
  const disabled = isDisabledCard(rawCode, rawSellThrough30, notes);
  const cardCode = disabled ? "" : rawCode;
  if (!notes && disabled) notes = rawCode || rawSellThrough30;
  return {
    player_id: playerId,
    player_name: playerName,
    card_code: cardCode,
    card_query: cardCode ? `${cardCode} Bowman Chrome Auto` : "",
    enabled: cardCode && !disabled ? "true" : "false",
    sell_through_30: parsePercent(source["30_day_sell_through"]),
    sell_through_90: parsePercent(source["90_day_sell_through"]),
    sellers_30: parseInteger(source["30_day_sellers"]),
    sellers_90: parseInteger(source["90_day_sellers"]),
    card_year: cleanText(source.year),
    notes,
  };
}

function isDisabledCard(cardCode, sellThrough30, notes) {
  return /^no\s*card$/i.test(cardCode)
    || /no auto|non auto|no card/i.test(cardCode)
    || /no auto|non auto|no card/i.test(sellThrough30)
    || /no auto|non auto|no card/i.test(notes);
}

function parsePercent(value) {
  const text = cleanText(value);
  if (!text || text === "-" || /no auto|no card/i.test(text)) return "";
  const numeric = Number(text.replaceAll("%", ""));
  return Number.isFinite(numeric) ? String(numeric) : "";
}

function parseInteger(value) {
  const text = cleanText(value);
  if (!text) return "";
  const numeric = Number(text.replaceAll(/[^0-9.-]/g, ""));
  return Number.isFinite(numeric) ? String(Math.round(numeric)) : "";
}

function parseCsv(text) {
  const rows = [];
  let field = "";
  let row = [];
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === "\"" && quoted && next === "\"") {
      field += "\"";
      index += 1;
    } else if (char === "\"") {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(field);
      field = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(field);
      if (row.some((value) => cleanText(value) !== "")) rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }

  row.push(field);
  if (row.some((value) => cleanText(value) !== "")) rows.push(row);

  const [headers = [], ...records] = rows;
  return records.map((record) => Object.fromEntries(headers.map((header, index) => [
    normalizeHeader(header),
    cleanText(record[index]),
  ])));
}

function normalizeHeader(value) {
  const normalized = cleanText(value).toLowerCase().replaceAll(/\s+/g, "_");
  if (normalized === "card_#") return "card_number";
  return normalized;
}

function correctedNameKey(value) {
  const key = normalizeName(value);
  return corrections.get(key) || key;
}

function normalizeName(value) {
  return cleanText(value)
    .normalize("NFD")
    .replaceAll(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, " ")
    .trim();
}

function slugify(value) {
  return normalizeName(value).replaceAll(" ", "-");
}

function cleanText(value) {
  return String(value ?? "").replaceAll(/\s+/g, " ").trim();
}

function csvLine(values) {
  return values.map(csvCell).join(",");
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replaceAll("\"", "\"\"")}"` : text;
}

function sqlString(value) {
  const text = cleanText(value);
  return text ? `'${text.replaceAll("'", "''")}'` : "NULL";
}

function sqlNumber(value) {
  if (value === "" || value == null) return "NULL";
  const numeric = Number(value);
  return Number.isFinite(numeric) ? String(numeric) : "NULL";
}

function sqlInteger(value) {
  if (value === "" || value == null) return "NULL";
  const numeric = Number(value);
  return Number.isFinite(numeric) ? String(Math.round(numeric)) : "NULL";
}
