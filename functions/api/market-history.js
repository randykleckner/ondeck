export async function onRequest(context) {
  if (context.request.method !== "GET") {
    return jsonResponse({ error: "Method not allowed" }, 405, { Allow: "GET" });
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

  const db = context.env?.MARKET_DB;
  if (!db) {
    return marketHistoryFromStaticCsv(context, { player, cardCode, days, since });
  }

  const where = cardCode
    ? "card_code = ? AND sale_date >= ?"
    : "player_key = ? AND sale_date >= ?";
  const value = cardCode || playerKey;

  try {
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
      source: "D1",
      summary: summary || {},
      points: rows.results || [],
    });
  } catch {
    return marketHistoryFromStaticCsv(context, { player, cardCode, days, since });
  }
}

async function marketHistoryFromStaticCsv(context, { player, cardCode, days, since }) {
  const csv = await readStaticHistoryCsv(context);
  if (!csv) {
    return jsonResponse({ error: "Historical card data is not available yet." }, 503);
  }

  const playerKey = player ? `name:${normalizeName(player)}` : "";
  const rows = parseCsv(csv)
    .filter((row) => {
      if (row.sale_date < since) return false;
      if (cardCode) return normalizeCode(row.card_code) === normalizeCode(cardCode);
      return row.player_key === playerKey;
    })
    .map((row) => ({
      sale_date: row.sale_date,
      sale_price: Number(row.sale_price),
      sales_count: Number(row.sales_count) || 1,
    }))
    .filter((row) => row.sale_date && Number.isFinite(row.sale_price));

  const grouped = new Map();
  for (const row of rows) {
    const current = grouped.get(row.sale_date) ?? {
      sale_date: row.sale_date,
      total_price: 0,
      rows_count: 0,
      sales_count: 0,
      low_price: row.sale_price,
      high_price: row.sale_price,
    };
    current.total_price += row.sale_price;
    current.rows_count += 1;
    current.sales_count += row.sales_count;
    current.low_price = Math.min(current.low_price, row.sale_price);
    current.high_price = Math.max(current.high_price, row.sale_price);
    grouped.set(row.sale_date, current);
  }

  const points = [...grouped.values()]
    .sort((a, b) => a.sale_date.localeCompare(b.sale_date))
    .map((row) => ({
      sale_date: row.sale_date,
      avg_price: roundMoney(row.total_price / row.rows_count),
      sales_count: row.sales_count,
      low_price: roundMoney(row.low_price),
      high_price: roundMoney(row.high_price),
    }));

  const prices = rows.map((row) => row.sale_price);
  const summary = {
    rows_count: rows.length,
    avg_price: prices.length ? roundMoney(prices.reduce((sum, value) => sum + value, 0) / prices.length) : null,
    sales_count: rows.reduce((sum, row) => sum + row.sales_count, 0),
    low_price: prices.length ? roundMoney(Math.min(...prices)) : null,
    high_price: prices.length ? roundMoney(Math.max(...prices)) : null,
    first_sale_date: points[0]?.sale_date || null,
    last_sale_date: points.at(-1)?.sale_date || null,
  };

  return jsonResponse({
    player,
    cardCode,
    days,
    source: "static_csv",
    summary,
    points,
  }, 200, {
    "Cache-Control": "public, max-age=300",
  });
}

async function readStaticHistoryCsv(context) {
  const requestUrl = new URL(context.request.url);
  requestUrl.pathname = "/data/historical-card-sales.csv";
  requestUrl.search = "";

  if (context.env?.ASSETS) {
    const response = await context.env.ASSETS.fetch(new Request(requestUrl.toString(), { method: "GET" }));
    if (response.ok) return response.text();
  }

  try {
    const response = await fetch(requestUrl.toString());
    return response.ok ? response.text() : "";
  } catch {
    return "";
  }
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

  const [headers = [], ...records] = rows.filter((values) => values.some((value) => String(value).trim()));
  return records.map((record) => Object.fromEntries(headers.map((header, index) => [header.trim(), record[index]?.trim() ?? ""])));
}

function normalizeCode(value) {
  return String(value ?? "").trim().toUpperCase();
}

function roundMoney(value) {
  return Math.round(Number(value) * 100) / 100;
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
