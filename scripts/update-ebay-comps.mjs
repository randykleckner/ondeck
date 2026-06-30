import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = resolve(ROOT, "data");
const MARKETPLACE_ID = process.env.EBAY_MARKETPLACE_ID || "EBAY_US";
const ACCESS_TOKEN = process.env.EBAY_ACCESS_TOKEN;
const COMP_SOURCE = (process.env.CARD_COMP_SOURCE || "auto").toLowerCase();
const SOLD_ENDPOINT = process.env.EBAY_SOLD_ENDPOINT || "https://api.ebay.com/buy/marketplace_insights/v1_beta/item_sales/search";
const ACTIVE_ENDPOINT = process.env.EBAY_ACTIVE_ENDPOINT || "https://api.ebay.com/buy/browse/v1/item_summary/search";
const AS_OF_DATE = process.env.AS_OF_DATE || new Date().toISOString().slice(0, 10);
const LIMIT = Number(process.env.EBAY_COMP_LIMIT || 100);
const WEB_LIMIT = Number(process.env.WEB_COMP_LIMIT || 60);
const MAX_PLAYERS = Number(process.env.CARD_COMP_MAX_PLAYERS || 0);
const TARGET_IDS = new Set(String(process.env.CARD_COMP_TARGET_IDS || "").split(",").map((value) => value.trim()).filter(Boolean));
const SOURCE_LABEL = COMP_SOURCE === "manual" ? "Manual weekly comps" : shouldUseWebComps() ? "eBay public sold search scrape" : "eBay sold comps";

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

if (COMP_SOURCE === "api" && !ACCESS_TOKEN) {
  throw new Error("Missing EBAY_ACCESS_TOKEN. Create an eBay OAuth user token with access to sold item sales, then rerun this script.");
}

const prospects = limitProspects(parseCsv(await readFile(resolve(DATA_DIR, "mlb-top100-2026.csv"), "utf8")));
const targetOverrides = await readOptionalCsv(resolve(DATA_DIR, "card-targets.csv"));
const manualMarketRows = await readOptionalCsv(resolve(DATA_DIR, "card-market-manual.csv"));
const overridesById = new Map(targetOverrides.map((row) => [row.player_id, row]));
const manualRowsById = new Map(manualMarketRows.map((row) => [row.player_id, row]));
const rows = [];
const errors = [];

