export async function onRequest(context) {
  if (context.request.method !== "GET") {
    return jsonResponse({ error: "Method not allowed" }, 405, { Allow: "GET" });
  }

  const db = context.env?.MARKET_DB;
  if (!db) {
    return jsonResponse({ error: "MARKET_DB D1 binding is not configured." }, 503);
  }

  const url = new URL(context.request.url);
  const player = String(url.searchParams.get("player") || "").trim();
  const cardCode = String(url.searchParams.get("cardCode") || "").trim();
  if (!player && !cardCode) {
    return jsonResponse({ error: "Missing player or cardCode query parameter." }, 400);
  }

  const playerKey = player ? `name:${normalizeName(player)}` : "";
  const days = Math.max(30, Math.min(730, Number(url.searchParams.get("days")) || 365));
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

  const where = cardCode
    ? "card_code = ? AND sale_date >= ?"
    : "player_key = ? AND sale_date >= ?";
  const value = cardCode || playerKey;

  const rows = await db.prepare(`
    SELECT
      sale_date,
      ROUND(AVG(sale_price), 2) AS avg_price,
      SUM(sales_count) AS sales_count,
      MIN(sale_price) AS low_price,
      MAX(sale_price) AS high_price
    FROM card_sales_history
    WHERE ${where}
    GROUP BY sale_date
    ORDER BY sale_date ASC
  `).bind(value, since).all();

  const summary = await db.prepare(`
    SELECT
      COUNT(*) AS rows_count,
      ROUND(AVG(sale_price), 2) AS avg_price,
      SUM(sales_count) AS sales_count,
      MIN(sale_price) AS low_price,
      MAX(sale_price) AS high_price,
      MIN(sale_date) AS first_sale_date,
      MAX(sale_date) AS last_sale_date
    FROM card_sales_history
    WHERE ${where}
  `).bind(value, since).first();

  return jsonResponse({
    player,
    cardCode,
    days,
    summary: summary || {},
    points: rows.results || [],
  });
}

function normalizeName(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replaceAll(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, " ")
    .trim();
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
