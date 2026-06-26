import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = resolve(ROOT, "data");
const MARKETPLACE_ID = process.env.EBAY_MARKETPLACE_ID || "EBAY_US";
const ACCESS_TOKEN = process.env.EBAY_ACCESS_TOKEN;
const SOLD_ENDPOINT = process.env.EBAY_SOLD_ENDPOINT || "https://api.ebay.com/buy/marketplace_insights/v1_beta/item_sales/search";
const ACTIVE_ENDPOINT = process.env.EBAY_ACTIVE_ENDPOINT || "https://api.ebay.com/buy/browse/v1/item_summary/search";
const AS_OF_DATE = process.env.AS_OF_DATE || new Date().toISOString().slice(0, 10);
const LIMIT = Number(process.env.EBAY_COMP_LIMIT || 100);

const MARKET_HEADERS = [
  "player_id",
  "card_name",
  "card_code",
  "last_sale",
  "last_sale_date",
  "avg_7",
  "avg_30",
  "avg_90",
  "sales_30",
  "active_listings",
  "sell_through",
  "buy_low",
  "buy_high",
  "market_signal",
  "market_note",
  "data_source",
  "source_url",
  "last_updated",
];

if (!ACCESS_TOKEN) {
  throw new Error("Missing EBAY_ACCESS_TOKEN. Create an eBay OAuth user token with access to sold item sales, then rerun this script.");
}

const prospects = parseCsv(await readFile(resolve(DATA_DIR, "mlb-top100-2026.csv"), "utf8"));
const targetOverrides = await readOptionalCsv(resolve(DATA_DIR, "card-targets.csv"));
const overridesById = new Map(targetOverrides.map((row) => [row.player_id, row]));
const rows = [];
const errors = [];

for (const prospect of prospects) {
  const override = overridesById.get(prospect.player_id);
  const target = buildTarget(prospect, override);
  if (target.enabled === false) continue;

  try {
    const soldItems = await fetchSoldItems(target);
    const matchedSold = soldItems.filter((item) => isTargetMatch(item, target));
    if (!matchedSold.length) {
      errors.push({ player_id: prospect.player_id, player_name: prospect.player_name, message: "No matching sold comps returned by eBay" });
      continue;
    }

    const activeListings = await fetchActiveListingCount(target).catch(() => "");
    rows.push(buildMarketRow(prospect, target, matchedSold, activeListings));
    console.log(`${prospect.player_name}: ${matchedSold.length} sold comps for ${target.card_code}`);
  } catch (error) {
    errors.push({ player_id: prospect.player_id, player_name: prospect.player_name, message: error.message });
    console.warn(`Could not update ${prospect.player_name}: ${error.message}`);
  }
}

await writeCsv(resolve(DATA_DIR, "card-market.csv"), rows, MARKET_HEADERS);
await writeFile(
  resolve(DATA_DIR, "card-market-report.json"),
  `${JSON.stringify({ source: "eBay sold comps", marketplace: MARKETPLACE_ID, last_updated: AS_OF_DATE, rows: rows.length, errors }, null, 2)}\n`,
);

console.log(`Wrote ${rows.length} eBay card-market rows.`);

async function fetchSoldItems(target) {
  const url = new URL(SOLD_ENDPOINT);
  url.searchParams.set("q", target.query);
  url.searchParams.set("limit", String(LIMIT));
  const json = await fetchEbayJson(url);
  return normalizeSoldItems(json);
}

async function fetchActiveListingCount(target) {
  const url = new URL(ACTIVE_ENDPOINT);
  url.searchParams.set("q", target.query);
  url.searchParams.set("limit", "1");
  const json = await fetchEbayJson(url);
  const total = Number(json.total ?? json.totalItems ?? json.itemSummaries?.length ?? "");
  return Number.isFinite(total) ? total : "";
}

