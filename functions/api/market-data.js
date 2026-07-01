const SOLD_COMPS_API_URL = "https://api.sold-comps.com/v1/scrape";
const BENCHMARK_CARD = "Bowman Chrome 1st Auto";
const MARKET_CACHE_SECONDS = 60 * 60 * 24 * 7;
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

  const apiKey = context.env?.SOLD_COMPS_API_KEY || globalThis.process?.env?.SOLD_COMPS_API_KEY;
  if (!apiKey) {
    return jsonResponse({ error: "SOLD_COMPS_API_KEY is not configured." }, 503);
  }

  try {
    const keyword = buildCanonicalKeyword(player);
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

    const response = jsonResponse(summarizeMarketData(raw, { player, keyword }), 200, {
      "Cache-Control": `public, max-age=300, s-maxage=${MARKET_CACHE_SECONDS}`,
      "X-Market-Cache": "MISS",
    });
    await writeMarketCache(context, keyword, response.clone());
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

async function readMarketCache(context, keyword) {
  if (!globalThis.caches?.default) return null;
  const response = await globalThis.caches.default.match(marketCacheRequest(context, keyword));
  if (!response) return null;
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
  return new Request(requestUrl.toString(), { method: "GET" });
}

function marketCacheWeek(date = new Date()) {
  const start = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const day = Math.floor((date - start) / 86400000);
  return `${date.getUTCFullYear()}-${String(Math.floor(day / 7) + 1).padStart(2, "0")}`;
}

function buildCanonicalKeyword(player) {
  return `${player} ${BENCHMARK_CARD}`;
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
  const activeListings = numberFrom(raw.active_listings ?? raw.activeListings ?? raw.summary?.activeListings);
  const sales30 = countForWindow(comps, 30, raw.sales_30 ?? raw.sales30 ?? raw.summary?.sales30);
  const sellThrough = Number.isFinite(activeListings) && activeListings > 0
    ? Math.round((sales30 / (sales30 + activeListings)) * 100)
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
