const SOLD_COMPS_API_URL = "https://api.sold-comps.com/v1/scrape";
const SOLD_CACHE_DAYS = 7;
const ACTIVE_CACHE_HOURS = 24;
const SOURCE = "SoldComps API";
const EXCLUDED_TITLE_TERMS = [
  "psa",
  "bgs",
  "sgc",
  "cgc",
  "tag",
  "graded",
  "gem mint",
  "mint 10",
  "slab",
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
  "numbered",
  "/99",
  "/75",
  "/50",
  "/25",
  "/10",
  "/5",
  "paper",
  "lot",
  "lots",
  "break",
  "breaks",
  "case break",
  "case breaks",
  "pick your player",
  "digital",
  "reprint",
  "custom",
  "insert",
  "inserts",
];

export async function onMarketDataRequest(context) {
  if (context.request.method !== "GET") {
    return jsonResponse({ error: "Method not allowed." }, 405, { Allow: "GET" });
  }
  const db = context.env?.MARKET_DB;
  if (!db) {
    return jsonResponse({ snapshots: [], message: "MARKET_DB is not configured; no external API call made." });
  }

  try {
    const rows = await db.prepare(`
      SELECT *
      FROM market_player_snapshots
      ORDER BY rank ASC
    `).all();
    const cardTargets = await readCsvAsset(context, "/data/card-targets.csv").catch(() => []);
    const cardByPlayerId = new Map(cardTargets.map((row) => [String(row.player_id), row]));
    const cardByName = new Map(cardTargets.map((row) => [normalizeName(row.player_name), row]));
    const snapshots = (rows.results || [])
      .filter((row) => snapshotTargetIsDisplayable(row, cardByPlayerId, cardByName))
      .map(snapshotRowToApi);
    return jsonResponse({ snapshots }, 200, {
      "Cache-Control": "public, max-age=300",
    });
  } catch (error) {
    return jsonResponse({
      snapshots: [],
      message: "Market snapshot table is not available yet; run migration 0004.",
    });
  }
}

