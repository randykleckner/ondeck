const DEFAULT_SOLD_COMPS_API_URL = "https://api.soldcomps.com/v1/market-data";

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const player = String(req.query.player || "").trim();
  const cardCode = String(req.query.cardCode || req.query.card_code || "").trim();
  const cardName = String(req.query.cardName || req.query.card_name || "").trim();

  if (!player) {
    return res.status(400).json({ error: "Missing required player query parameter." });
  }

  const apiKey = process.env.SOLD_COMPS_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: "SOLD_COMPS_API_KEY is not configured." });
  }

  try {
    const upstreamUrl = buildSoldCompsUrl({ player, cardCode, cardName });
    const upstreamResponse = await fetch(upstreamUrl, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    });

    const rawText = await upstreamResponse.text();
    const raw = rawText ? JSON.parse(rawText) : {};

    if (!upstreamResponse.ok) {
      return res.status(upstreamResponse.status).json({
        error: "SoldComps request failed.",
        status: upstreamResponse.status,
        detail: safeErrorDetail(raw),
      });
    }

    return res.status(200).json(summarizeMarketData(raw, { player, cardCode, cardName }));
  } catch (error) {
    return res.status(500).json({
      error: "Unable to load market data.",
      detail: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

function buildSoldCompsUrl({ player, cardCode, cardName }) {
  const baseUrl = process.env.SOLD_COMPS_API_URL || DEFAULT_SOLD_COMPS_API_URL;
  const url = new URL(baseUrl);
  const query = [player, cardCode, cardName].filter(Boolean).join(" ");
  url.searchParams.set("player", player);
  url.searchParams.set("q", query);
  if (cardCode) url.searchParams.set("cardCode", cardCode);
  if (cardName) url.searchParams.set("cardName", cardName);
  return url;
}

function summarizeMarketData(raw, request) {
  const comps = extractComps(raw)
    .map(normalizeComp)
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
    cardCode: request.cardCode || raw.card_code || raw.cardCode || "",
    cardName: request.cardName || raw.card_name || raw.cardName || "",
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
    source: "SoldComps API",
    sourceUrl: raw.source_url || raw.sourceUrl || "",
    lastUpdated: new Date().toISOString(),
  };
}

function extractComps(raw) {
  if (Array.isArray(raw)) return raw;
  return raw.results || raw.data || raw.comps || raw.sales || raw.items || [];
}

function normalizeComp(comp) {
  return {
    price: numberFrom(comp.price ?? comp.sale_price ?? comp.salePrice ?? comp.sold_price ?? comp.soldPrice ?? comp.amount ?? comp.value),
    soldAt: comp.sold_at || comp.soldAt || comp.sale_date || comp.saleDate || comp.date || comp.ended_at || comp.endedAt || "",
    title: comp.title || comp.name || "",
    url: comp.url || comp.link || "",
  };
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
  const numeric = Number(String(value ?? "").replace(/[^0-9.-]/g, ""));
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