for (const prospect of prospects) {
  const override = overridesById.get(prospect.player_id);
  const target = buildTarget(prospect, override);
  if (target.enabled === false) continue;
  const manualRow = manualRowsById.get(prospect.player_id);
  if (manualRow) {
    rows.push(normalizeManualMarketRow(prospect, target, manualRow));
    console.log(`${prospect.player_name}: using manual weekly comps for ${target.card_code}`);
    continue;
  }
  if (COMP_SOURCE === "manual") continue;

  try {
    const soldItems = await fetchSoldItems(target);
    const matchedSold = soldItems.filter((item) => isTargetMatch(item, target));
    if (!matchedSold.length) {
      errors.push({ player_id: prospect.player_id, player_name: prospect.player_name, message: `No matching sold comps returned by ${SOURCE_LABEL}` });
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

for (const manualRow of manualMarketRows) {
  if (!manualRow.player_id || rows.some((row) => row.player_id === manualRow.player_id)) continue;
  rows.push(normalizeManualMarketRow({ player_id: manualRow.player_id, player_name: manualRow.player_name || "" }, { card_code: manualRow.card_code || "" }, manualRow));
}

await writeCsv(resolve(DATA_DIR, "card-market.csv"), rows, MARKET_HEADERS);
await writeFile(
  resolve(DATA_DIR, "card-market-report.json"),
  `${JSON.stringify({ source: SOURCE_LABEL, mode: COMP_SOURCE, marketplace: MARKETPLACE_ID, last_updated: AS_OF_DATE, rows: rows.length, errors }, null, 2)}\n`,
);

console.log(`Wrote ${rows.length} card-market rows from ${SOURCE_LABEL}.`);

function normalizeManualMarketRow(prospect, target, row) {
  return Object.fromEntries(MARKET_HEADERS.map((header) => {
    const fallback = {
      player_id: prospect.player_id,
      card_name: row.card_name || `${prospect.player_name} Bowman Chrome Prospect Auto`,
      card_code: row.card_code || target.card_code,
      data_source: row.data_source || "Manual weekly comps",
      last_updated: row.last_updated || AS_OF_DATE,
    }[header] ?? "";
    return [header, row[header] || fallback];
  }));
}

function limitProspects(prospects) {
  const targeted = TARGET_IDS.size ? prospects.filter((prospect) => TARGET_IDS.has(prospect.player_id) || TARGET_IDS.has(prospect.player_name)) : prospects;
  return MAX_PLAYERS > 0 ? targeted.slice(0, MAX_PLAYERS) : targeted;
}

function shouldUseWebComps() {
  return COMP_SOURCE === "web" || (COMP_SOURCE === "auto" && !ACCESS_TOKEN);
}

async function fetchSoldItems(target) {
  if (shouldUseWebComps()) {
    return fetchWebSoldItems(target);
  }
  const url = new URL(SOLD_ENDPOINT);
  url.searchParams.set("q", target.query);
  url.searchParams.set("limit", String(LIMIT));
  const json = await fetchEbayJson(url);
  return normalizeSoldItems(json);
}

async function fetchActiveListingCount(target) {
  if (shouldUseWebComps()) {
    return fetchWebActiveListingCount(target);
  }
  const url = new URL(ACTIVE_ENDPOINT);
  url.searchParams.set("q", target.query);
  url.searchParams.set("limit", "1");
  const json = await fetchEbayJson(url);
  const total = Number(json.total ?? json.totalItems ?? json.itemSummaries?.length ?? "");
  return Number.isFinite(total) ? total : "";
}

async function fetchWebSoldItems(target) {
  const url = ebaySearchUrl(target, { sold: true });
  const html = await fetchWebHtml(url);
  const items = parseEbaySearchHtml(html);
  return items.slice(0, WEB_LIMIT);
}

async function fetchWebActiveListingCount(target) {
  const url = ebaySearchUrl(target, { sold: false });
  const html = await fetchWebHtml(url);
  const total = parseEbayResultCount(html);
  return Number.isFinite(total) ? total : "";
}

async function fetchWebHtml(url) {
  const response = await fetch(url, {
    headers: {
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    },
  });
  const html = await response.text();
  if (!response.ok || /<title>\s*Error Page \| eBay\s*<\/title>/i.test(html) || /Something went wrong on our end/i.test(html)) {
    throw new Error(`eBay public search blocked or returned ${response.status} for ${url.toString()}`);
  }
  return html;
}

function parseEbaySearchHtml(html) {
  const rows = [];
  const blocks = html.match(/<li[^>]+class="[^"]*s-item[^"]*"[\s\S]*?<\/li>/gi) ?? [];
  for (const block of blocks) {
    const title = stripTags(matchFirst(block, [
      /<div[^>]+class="[^"]*s-item__title[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
      /"title"\s*:\s*"([^"]+)"/i,
    ]));
    const priceText = stripTags(matchFirst(block, [
      /<span[^>]+class="[^"]*s-item__price[^"]*"[^>]*>([\s\S]*?)<\/span>/i,
      /"price"\s*:\s*\{\s*"value"\s*:\s*"([^"]+)"/i,
    ]));
    const soldText = stripTags(matchFirst(block, [
      /<span[^>]+class="[^"]*s-item__title--tagblock[^"]*"[^>]*>([\s\S]*?)<\/span>/i,
      /<span[^>]+class="[^"]*POSITIVE[^"]*"[^>]*>([\s\S]*?)<\/span>/i,
    ]));
    const itemUrl = decodeHtml(matchFirst(block, [
      /<a[^>]+class="[^"]*s-item__link[^"]*"[^>]+href="([^"]+)"/i,
      /"itemWebUrl"\s*:\s*"([^"]+)"/i,
    ]));
    const price = moneyValue(priceText);
    if (!title || !Number.isFinite(price)) continue;
    rows.push({
      title,
      price,
      currency: "USD",
      sold_at: parseSoldDateText(soldText),
      url: itemUrl,
    });
  }
  return dedupeItems(rows);
}

function parseEbayResultCount(html) {
  const text = stripTags(matchFirst(html, [
    /<h1[^>]+class="[^"]*srp-controls__count-heading[^"]*"[^>]*>([\s\S]*?)<\/h1>/i,
    /"totalEntries"\s*:\s*(\d+)/i,
  ]));
  const number = Number(String(text).replaceAll(/[^0-9]/g, ""));
  return Number.isFinite(number) ? number : NaN;
}

function matchFirst(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1];
  }
  return "";
}

function stripTags(value) {
  return decodeHtml(String(value ?? "").replaceAll(/<[^>]+>/g, " ").replaceAll(/\s+/g, " ").trim());
}

function decodeHtml(value) {
  return String(value ?? "")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&apos;", "'")
    .replaceAll("&nbsp;", " ")
    .replaceAll(/\\\//g, "/");
}

function parseSoldDateText(value) {
  const text = stripTags(value);
  const match = text.match(/Sold\s+([A-Z][a-z]{2}\s+\d{1,2},\s+\d{4})/i) || text.match(/([A-Z][a-z]{2}\s+\d{1,2},\s+\d{4})/);
  if (!match) return "";
  const date = new Date(match[1]);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function dedupeItems(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = `${comparable(item.title)}|${item.price}|${item.sold_at || item.url}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
    data_source: SOURCE_LABEL,
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
  return ebaySearchUrl(target, { sold: true }).toString();
}

function ebaySearchUrl(target, { sold }) {
  const url = new URL("https://www.ebay.com/sch/i.html");
  url.searchParams.set("_nkw", target.query);
  if (sold) {
    url.searchParams.set("LH_Sold", "1");
    url.searchParams.set("LH_Complete", "1");
  }
  return url;
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