export async function onRefreshTop100MarketRequest(context) {
  if (context.request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed." }, 405, { Allow: "POST" });
  }

  const db = context.env?.MARKET_DB;
  if (!db) {
    return jsonResponse({ error: "MARKET_DB D1 binding is required for refresh." }, 503);
  }
  const apiKey = context.env?.SOLD_COMPS_API_KEY || globalThis.process?.env?.SOLD_COMPS_API_KEY;
  if (!apiKey) {
    return jsonResponse({ error: "SOLD_COMPS_API_KEY is required for refresh." }, 503);
  }

  const url = new URL(context.request.url);
  const force = url.searchParams.get("force") === "true";
  const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit")) || 100));
  const now = new Date();
  const summary = {
    playersProcessed: 0,
    playersRefreshed: 0,
    playersSkippedCacheFresh: 0,
    playersMissingBenchmarkCardCodes: 0,
    soldDataApiCallsUsed: 0,
    activeListingApiCallsUsed: 0,
    soldRecordsImported: 0,
    activeListingsImported: 0,
    duplicatesSkipped: 0,
    errors: [],
    activeListingApiSupported: "not_confirmed_separate_endpoint",
    messages: [],
  };

  const [players, cardTargets] = await Promise.all([
    readCsvAsset(context, "/data/mlb-top100-2026.csv"),
    readCsvAsset(context, "/data/card-targets.csv"),
  ]);
  const enabledCardTargets = cardTargets.filter(isEnabledCardTarget);
  const cardByPlayerId = new Map(enabledCardTargets.map((row) => [String(row.player_id), row]));
  const cardByName = new Map(enabledCardTargets.map((row) => [normalizeName(row.player_name), row]));

  for (const player of players.slice(0, limit)) {
    summary.playersProcessed += 1;
    const playerId = String(player.player_id || "");
    const playerName = String(player.player_name || "").trim();
    const card = cardByPlayerId.get(playerId) || cardByName.get(normalizeName(playerName));
    const benchmarkCardCode = String(card?.card_code || player.card_code || "").trim();

    if (!playerId || !playerName || !benchmarkCardCode) {
      summary.playersMissingBenchmarkCardCodes += 1;
      summary.errors.push({
        playerId,
        playerName,
        message: "Missing player name or benchmark card code.",
      });
      continue;
    }

    const canonicalQuery = canonicalSearchQuery(playerName, benchmarkCardCode);
    try {
      const current = await readSnapshot(db, playerId);
      const soldFresh = !force && current?.sold_refreshed_at && ageDays(current.sold_refreshed_at, now) < SOLD_CACHE_DAYS;
      const activeFresh = !force && current?.active_data_updated_at && ageHours(current.active_data_updated_at, now) < ACTIVE_CACHE_HOURS;
      if (soldFresh && (activeFresh || current?.active_listing_supported === 0)) {
        summary.playersSkippedCacheFresh += 1;
        continue;
      }

      const raw = await fetchSoldComps(apiKey, canonicalQuery);
      summary.soldDataApiCallsUsed += 1;
      const soldRecords = extractSoldRecords(raw, { playerId, playerName, benchmarkCardCode, canonicalQuery });
      const activeListings = extractActiveListings(raw, { playerId, playerName, benchmarkCardCode, canonicalQuery });
      const soldImport = await writeSoldRecords(db, soldRecords);
      const activeImport = await writeActiveListings(db, activeListings);
      const snapshot = buildSnapshot({
        player,
        benchmarkCardCode,
        canonicalQuery,
        soldRecords,
        activeListings,
        raw,
        now,
      });
      await writeSnapshot(db, snapshot);

      summary.playersRefreshed += 1;
      summary.soldRecordsImported += soldImport.inserted;
      summary.activeListingsImported += activeImport.inserted;
      summary.duplicatesSkipped += soldImport.duplicates + activeImport.duplicates;
      if (snapshot.activeListingSupported) {
        summary.activeListingApiSupported = "active_data_seen_in_sold_response";
      }
    } catch (error) {
      summary.errors.push({
        playerId,
        playerName,
        message: error?.message || "Refresh failed.",
      });
    }
  }

  summary.messages.push(summary.soldDataApiCallsUsed ? "Sold data refreshed" : "Using cached sold data");
  summary.messages.push(
    summary.activeListingApiSupported === "active_data_seen_in_sold_response"
      ? "Active listings refreshed"
      : "Using cached active data or active listing API support missing",
  );
  if (summary.playersSkippedCacheFresh) summary.messages.push("Skipped because cache is fresh");
  if (summary.errors.length) summary.messages.push("API failed for some players; showing saved data where available");

  return jsonResponse(summary);
}

async function fetchSoldComps(apiKey, keyword) {
  const url = new URL(SOLD_COMPS_API_URL);
  url.searchParams.set("keyword", keyword);
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
  });
  const text = await response.text();
  const raw = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(raw?.message || raw?.error || `SoldComps request failed with ${response.status}`);
  }
  return raw;
}

function canonicalSearchQuery(playerName, benchmarkCardCode) {
  return `"${playerName}" ${benchmarkCardCode} Bowman Chrome Auto`;
}

function extractSoldRecords(raw, context) {
  return extractArray(raw, ["results", "data.results", "data.items", "data", "comps", "sales", "items"])
    .map((item) => normalizeSoldRecord(item, context))
    .filter((record) => record && isBenchmarkTitle(record.title, context.playerName))
    .sort((a, b) => new Date(`${b.soldAt}T00:00:00Z`) - new Date(`${a.soldAt}T00:00:00Z`));
}

function normalizeSoldRecord(item, context) {
  const soldPrice = numberFrom(item.price ?? item.sale_price ?? item.salePrice ?? item.sold_price ?? item.soldPrice ?? item.amount ?? item.value);
  const soldAt = normalizeDate(item.sold_at || item.soldAt || item.sale_date || item.saleDate || item.date || item.ended_at || item.endedAt);
  const title = String(item.title || item.name || item.itemTitle || "").trim();
  if (!Number.isFinite(soldPrice) || !soldAt) return null;
  const itemUrl = item.url || item.link || item.itemUrl || "";
  const itemId = String(item.item_id || item.itemId || item.id || "").trim();
  return {
    ...context,
    source: SOURCE,
    title,
    soldPrice,
    soldAt,
    itemUrl,
    itemId,
    dedupeKey: itemId
      ? `${context.playerId}:sold:item:${itemId}`
      : `${context.playerId}:sold:${normalizeText(title)}:${soldAt}:${soldPrice}`,
    rawJson: JSON.stringify(item),
  };
}