async function fetchEbayJson(url) {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      "X-EBAY-C-MARKETPLACE-ID": MARKETPLACE_ID,
      "User-Agent": "ondeck-prospect-local-dashboard",
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${response.status} ${response.statusText} for ${url.pathname}: ${body.slice(0, 220)}`);
  }
  return response.json();
}

function normalizeSoldItems(json) {
  const source = json.itemSales ?? json.itemSummaries ?? json.items ?? json.searchResult?.item ?? [];
  return source
    .map((item) => {
      const price = item.price ?? item.itemPrice ?? item.convertedFromValue ?? item.currentBidPrice ?? {};
      return {
        title: item.title ?? item.itemTitle ?? item.name ?? "",
        price: moneyValue(price),
        currency: price.currency ?? price.currencyId ?? "USD",
        sold_at: item.itemEndDate ?? item.soldDate ?? item.lastSoldDate ?? item.endDate ?? item.itemCreationDate ?? "",
        url: item.itemWebUrl ?? item.itemAffiliateWebUrl ?? item.viewItemURL ?? "",
      };
    })
    .filter((item) => Number.isFinite(item.price));
}

function buildMarketRow(prospect, target, soldItems, activeListings) {
  const sorted = soldItems
    .map((item) => ({ ...item, soldDate: parseDate(item.sold_at) }))
    .sort((a, b) => (b.soldDate?.getTime() ?? 0) - (a.soldDate?.getTime() ?? 0));
  const last = sorted[0];
  const windows = {
    avg_7: averageForWindow(sorted, 7),
    avg_30: averageForWindow(sorted, 30),
    avg_90: averageForWindow(sorted, 90),
  };
  const sales30 = countForWindow(sorted, 30);
  const sellThrough = Number.isFinite(Number(activeListings)) && sales30 + Number(activeListings) > 0
    ? round((sales30 / (sales30 + Number(activeListings))) * 100, 1)
    : "";
  const avg30 = windows.avg_30 || average(sorted.map((item) => item.price));
  const buyLow = avg30 ? round(avg30 * 0.82, 2) : "";
  const buyHigh = avg30 ? round(avg30 * 0.95, 2) : "";
  const signal = marketSignal(last.price, avg30, sales30);

  return {
    player_id: prospect.player_id,
    card_name: `${target.card_year || ""} Bowman Chrome Prospect Auto ${prospect.player_name}`.trim(),
    card_code: target.card_code,
    last_sale: round(last.price, 2),
    last_sale_date: formatDate(last.soldDate) || "",
    avg_7: windows.avg_7 || "",
    avg_30: windows.avg_30 || "",
    avg_90: windows.avg_90 || "",
    sales_30: sales30 || "",
    active_listings: activeListings,
    sell_through: sellThrough,
    buy_low: buyLow ? `$${buyLow}` : "",
    buy_high: buyHigh ? `$${buyHigh}` : "",
    market_signal: signal,
    market_note: `eBay sold-comps pull matched ${soldItems.length} ${target.card_code} Chrome Prospect Auto sales; last sale ${last.price ? `$${round(last.price, 2)}` : ""}${formatDate(last.soldDate) ? ` on ${formatDate(last.soldDate)}` : ""}.`,
    data_source: "eBay sold comps",
    source_url: ebaySoldSearchUrl(target),
    last_updated: AS_OF_DATE,
  };
}

function buildTarget(prospect, override = {}) {
  const cardCode = override.card_code || generatedCardCode(prospect.player_name);
  const query = override.card_query || `${cardCode} ${prospect.player_name} Chrome Prospect Auto`;
  return {
    player_id: prospect.player_id,
    player_name: prospect.player_name,
    card_code: cardCode,
    card_year: override.card_year || "",
    query,
    enabled: String(override.enabled ?? "true").toLowerCase() !== "false",
    required_terms: [cardCode, "chrome", "prospect", "auto", ...nameTerms(prospect.player_name)],
  };
}

function isTargetMatch(item, target) {
  const title = comparable(item.title);
  return target.required_terms.every((term) => title.includes(comparable(term)));
}

function generatedCardCode(name) {
  return `CPA-${nameTerms(name).map((part) => part[0]).join("").toUpperCase()}`;
}

function nameTerms(name) {
  return comparable(name)
    .replaceAll(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((part) => part.length > 1);
}

function averageForWindow(items, days) {
  const cutoff = dateOffset(-days);
  return average(items.filter((item) => item.soldDate && item.soldDate >= cutoff).map((item) => item.price));
}

function countForWindow(items, days) {
  const cutoff = dateOffset(-days);
  return items.filter((item) => item.soldDate && item.soldDate >= cutoff).length;
}

function average(values) {
  const clean = values.filter(Number.isFinite);
  if (!clean.length) return "";
  return round(clean.reduce((sum, value) => sum + value, 0) / clean.length, 2);
}

function marketSignal(lastSale, avg30, sales30) {
  if (!avg30 || sales30 < 2) return "Verify";
  const discount = ((avg30 - lastSale) / avg30) * 100;
  if (discount >= 20) return "Strong Buy";
  if (discount >= 8) return "Buy";
  if (discount <= -12) return "Over Avg";
  return "Watch";
}

function ebaySoldSearchUrl(target) {
  const url = new URL("https://www.ebay.com/sch/i.html");
  url.searchParams.set("_nkw", target.query);
  url.searchParams.set("LH_Sold", "1");
  url.searchParams.set("LH_Complete", "1");
  return url.toString();
}

function moneyValue(value) {
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value.replaceAll(/[^0-9.-]/g, ""));
  return Number(value.value ?? value.__value__ ?? value.amount ?? NaN);
}

function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDate(date) {
  return date ? date.toISOString().slice(0, 10) : "";
}

function dateOffset(days) {
  const date = new Date(`${AS_OF_DATE}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date;
}

async function readOptionalCsv(path) {
  try {
    return parseCsv(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function parseCsv(text) {
  const rows = [];
  let field = "";
  let row = [];
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '"' && quoted && next === '"') {
      field += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(field);
      field = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(field);
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (field || row.length) {
    row.push(field);
    if (row.some((value) => value.trim())) rows.push(row);
  }
  if (!rows.length) return [];
  const headers = rows[0].map((header) => header.trim().toLowerCase().replaceAll(/\s+/g, "_"));
  return rows.slice(1).map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
}

async function writeCsv(path, rows, headers) {
  const lines = [headers.join(","), ...rows.map((row) => headers.map((header) => escapeCsv(row[header])).join(","))];
  await writeFile(path, `${lines.join("\n")}\n`);
}

function escapeCsv(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function comparable(value) {
  return String(value ?? "").normalize("NFD").replaceAll(/[\u0300-\u036f]/g, "").toLowerCase();
}

function round(value, places) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
