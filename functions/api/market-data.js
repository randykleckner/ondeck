const SOLD_COMPS_API_URL = "https://api.sold-comps.com/v1/scrape";
const BENCHMARK_CARD = "Bowman Chrome 1st Auto";
const MARKET_CACHE_SECONDS = 60 * 60 * 24 * 7;
const MARKET_CACHE_VERSION = "v3";
const PLAYER_SEARCH_ALIASES = new Map([
  ["joshua baez", "Joshua Báez"],
]);
const EXCLUDED_TITLE_TERMS = [
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
  "numbered",
  "insert",
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
];

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const player = String(url.searchParams.get("player") || "").trim();

  if (!player) {
    return jsonResponse({ error: "Missing required player query parameter." }, 400);
  }

  const keyword = buildCanonicalKeyword(player);
  const storedFresh = await readMarketDatabase(context, keyword, { freshOnly: true });
  if (storedFresh) return storedFresh;

  const apiKey = context.env?.SOLD_COMPS_API_KEY || globalThis.process?.env?.SOLD_COMPS_API_KEY;
  if (!apiKey) {
    const storedStale = await readMarketDatabase(context, keyword, { freshOnly: false });
    if (storedStale) return storedStale;
    return jsonResponse({ error: "SOLD_COMPS_API_KEY is not configured." }, 503);
  }

  try {
    const cachedResponse = await readMarketCache(context, keyword);
    if (cachedResponse) return cachedResponse;

    const upstreamUrl = buildSoldCompsUrl(keyword);
    const upstreamResponse = await fetch(upstreamUrl, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    });

    const rawText = await upstreamResponse.text();
    const raw = rawText ? JSON.parse(rawText) : {};

    if (!upstreamResponse.ok) {
      return jsonResponse({
        error: "SoldComps request failed.",
        status: upstreamResponse.status,
        detail: safeErrorDetail(raw),
      }, upstreamResponse.status);
    }

    const summary = summarizeMarketData(raw, { player, keyword });
    const response = jsonResponse(summary, 200, {
      "Cache-Control": `public, max-age=300, s-maxage=${MARKET_CACHE_SECONDS}`,
      "X-Market-Cache": "MISS",
    });
    if (hasMarketComps(summary)) {
      await writeMarketDatabase(context, summary);
      await writeMarketCache(context, keyword, response.clone());
    }
    return response;
  } catch (error) {
    return jsonResponse({
      error: "Unable to load market data.",
      detail: error instanceof Error ? error.message : "Unknown error",
    }, 500);
  }
}