function extractActiveListings(raw, context) {
  const active = raw.active_listings || raw.activeListings || raw.active?.items || raw.active?.results || raw.listings || raw.items_active || raw.data?.activeListings;
  const records = Array.isArray(active)
    ? active
    : Array.isArray(active?.results)
      ? active.results
      : Array.isArray(active?.items)
        ? active.items
        : [];
  return records
    .map((item) => normalizeActiveListing(item, context))
    .filter((record) => record && isBenchmarkTitle(record.title, context.playerName));
}

function normalizeActiveListing(item, context) {
  const askingPrice = numberFrom(item.price ?? item.current_price ?? item.currentPrice ?? item.askingPrice ?? item.amount ?? item.value);
  const shippingPrice = numberFrom(item.shipping ?? item.shipping_price ?? item.shippingPrice);
  const title = String(item.title || item.name || item.itemTitle || "").trim();
  const itemUrl = item.url || item.link || item.itemUrl || "";
  const itemId = String(item.item_id || item.itemId || item.id || "").trim();
  if (!title && !Number.isFinite(askingPrice)) return null;
  const totalAskPrice = (Number.isFinite(askingPrice) ? askingPrice : 0) + (Number.isFinite(shippingPrice) ? shippingPrice : 0);
  return {
    ...context,
    source: SOURCE,
    title,
    askingPrice: Number.isFinite(askingPrice) ? askingPrice : null,
    shippingPrice: Number.isFinite(shippingPrice) ? shippingPrice : null,
    totalAskPrice: Number.isFinite(totalAskPrice) && totalAskPrice > 0 ? totalAskPrice : null,
    listingType: listingType(item),
    itemUrl,
    itemId,
    sellerUsername: item.seller || item.sellerUsername || item.seller_username || "",
    dedupeKey: itemId
      ? `${context.playerId}:active:item:${itemId}`
      : `${context.playerId}:active:${normalizeText(title)}:${totalAskPrice}:${itemUrl}`,
    rawJson: JSON.stringify(item),
  };
}

function buildSnapshot({ player, benchmarkCardCode, canonicalQuery, soldRecords, activeListings, raw, now }) {
  const sold30 = recordsInWindow(soldRecords, 30, now);
  const sold90 = recordsInWindow(soldRecords, 90, now);
  const activePrices = activeListings.map((row) => row.totalAskPrice).filter(Number.isFinite).sort((a, b) => a - b);
  const activeListingCount = activeListings.length || activeListingCountFromRaw(raw);
  const hasActiveSupport = Number.isFinite(activeListingCount) || activeListings.length > 0;
  const sellThru30 = Number.isFinite(activeListingCount) && activeListingCount > 0 ? sold30.length / activeListingCount : null;
  const sellThru90 = Number.isFinite(activeListingCount) && activeListingCount > 0 ? sold90.length / activeListingCount : null;

  return {
    playerId: player.player_id,
    playerName: player.player_name,
    team: player.org,
    rank: numberFrom(player.prospect_rank),
    benchmarkCardCode,
    canonicalQuery,
    source: SOURCE,
    salesCount30d: sold30.length,
    salesCount90d: sold90.length,
    avgSoldPrice30d: average(sold30.map((row) => row.soldPrice)),
    avgSoldPrice90d: average(sold90.map((row) => row.soldPrice)),
    medianSoldPrice30d: median(sold30.map((row) => row.soldPrice)),
    medianSoldPrice90d: median(sold90.map((row) => row.soldPrice)),
    lowSoldPrice30d: minValue(sold30.map((row) => row.soldPrice)),
    highSoldPrice30d: maxValue(sold30.map((row) => row.soldPrice)),
    lowSoldPrice90d: minValue(sold90.map((row) => row.soldPrice)),
    highSoldPrice90d: maxValue(sold90.map((row) => row.soldPrice)),
    lastSoldPrice: soldRecords[0]?.soldPrice ?? null,
    lastSoldAt: soldRecords[0]?.soldAt ?? null,
    activeListingCount: Number.isFinite(activeListingCount) ? activeListingCount : null,
    activeLowestAsk: activePrices[0] ?? null,
    activeMedianAsk: median(activePrices),
    activeHighestAsk: activePrices.at(-1) ?? null,
    activeAuctionCount: activeListings.filter((row) => row.listingType === "auction").length || null,
    activeBuyItNowCount: activeListings.filter((row) => row.listingType === "buy_it_now").length || null,
    activeDataUpdatedAt: hasActiveSupport ? now.toISOString() : null,
    activeListingSupported: hasActiveSupport ? 1 : 0,
    sellThruRate30d: sellThru30,
    sellThruRate90d: sellThru90,
    soldRefreshedAt: now.toISOString(),
    checkedAt: now.toISOString(),
    rawSummaryJson: JSON.stringify({ activeListingFieldsSeen: activeListings.length > 0, rawKeys: Object.keys(raw || {}) }),
  };
}

