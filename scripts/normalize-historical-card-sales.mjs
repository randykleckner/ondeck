#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_INPUT = "data/historical-card-sales-raw";
const DEFAULT_OUTPUT = "data/historical-card-sales.csv";
const DEFAULT_SQL_OUTPUT = "data/historical-card-sales-import.sql";

const args = readArgs(process.argv.slice(2));
const inputPath = args.input || DEFAULT_INPUT;
const outputPath = args.output || DEFAULT_OUTPUT;
const sqlOutputPath = args.sql || DEFAULT_SQL_OUTPUT;

const files = await discoverCsvFiles(inputPath);
if (!files.length) {
  console.error(`No CSV files found at ${inputPath}. Export Numbers as one CSV per player sheet into ${DEFAULT_INPUT}.`);
  process.exit(1);
}

const normalizedRows = [];
const skippedRows = [];

for (const file of files) {
  const text = await fs.readFile(file, "utf8");
  const rows = parseCsv(text);
  const fallbackPlayer = playerNameFromFile(file);
  rows.forEach((row, rowIndex) => {
    const normalized = normalizeSaleRow(row, { fallbackPlayer, sourceFile: path.basename(file) });
    if (normalized) {
      normalizedRows.push(normalized);
    } else if (Object.values(row).some((value) => String(value ?? "").trim())) {
      skippedRows.push({ file: path.basename(file), row: rowIndex + 2 });
    }
  });
}

normalizedRows.sort((a, b) => a.player_name.localeCompare(b.player_name) || a.sale_date.localeCompare(b.sale_date));

await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, toCsv(normalizedRows), "utf8");
await fs.writeFile(sqlOutputPath, toSql(normalizedRows), "utf8");

console.log(JSON.stringify({
  inputPath,
  filesRead: files.length,
  rowsWritten: normalizedRows.length,
  rowsSkipped: skippedRows.length,
  outputPath,
  sqlOutputPath,
}, null, 2));

function normalizeSaleRow(row, context) {
  const title = firstField(row, [
    "listing title",
    "title",
    "item title",
    "name",
    "listing",
    "product",
  ]);
  const playerName = cleanText(firstField(row, ["player_name", "player", "player name"])) || context.fallbackPlayer;
  const saleDate = normalizeDate(firstField(row, [
    "sale_date",
    "date",
    "sold date",
    "last sold",
    "end date",
    "period_start",
    "period start",
  ]));
  const salePrice = money(firstField(row, [
    "sale_price",
    "price",
    "sold price",
    "avg_price",
    "average price",
    "avg sold price",
    "item price",
    "total price",
  ]));
  const salesCount = integer(firstField(row, [
    "sales_count",
    "sales count",
    "quantity",
    "qty",
    "count",
    "# of sales",
    "number of sales",
  ])) || 1;

  if (!playerName || !saleDate || !Number.isFinite(salePrice) || salePrice <= 0) return null;
  if (!isBenchmarkCard(title, playerName)) return null;

  const cardCode = cleanText(firstField(row, ["card_code", "card code", "code"])) || cardCodeFromTitle(title);
  const cardName = cleanText(firstField(row, ["card_name", "card name"])) || "Bowman Chrome 1st Auto";
  const sourceUrl = cleanText(firstField(row, ["source_url", "url", "item url", "listing url"]));

  return {
    player_key: playerKey(playerName),
    player_name: playerName,
    card_name: cardName,
    card_code: cardCode,
    sale_date: saleDate,
    sale_price: salePrice.toFixed(2),
    sales_count: String(salesCount),
    listing_title: cleanText(title),
    source_url: sourceUrl,
    source_file: context.sourceFile,
  };
}

function isBenchmarkCard(title, playerName) {
  const text = normalize(`${title} ${playerName}`);
  if (!text.includes(normalize(playerName))) return false;
  if (!text.includes("bowman")) return false;
  if (!text.includes("auto") && !text.includes("autograph")) return false;
  if (!text.includes("1st") && !text.includes("first")) return false;
  const exclusions = [
    "refractor",
    "sapphire",
    "purple",
    "blue",
    "gold",
    "orange",
    "green",
    "mojo",
    "wave",
    "speckle",
    "paper",
    "insert",
    "lot",
    "break",
    "case break",
    "pick your player",
    "digital",
    "reprint",
    "custom",
  ];
  return !exclusions.some((term) => text.includes(term));
}