export async function onRequest(context) {
  if (context.request.method === "GET") {
    return onRequestGet(context);
  }
  return jsonResponse({ error: "Method not allowed" }, 405, { Allow: "GET" });
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

async function readMarketDatabase(context, keyword, options = {}) {
  const db = context.env?.MARKET_DB;
  if (!db) return null;
  try {
    const minFetchedAt = new Date(Date.now() - MARKET_CACHE_SECONDS * 1000).toISOString();
    const query = options.freshOnly
      ? `select response_json, fetched_at from market_snapshots where keyword = ? and fetched_at >= ? order by fetched_at desc limit 1`
      : `select response_json, fetched_at from market_snapshots where keyword = ? order by fetched_at desc limit 1`;
    const statement = options.freshOnly ? db.prepare(query).bind(keyword, minFetchedAt) : db.prepare(query).bind(keyword);
    const row = await statement.first();
    if (!row?.response_json) return null;
    const data = JSON.parse(row.response_json);
    if (!hasMarketComps(data)) return null;
    data.cache = {
      source: options.freshOnly ? "D1 fresh" : "D1 stale",
      fetchedAt: row.fetched_at,
    };
    return jsonResponse(data, 200, {
      "Cache-Control": options.freshOnly ? `public, max-age=300, s-maxage=${MARKET_CACHE_SECONDS}` : "public, max-age=60",
      "X-Market-Store": options.freshOnly ? "D1-HIT" : "D1-STALE",
    });
  } catch (error) {
    return null;
  }
}

async function writeMarketDatabase(context, summary) {
  const db = context.env?.MARKET_DB;
  if (!db) return;
  const fetchedAt = new Date().toISOString();
  try {
    await db.prepare(`
    insert into market_snapshots (
      player,
      keyword,
      card_name,
      last_sale,
      last_sale_date,
      avg_7,
      avg_14,
      avg_30,
      sales_7,
      sales_14,
      sales_30,
      market_signal,
      recommendation,
      response_json,
      fetched_at,
      cache_week
    )
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(keyword, cache_week) do update set
      player = excluded.player,
      card_name = excluded.card_name,
      last_sale = excluded.last_sale,
      last_sale_date = excluded.last_sale_date,
      avg_7 = excluded.avg_7,
      avg_14 = excluded.avg_14,
      avg_30 = excluded.avg_30,
      sales_7 = excluded.sales_7,
      sales_14 = excluded.sales_14,
      sales_30 = excluded.sales_30,
      market_signal = excluded.market_signal,
      recommendation = excluded.recommendation,
      response_json = excluded.response_json,
      fetched_at = excluded.fetched_at
  `).bind(
    summary.player,
    summary.keyword,
    summary.cardName,
    nullable(summary.lastSale),
    nullable(summary.lastSaleDate),
    nullable(summary.averages?.days7),
    nullable(summary.averages?.days14),
    nullable(summary.averages?.days30),
    nullable(summary.sales?.days7),
    nullable(summary.sales?.days14),
    nullable(summary.sales?.days30),
    summary.marketSignal,
    nullable(summary.recommendation?.label),
    JSON.stringify(summary),
    fetchedAt,
    marketCacheWeek(new Date(fetchedAt)),
  ).run();
  } catch (error) {
    // Missing migrations or transient D1 errors should not burn the profile request.
  }
}

function nullable(value) {
  return value === undefined ? null : value;
}

async function readMarketCache(context, keyword) {
  if (!globalThis.caches?.default) return null;
  const response = await globalThis.caches.default.match(marketCacheRequest(context, keyword));
  if (!response) return null;
  const data = await response.clone().json().catch(() => null);
  if (!hasMarketComps(data)) return null;
  const headers = new Headers(response.headers);
  headers.set("X-Market-Cache", "HIT");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function writeMarketCache(context, keyword, response) {
  if (!globalThis.caches?.default || response.status !== 200) return;
  const cacheResponse = new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  const cachePromise = globalThis.caches.default.put(marketCacheRequest(context, keyword), cacheResponse);
  if (context.waitUntil) {
    context.waitUntil(cachePromise);
    return;
  }
  await cachePromise;
}

function marketCacheRequest(context, keyword) {
  const requestUrl = new URL(context.request.url);
  requestUrl.pathname = "/api/market-data-cache";
  requestUrl.search = "";
  requestUrl.searchParams.set("keyword", keyword);
  requestUrl.searchParams.set("week", marketCacheWeek());
  requestUrl.searchParams.set("version", MARKET_CACHE_VERSION);
  return new Request(requestUrl.toString(), { method: "GET" });
}

function marketCacheWeek(date = new Date()) {
  const start = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const day = Math.floor((date - start) / 86400000);
  return `${date.getUTCFullYear()}-${String(Math.floor(day / 7) + 1).padStart(2, "0")}`;
}

function buildCanonicalKeyword(player) {
  const searchName = PLAYER_SEARCH_ALIASES.get(normalizeText(player)) || player;
  return `${searchName} ${BENCHMARK_CARD}`;
}

function buildSoldCompsUrl(keyword) {
  const url = new URL(SOLD_COMPS_API_URL);
  url.searchParams.set("keyword", keyword);
  return url;
}

function summarizeMarketData(raw, request) {
  const comps = extractComps(raw)
    .map(normalizeComp)
    .filter((comp) => isBenchmarkComp(comp, request.player))
    .filter((comp) => Number.isFinite(comp.price))
    .sort((a, b) => timestamp(b.soldAt) - timestamp(a.soldAt));

  const lastComp = comps[0] || null;
  const avg7 = averageForWindow(comps, 7);
  const avg14 = averageForWindow(comps, 14);
  const avg30 = averageForWindow(comps, 30);
  const activeListings = activeListingCount(raw, request.player);
  const sales30 = countForWindow(comps, 30, raw.sales_30 ?? raw.sales30 ?? raw.summary?.sales30);
  const sellThrough = Number.isFinite(activeListings) && activeListings > 0
    ? roundPercent((sales30 / (sales30 + activeListings)) * 100)
    : null;
  const buyZone = makeBuyZone(avg30.average || lastComp?.price);
  const recommendation = makeRecommendation({
    lastSale: lastComp?.price,
    avg7: avg7.average,
    avg30: avg30.average,
    sales30,
  });

  return {
    player: request.player,
    keyword: request.keyword,
    cardCode: "",
    cardName: BENCHMARK_CARD,
    lastSale: lastComp?.price ?? null,
    lastSaleDate: lastComp?.soldAt ?? null,
    averages: {
      days7: avg7.average,
      days14: avg14.average,
      days30: avg30.average,
    },
    sales: {
      days7: avg7.count,
      days14: avg14.count,
      days30: sales30,
    },
    activeListings: Number.isFinite(activeListings) ? activeListings : null,
    sellThrough,
    sellThrough30: sellThrough,
    sellThrough90: numberFrom(raw.sell_through_90 ?? raw.sellThrough90 ?? raw.summary?.sellThrough90),
    buyZone,
    recommendation,
    marketSignal: recommendation.signal,
    marketNote: recommendation.note,
    excludedTerms: EXCLUDED_TITLE_TERMS,
    source: "SoldComps API",
    sourceUrl: raw.source_url || raw.sourceUrl || "",
    lastUpdated: new Date().toISOString(),
  };
}

function activeListingCount(raw, player) {
  const direct = numberFrom(raw.active_listings ?? raw.activeListings ?? raw.active_count ?? raw.activeCount ?? raw.summary?.activeListings ?? raw.summary?.active_count);
  if (Number.isFinite(direct)) return direct;

  const listings = raw.active_listings || raw.activeListings || raw.active?.items || raw.active?.results || raw.listings || raw.items_active || raw.data?.activeListings;
  if (Array.isArray(listings)) {
    return listings
      .map(normalizeActiveListing)
      .filter((listing) => isBenchmarkComp(listing, player))
      .length;
  }

  if (listings && typeof listings === "object") {
    const nested = listings.results || listings.items || listings.data;
    if (Array.isArray(nested)) {
      return nested
        .map(normalizeActiveListing)
        .filter((listing) => isBenchmarkComp(listing, player))
        .length;
    }
    const count = numberFrom(listings.count ?? listings.total ?? listings.activeCount);
    if (Number.isFinite(count)) return count;
  }

  return NaN;
}

function normalizeActiveListing(listing) {
  return {
    title: listing.title || listing.name || listing.itemTitle || "",
    price: numberFrom(listing.price ?? listing.current_price ?? listing.currentPrice ?? listing.amount ?? listing.value),
    soldAt: "",
    url: listing.url || listing.link || "",
  };
}

function roundPercent(value) {
  return Math.round(Number(value) * 10) / 10;
}

function extractComps(raw) {
  if (Array.isArray(raw)) return raw;
  return raw.results || raw.data?.results || raw.data?.items || raw.data || raw.comps || raw.sales || raw.items || [];
}

function normalizeComp(comp) {
  return {
    price: numberFrom(comp.price ?? comp.sale_price ?? comp.salePrice ?? comp.sold_price ?? comp.soldPrice ?? comp.amount ?? comp.value),
    soldAt: comp.sold_at || comp.soldAt || comp.sale_date || comp.saleDate || comp.date || comp.ended_at || comp.endedAt || "",
    title: comp.title || comp.name || "",
    url: comp.url || comp.link || "",
  };
}

function isBenchmarkComp(comp, player) {
  const title = String(comp.title || "").toLowerCase();
  if (!title) return true;
  const normalizedPlayer = normalizeText(player);
  const normalizedTitle = normalizeText(title);
  const playerTokens = normalizedPlayer.split(" ").filter(Boolean);
  const hasPlayer = playerTokens.every((token) => normalizedTitle.includes(token));
  const hasBowman = normalizedTitle.includes("bowman");
  const hasChrome = normalizedTitle.includes("chrome");
  const hasAuto = /\b(auto|autograph)\b/.test(normalizedTitle);
  const hasFirst = /\b(1st|first)\b/.test(normalizedTitle);
  const hasExcludedTerm = EXCLUDED_TITLE_TERMS.some((term) => normalizedTitle.includes(term));
  const hasNumberedPattern = /(^|[^a-z0-9])\/\d{1,4}([^a-z0-9]|$)|\b\d{1,4}\s*\/\s*\d{1,4}\b/.test(normalizedTitle);
  return hasPlayer && hasBowman && hasChrome && hasAuto && hasFirst && !hasExcludedTerm && !hasNumberedPattern;
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function averageForWindow(comps, days) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const windowComps = comps.filter((comp) => {
    const soldAt = timestamp(comp.soldAt);
    return soldAt ? soldAt >= cutoff : days === 30;
  });
  const prices = windowComps.map((comp) => comp.price).filter(Number.isFinite);
  return {
    average: prices.length ? roundMoney(prices.reduce((sum, price) => sum + price, 0) / prices.length) : null,
    count: prices.length,
  };
}

function countForWindow(comps, days, fallback) {
  const fallbackNumber = numberFrom(fallback);
  const count = averageForWindow(comps, days).count;
  if (count > 0) return count;
  return Number.isFinite(fallbackNumber) ? fallbackNumber : 0;
}

function makeBuyZone(value) {
  const numeric = numberFrom(value);
  if (!Number.isFinite(numeric)) return { low: null, high: null };
  return {
    low: roundMoney(numeric * 0.92),
    high: roundMoney(numeric * 1.03),
  };
}

function makeRecommendation({ lastSale, avg7, avg30, sales30 }) {
  if (!Number.isFinite(avg30) || !Number.isFinite(lastSale)) {
    return {
      label: "Watch",
      signal: "Watch",
      note: "SoldComps returned limited clean sales, so keep this as a watch until the comp base fills in.",
    };
  }

  const discount = ((avg30 - lastSale) / avg30) * 100;
  const shortTrend = Number.isFinite(avg7) ? ((avg7 - avg30) / avg30) * 100 : 0;
  if (discount >= 8 && sales30 >= 10) {
    return {
      label: "Good buy",
      signal: "Buy Watch",
      note: "Latest sale is meaningfully below the 30-day average with enough recent sales to trust the range.",
    };
  }
  if (shortTrend >= 10 && sales30 >= 10) {
    return {
      label: "Momentum watch",
      signal: "Momentum Watch",
      note: "Short-window pricing is moving above the 30-day average, so the market is heating up but the entry is less discounted.",
    };
  }
  if (lastSale > avg30 * 1.12) {
    return {
      label: "Watch",
      signal: "Priced In Watch",
      note: "Latest sale is already well above the 30-day average, so wait for a cleaner entry or a stronger baseball catalyst.",
    };
  }
  return {
    label: "Watch",
    signal: "Watch",
    note: "Pricing is close to the recent average; the better edge is waiting for a buy-zone entry tied to the next baseball catalyst.",
  };
}

function safeErrorDetail(raw) {
  if (!raw || typeof raw !== "object") return "";
  return raw.error || raw.message || raw.detail || "";
}

function numberFrom(value) {
  const cleaned = String(value ?? "").replace(/[^0-9.-]/g, "");
  if (!cleaned) return NaN;
  const numeric = Number(cleaned);
  return Number.isFinite(numeric) ? numeric : NaN;
}

function timestamp(value) {
  if (!value) return 0;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function roundMoney(value) {
  return Math.round(value * 100) / 100;
}

function hasMarketComps(summary) {
  if (!summary || typeof summary !== "object") return false;
  const lastSale = numberFrom(summary.lastSale ?? summary.last_sale);
  const sales30 = Number(summary.sales?.days30 ?? summary.sales_30);
  const avg30 = numberFrom(summary.averages?.days30 ?? summary.avg_30);
  return Number.isFinite(lastSale) || (Number.isFinite(avg30) && Number.isFinite(sales30) && sales30 > 0);
}