async function writeSoldRecords(db, records) {
  let inserted = 0;
  let duplicates = 0;
  for (const row of records) {
    const result = await db.prepare(`
      INSERT OR IGNORE INTO market_sold_records (
        player_id, player_name, benchmark_card_code, canonical_query, source, title,
        sold_price, sold_at, item_url, item_id, dedupe_key, raw_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      row.playerId,
      row.playerName,
      row.benchmarkCardCode,
      row.canonicalQuery,
      row.source,
      row.title,
      row.soldPrice,
      row.soldAt,
      row.itemUrl,
      row.itemId,
      row.dedupeKey,
      row.rawJson,
    ).run();
    if (result.meta?.changes) inserted += 1;
    else duplicates += 1;
  }
  return { inserted, duplicates };
}

async function writeActiveListings(db, records) {
  let inserted = 0;
  let duplicates = 0;
  const observedAt = new Date().toISOString();
  for (const row of records) {
    const result = await db.prepare(`
      INSERT OR IGNORE INTO active_listings (
        player_id, player_name, benchmark_card_code, canonical_query, source, title,
        asking_price, shipping_price, total_ask_price, listing_type, item_url,
        item_id, seller_username, dedupe_key, raw_json, observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      row.playerId,
      row.playerName,
      row.benchmarkCardCode,
      row.canonicalQuery,
      row.source,
      row.title,
      row.askingPrice,
      row.shippingPrice,
      row.totalAskPrice,
      row.listingType,
      row.itemUrl,
      row.itemId,
      row.sellerUsername,
      row.dedupeKey,
      row.rawJson,
      observedAt,
    ).run();
    if (result.meta?.changes) inserted += 1;
    else duplicates += 1;
  }
  return { inserted, duplicates };
}

async function writeSnapshot(db, row) {
  await db.prepare(`
    INSERT INTO market_player_snapshots (
      player_id, player_name, team, rank, benchmark_card_code, canonical_query, source,
      sales_count_30d, sales_count_90d, avg_sold_price_30d, avg_sold_price_90d,
      median_sold_price_30d, median_sold_price_90d, low_sold_price_30d, high_sold_price_30d,
      low_sold_price_90d, high_sold_price_90d, last_sold_price, last_sold_at,
      active_listing_count, active_lowest_ask, active_median_ask, active_highest_ask,
      active_auction_count, active_buy_it_now_count, active_data_updated_at, active_listing_supported,
      sell_thru_rate_30d, sell_thru_rate_90d, sold_refreshed_at, checked_at, raw_summary_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(player_id) DO UPDATE SET
      player_name = excluded.player_name,
      team = excluded.team,
      rank = excluded.rank,
      benchmark_card_code = excluded.benchmark_card_code,
      canonical_query = excluded.canonical_query,
      source = excluded.source,
      sales_count_30d = excluded.sales_count_30d,
      sales_count_90d = excluded.sales_count_90d,
      avg_sold_price_30d = excluded.avg_sold_price_30d,
      avg_sold_price_90d = excluded.avg_sold_price_90d,
      median_sold_price_30d = excluded.median_sold_price_30d,
      median_sold_price_90d = excluded.median_sold_price_90d,
      low_sold_price_30d = excluded.low_sold_price_30d,
      high_sold_price_30d = excluded.high_sold_price_30d,
      low_sold_price_90d = excluded.low_sold_price_90d,
      high_sold_price_90d = excluded.high_sold_price_90d,
      last_sold_price = excluded.last_sold_price,
      last_sold_at = excluded.last_sold_at,
      active_listing_count = excluded.active_listing_count,
      active_lowest_ask = excluded.active_lowest_ask,
      active_median_ask = excluded.active_median_ask,
      active_highest_ask = excluded.active_highest_ask,
      active_auction_count = excluded.active_auction_count,
      active_buy_it_now_count = excluded.active_buy_it_now_count,
      active_data_updated_at = excluded.active_data_updated_at,
      active_listing_supported = excluded.active_listing_supported,
      sell_thru_rate_30d = excluded.sell_thru_rate_30d,
      sell_thru_rate_90d = excluded.sell_thru_rate_90d,
      sold_refreshed_at = excluded.sold_refreshed_at,
      checked_at = excluded.checked_at,
      raw_summary_json = excluded.raw_summary_json,
      updated_at = CURRENT_TIMESTAMP
  `).bind(
    row.playerId,
    row.playerName,
    row.team,
    row.rank,
    row.benchmarkCardCode,
    row.canonicalQuery,
    row.source,
    row.salesCount30d,
    row.salesCount90d,
    row.avgSoldPrice30d,
    row.avgSoldPrice90d,
    row.medianSoldPrice30d,
    row.medianSoldPrice90d,
    row.lowSoldPrice30d,
    row.highSoldPrice30d,
    row.lowSoldPrice90d,
    row.highSoldPrice90d,
    row.lastSoldPrice,
    row.lastSoldAt,
    row.activeListingCount,
    row.activeLowestAsk,
    row.activeMedianAsk,
    row.activeHighestAsk,
    row.activeAuctionCount,
    row.activeBuyItNowCount,
    row.activeDataUpdatedAt,
    row.activeListingSupported,
    row.sellThruRate30d,
    row.sellThruRate90d,
    row.soldRefreshedAt,
    row.checkedAt,
    row.rawSummaryJson,
  ).run();
}

async function readSnapshot(db, playerId) {
  return db.prepare(`SELECT * FROM market_player_snapshots WHERE player_id = ?`).bind(playerId).first();
}

function snapshotTargetIsDisplayable(row, cardByPlayerId, cardByName) {
  const target = cardByPlayerId.get(String(row.player_id)) || cardByName.get(normalizeName(row.player_name));
  return !target || isEnabledCardTarget(target);
}

function isEnabledCardTarget(row) {
  return String(row?.enabled ?? "true").toLowerCase() !== "false" && String(row?.card_code || "").trim() !== "";
}

function snapshotRowToApi(row) {
  return {
    playerId: row.player_id,
    playerName: row.player_name,
    team: row.team,
    rank: row.rank,
    benchmarkCardCode: row.benchmark_card_code,
    canonicalQuery: row.canonical_query,
    source: row.source,
    salesCount30d: row.sales_count_30d,
    salesCount90d: row.sales_count_90d,
    avgSoldPrice30d: row.avg_sold_price_30d,
    avgSoldPrice90d: row.avg_sold_price_90d,
    medianSoldPrice30d: row.median_sold_price_30d,
    medianSoldPrice90d: row.median_sold_price_90d,
    lowSoldPrice30d: row.low_sold_price_30d,
    highSoldPrice30d: row.high_sold_price_30d,
    lowSoldPrice90d: row.low_sold_price_90d,
    highSoldPrice90d: row.high_sold_price_90d,
    lastSoldPrice: row.last_sold_price,
    lastSoldAt: row.last_sold_at,
    activeListingCount: row.active_listing_count,
    activeLowestAsk: row.active_lowest_ask,
    activeMedianAsk: row.active_median_ask,
    activeHighestAsk: row.active_highest_ask,
    activeAuctionCount: row.active_auction_count,
    activeBuyItNowCount: row.active_buy_it_now_count,
    activeDataUpdatedAt: row.active_data_updated_at,
    sellThruRate30d: row.sell_thru_rate_30d,
    sellThruRate90d: row.sell_thru_rate_90d,
    soldRefreshedAt: row.sold_refreshed_at,
    checkedAt: row.checked_at,
  };
}

async function readCsvAsset(context, pathname) {
  if (!context.env?.ASSETS) return [];
  const requestUrl = new URL(context.request.url);
  requestUrl.pathname = pathname;
  requestUrl.search = "";
  const response = await context.env.ASSETS.fetch(new Request(requestUrl.toString()));
  if (!response.ok) throw new Error(`Unable to read ${pathname}: ${response.status}`);
  return parseCsv(await response.text());
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
      if (row.some((value) => value.trim() !== "")) rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (field || row.length) {
    row.push(field);
    if (row.some((value) => value.trim() !== "")) rows.push(row);
  }
  const [headers = [], ...records] = rows;
  return records.map((record) => Object.fromEntries(headers.map((header, index) => [normalizeHeader(header), coerce(record[index] ?? "")])));
}

function isBenchmarkTitle(title, playerName) {
  const normalizedTitle = normalizeText(title);
  if (!normalizedTitle) return true;
  const hasPlayer = normalizeText(playerName).split(" ").filter(Boolean).every((token) => normalizedTitle.includes(token));
  const hasBowman = normalizedTitle.includes("bowman");
  const hasChrome = normalizedTitle.includes("chrome");
  const hasAuto = /\b(auto|autograph)\b/.test(normalizedTitle);
  const excluded = EXCLUDED_TITLE_TERMS.some((term) => normalizedTitle.includes(term));
  const numberedPattern = /(^|[^a-z0-9])\/\d{1,4}([^a-z0-9]|$)|\b\d{1,4}\s*\/\s*\d{1,4}\b/.test(normalizedTitle);
  return hasPlayer && hasBowman && hasChrome && hasAuto && !excluded && !numberedPattern;
}

function recordsInWindow(records, days, now) {
  const cutoff = new Date(now.getTime() - days * 86400000).getTime();
  return records.filter((row) => new Date(`${row.soldAt}T00:00:00Z`).getTime() >= cutoff);
}

function listingType(item) {
  const value = normalizeText(item.listing_type || item.listingType || item.format || item.type);
  if (value.includes("auction")) return "auction";
  if (value.includes("buy") || value.includes("fixed")) return "buy_it_now";
  return "";
}

function activeListingCountFromRaw(raw) {
  const direct = numberFrom(raw.active_listings ?? raw.activeListings ?? raw.active_count ?? raw.activeCount ?? raw.summary?.activeListings ?? raw.summary?.active_count);
  return Number.isFinite(direct) ? direct : null;
}

function extractArray(raw, paths) {
  for (const path of paths) {
    const value = path.split(".").reduce((current, key) => current?.[key], raw);
    if (Array.isArray(value)) return value;
  }
  return [];
}

function median(values) {
  const clean = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!clean.length) return null;
  const mid = Math.floor(clean.length / 2);
  return clean.length % 2 ? clean[mid] : roundMoney((clean[mid - 1] + clean[mid]) / 2);
}