async function discoverCsvFiles(input) {
  const stats = await fs.stat(input).catch(() => null);
  if (!stats) return [];
  if (stats.isFile()) return [input];
  const entries = await fs.readdir(input, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".csv"))
    .map((entry) => path.join(input, entry.name))
    .sort();
}

function playerNameFromFile(file) {
  return path.basename(file, path.extname(file))
    .replaceAll(/[_-]+/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim();
}

function firstField(row, names) {
  const lookup = new Map(Object.entries(row).map(([key, value]) => [normalizeHeader(key), value]));
  for (const name of names) {
    const value = lookup.get(normalizeHeader(name));
    if (value != null && String(value).trim() !== "") return value;
  }
  return "";
}

function normalizeHeader(value) {
  return String(value ?? "").toLowerCase().replaceAll(/[^a-z0-9]+/g, " ").trim();
}

function normalizeDate(value) {
  const raw = cleanText(value);
  if (!raw) return "";
  const direct = new Date(raw);
  if (!Number.isNaN(direct.getTime())) return direct.toISOString().slice(0, 10);
  const match = raw.match(/(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
  if (!match) return "";
  const year = match[3].length === 2 ? `20${match[3]}` : match[3];
  const date = new Date(`${year}-${match[1].padStart(2, "0")}-${match[2].padStart(2, "0")}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

function money(value) {
  const numeric = Number(String(value ?? "").replaceAll(/[^0-9.-]/g, ""));
  return Number.isFinite(numeric) ? numeric : NaN;
}

function integer(value) {
  const numeric = Number(String(value ?? "").replaceAll(/[^0-9-]/g, ""));
  return Number.isFinite(numeric) ? Math.max(0, Math.round(numeric)) : 0;
}

function cardCodeFromTitle(title) {
  const match = cleanText(title).match(/\b(CPA|CDA|BCP|BPA)-[A-Z0-9]+\b/i);
  return match ? match[0].toUpperCase() : "";
}

function playerKey(name) {
  return `name:${normalize(name)}`;
}

function normalize(value) {
  return cleanText(value)
    .normalize("NFD")
    .replaceAll(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, " ")
    .trim();
}

function cleanText(value) {
  return String(value ?? "").replaceAll(/\s+/g, " ").trim();
}

function parseCsv(csv) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < csv.length; index += 1) {
    const char = csv[index];
    const next = csv[index + 1];
    if (char === '"' && quoted && next === '"') {
      cell += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  row.push(cell);
  rows.push(row);

  const [header = [], ...records] = rows.filter((values) => values.some((value) => String(value).trim()));
  return records.map((record) => Object.fromEntries(header.map((key, index) => [key.trim(), record[index]?.trim() ?? ""])));
}

function toCsv(rows) {
  const headers = [
    "player_key",
    "player_name",
    "card_name",
    "card_code",
    "sale_date",
    "sale_price",
    "sales_count",
    "listing_title",
    "source_url",
    "source_file",
  ];
  return `${headers.join(",")}\n${rows.map((row) => headers.map((header) => csvEscape(row[header])).join(",")).join("\n")}\n`;
}

function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function toSql(rows) {
  const values = rows.map((row) => `(${[
    row.player_key,
    row.player_name,
    row.card_name,
    row.card_code,
    row.sale_date,
    row.sale_price,
    row.sales_count,
    row.listing_title,
    row.source_url,
    row.source_file,
    JSON.stringify(row),
  ].map(sqlValue).join(", ")})`);

  if (!values.length) return "-- No historical card sales rows to import.\n";
  return `INSERT OR IGNORE INTO card_sales_history (
  player_key,
  player_name,
  card_name,
  card_code,
  sale_date,
  sale_price,
  sales_count,
  listing_title,
  source_url,
  source_file,
  raw_json
) VALUES\n${values.join(",\n")};\n`;
}

function sqlValue(value) {
  if (value === "" || value == null) return "NULL";
  if (typeof value === "number" || /^-?\d+(\.\d+)?$/.test(String(value))) return String(value);
  return `'${String(value).replaceAll("'", "''")}'`;
}

function readArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const [key, inlineValue] = arg.slice(2).split("=");
    parsed[key] = inlineValue ?? argv[index + 1] ?? "";
    if (inlineValue == null) index += 1;
  }
  return parsed;
}