function average(values) {
  const clean = values.filter(Number.isFinite);
  return clean.length ? roundMoney(clean.reduce((sum, value) => sum + value, 0) / clean.length) : null;
}

function minValue(values) {
  const clean = values.filter(Number.isFinite);
  return clean.length ? Math.min(...clean) : null;
}

function maxValue(values) {
  const clean = values.filter(Number.isFinite);
  return clean.length ? Math.max(...clean) : null;
}

function normalizeDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

function ageDays(value, now) {
  return (now - new Date(value)) / 86400000;
}

function ageHours(value, now) {
  return (now - new Date(value)) / 3600000;
}

function numberFrom(value) {
  const cleaned = String(value ?? "").replaceAll(/[^0-9.-]/g, "");
  if (!cleaned) return NaN;
  const numeric = Number(cleaned);
  return Number.isFinite(numeric) ? numeric : NaN;
}

function roundMoney(value) {
  return Math.round(Number(value) * 100) / 100;
}

function normalizeHeader(value) {
  return String(value).trim().toLowerCase().replaceAll(/\s+/g, "_");
}

function coerce(value) {
  const text = String(value ?? "").trim();
  if (text === "") return "";
  const numeric = Number(text);
  return /^-?\d+(\.\d+)?$/.test(text) && Number.isFinite(numeric) ? numeric : text;
}

function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replaceAll(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9/]+/g, " ")
    .trim();
}

function normalizeName(value) {
  return normalizeText(value).replaceAll(/[^a-z0-9]+/g, " ").trim();
}

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
  });
}
