const DEFAULT_TIERS = ["card_api_candidate", "emerging_a", "emerging_bplus", "emerging_b"];
const EXTRA_TIERS = ["emerging_watch", "low_priority"];
const TIER_LABELS = new Map([
  ["card_api_candidate", "Card Candidate"],
  ["emerging_a", "Emerging A"],
  ["emerging_bplus", "Emerging B+"],
  ["emerging_b", "Emerging B"],
  ["emerging_watch", "Emerging Watch"],
  ["low_priority", "Low Priority"],
  ["inactive_no_2026_stats", "Inactive - No 2026 Stats"],
  ["top100_removed", "Top 100 Removed"],
  ["called_up", "Called Up"],
]);

export async function onEmergingRequest(context) {
  if (context.request.method !== "GET") {
    return jsonResponse({ error: "Method not allowed." }, 405, { Allow: "GET" });
  }

  const db = context.env?.MARKET_DB;
  if (!db) {
    return emptyResponse("MARKET_DB is not configured; no current records found");
  }

  const url = new URL(context.request.url);
  const detailMatch = url.pathname.match(/^\/api\/emerging\/(\d+)$/);

  try {
    if (url.pathname === "/api/emerging/summary") return await emergingSummary(db);
    if (detailMatch) return await emergingDetail(db, Number(detailMatch[1]));
    if (url.pathname === "/api/emerging") return await emergingList(db, url);
    return jsonResponse({ error: "Not found." }, 404);
  } catch (error) {
    console.error("emerging route failed", safeError(error));
    return emptyResponse("No current records found");
  }
}

async function emergingSummary(db) {
  const counts = await db.prepare(`
    SELECT
      SUM(CASE WHEN tracking_group = 'emerging' AND status = 'active' AND priority_tier IN ('card_api_candidate', 'emerging_a', 'emerging_bplus', 'emerging_b') THEN 1 ELSE 0 END) AS active_emerging,
      SUM(CASE WHEN tracking_group = 'emerging' AND status = 'active' AND priority_tier = 'card_api_candidate' THEN 1 ELSE 0 END) AS card_api_candidates,
      SUM(CASE WHEN tracking_group = 'emerging' AND status = 'active' AND priority_tier = 'emerging_a' THEN 1 ELSE 0 END) AS emerging_a,
      SUM(CASE WHEN tracking_group = 'emerging' AND status = 'active' AND priority_tier = 'emerging_bplus' THEN 1 ELSE 0 END) AS emerging_bplus,
      SUM(CASE WHEN tracking_group = 'emerging' AND status = 'active' AND priority_tier = 'emerging_b' THEN 1 ELSE 0 END) AS emerging_b,
      SUM(CASE WHEN tracking_group = 'emerging' AND status = 'watch' AND priority_tier = 'emerging_watch' THEN 1 ELSE 0 END) AS watch,
      SUM(CASE WHEN tracking_group = 'emerging' AND status = 'watch' AND priority_tier = 'low_priority' THEN 1 ELSE 0 END) AS low_priority,
      SUM(CASE WHEN tracking_group = 'called_up' OR priority_tier = 'called_up' THEN 1 ELSE 0 END) AS called_up,
      SUM(CASE WHEN priority_tier = 'top100_removed' THEN 1 ELSE 0 END) AS top100_removed,
      SUM(CASE WHEN priority_tier = 'inactive_no_2026_stats' THEN 1 ELSE 0 END) AS inactive_no_2026_stats
    FROM player_tracking_status
  `).first();

  const dates = await db.prepare(`
    SELECT
      (SELECT MAX(finished_at) FROM pipeline_runs WHERE run_type = 'import_emerging_workbook') AS last_import_date,
      (SELECT MAX(snapshot_date) FROM player_stats_snapshots) AS last_stats_refresh_date,
      (SELECT MAX(snapshot_date) FROM card_market_snapshots) AS last_card_market_refresh_date
  `).first();

  return jsonResponse({
    summary: normalizeRow({ ...counts, ...dates }),
    status: "ok",
  }, 200, {
    "Cache-Control": "public, max-age=300",
  });
}

async function emergingList(db, url) {
  const filters = listFilters(url);
  const rows = await db.prepare(`
    ${latestCtes()}
    SELECT
      p.id AS player_id,
      ct.id AS card_target_id,
      p.player_name,
      p.normalized_name,
      p.mlbam_id,
      p.current_team,
      p.current_org,
      p.position,
      ct.year,
      ct.product,
      ct.auto_set,
      ct.auto_code,
      ct.card_number,
      ct.team_on_card,
      ct.card_query_seed,
      ct.source_url,
      pts.tracking_group,
      pts.priority_tier,
      pts.status,
      pts.notes AS tracking_notes,
      s.stats_role,
      s.level,
      s.team,
      s.age,
      s.hitter_pa,
      s.hitter_ops,
      s.hitter_hr,
      s.hitter_sb,
      s.hitter_bb_pct,
      s.hitter_k_pct,
      s.pitcher_ip,
      s.pitcher_era,
      s.pitcher_whip,
      s.pitcher_k_pct,
      s.pitcher_bb_pct,
      s.pitcher_k_minus_bb_pct,
      pre.emerging_pre_score,
      pre.performance_score,
      pre.age_level_score,
      pre.playing_time_score,
      pre.level_score,
      pre.trend_proxy_score,
      pre.pre_tier,
      pre.pre_score_notes,
      m.sales_count_7d AS market_sales_count_7d,
      m.sales_count_30d AS market_sales_count_30d,
      m.sales_count_90d AS market_sales_count_90d,
      m.avg_price_7d AS market_avg_price_7d,
      m.avg_price_30d AS market_avg_price_30d,
      m.avg_price_90d AS market_avg_price_90d,
      m.last_sold_price AS market_last_sold_price,
      m.last_sold_at AS market_last_sold_at,
      m.sell_through_30d AS market_sell_through_30d,
      m.sell_through_90d AS market_sell_through_90d,
      m.market_signal AS market_signal,
      rec.grade AS recommendation_grade,
      rec.recommendation AS recommendation,
      rec.thesis AS recommendation_thesis,
      rec.risk_notes AS recommendation_risk_notes
    FROM player_tracking_status pts
    JOIN players p ON p.id = pts.player_id
    LEFT JOIN emerging_card_targets ct ON ct.player_id = p.id AND ct.active = 1
    LEFT JOIN latest_stats s ON s.player_id = p.id
    LEFT JOIN latest_pre pre ON pre.player_id = p.id AND (pre.card_target_id = ct.id OR pre.card_target_id IS NULL)
    LEFT JOIN latest_market m ON m.player_id = p.id AND (m.card_target_id = ct.id OR m.card_target_id IS NULL)
    LEFT JOIN latest_recommendation rec ON rec.player_id = p.id AND (rec.card_target_id = ct.id OR rec.card_target_id IS NULL)
    WHERE ${filters.where}
    ORDER BY COALESCE(pre.emerging_pre_score, 0) DESC, p.player_name ASC, ct.year DESC
    LIMIT ?
  `).bind(...filters.params, filters.limit).all();

  const items = (rows.results || []).map(apiRow);
  if (!items.length) {
    return emptyResponse("No current records found");
  }

  return jsonResponse({
    items,
    prospects: items,
    count: items.length,
    status: "ok",
  }, 200, {
    "Cache-Control": "public, max-age=300",
  });
}

async function emergingDetail(db, playerId) {
  const row = await db.prepare(`
    ${latestCtes()}
    SELECT
      p.*,
      ct.id AS card_target_id,
      ct.year,
      ct.product,
      ct.auto_set,
      ct.auto_code,
      ct.card_number,
      ct.player_name_on_card,
      ct.team_on_card,
      ct.card_query_seed,
      ct.source_url,
      pts.tracking_group,
      pts.priority_tier,
      pts.status,
      pts.last_reviewed_at,
      pts.next_refresh_due,
      pts.notes AS tracking_notes,
      s.*,
      pre.emerging_pre_score,
      pre.performance_score,
      pre.age_level_score,
      pre.playing_time_score,
      pre.level_score,
      pre.trend_proxy_score,
      pre.pre_tier,
      pre.pre_score_notes,
      pre.source_workbook,
      m.sales_count_7d AS market_sales_count_7d,
      m.sales_count_30d AS market_sales_count_30d,
      m.sales_count_90d AS market_sales_count_90d,
      m.avg_price_7d AS market_avg_price_7d,
      m.avg_price_30d AS market_avg_price_30d,
      m.avg_price_90d AS market_avg_price_90d,
      m.last_sold_price AS market_last_sold_price,
      m.last_sold_at AS market_last_sold_at,
      m.sell_through_30d AS market_sell_through_30d,
      m.sell_through_90d AS market_sell_through_90d,
      m.market_signal AS market_signal,
      rec.grade AS recommendation_grade,
      rec.recommendation AS recommendation,
      rec.total_score AS recommendation_total_score,
      rec.thesis AS recommendation_thesis,
      rec.catalyst AS recommendation_catalyst,
      rec.risk_notes AS recommendation_risk_notes
    FROM players p
    LEFT JOIN player_tracking_status pts ON pts.player_id = p.id
    LEFT JOIN emerging_card_targets ct ON ct.player_id = p.id AND ct.active = 1
    LEFT JOIN latest_stats s ON s.player_id = p.id
    LEFT JOIN latest_pre pre ON pre.player_id = p.id AND (pre.card_target_id = ct.id OR pre.card_target_id IS NULL)
    LEFT JOIN latest_market m ON m.player_id = p.id AND (m.card_target_id = ct.id OR m.card_target_id IS NULL)
    LEFT JOIN latest_recommendation rec ON rec.player_id = p.id AND (rec.card_target_id = ct.id OR rec.card_target_id IS NULL)
    WHERE p.id = ?
    ORDER BY COALESCE(pre.emerging_pre_score, 0) DESC, ct.year DESC
    LIMIT 1
  `).bind(playerId).first();

  if (!row) return emptyResponse("No current records found");

  const [statsHistory, prescoreHistory, marketHistory, recommendationHistory] = await Promise.all([
    db.prepare(`SELECT * FROM player_stats_snapshots WHERE player_id = ? ORDER BY snapshot_date DESC LIMIT 12`).bind(playerId).all(),
    db.prepare(`SELECT * FROM emerging_prescore_snapshots WHERE player_id = ? ORDER BY snapshot_date DESC LIMIT 12`).bind(playerId).all(),
    db.prepare(`SELECT * FROM card_market_snapshots WHERE player_id = ? ORDER BY snapshot_date DESC LIMIT 12`).bind(playerId).all(),
    db.prepare(`SELECT * FROM recommendation_snapshots WHERE player_id = ? ORDER BY snapshot_date DESC LIMIT 12`).bind(playerId).all(),
  ]);

  return jsonResponse({
    prospect: apiRow(row),
    history: {
      stats: (statsHistory.results || []).map(normalizeRow),
      prescore: (prescoreHistory.results || []).map(normalizeRow),
      market: (marketHistory.results || []).map(normalizeRow),
      recommendations: (recommendationHistory.results || []).map(normalizeRow),
    },
  }, 200, {
    "Cache-Control": "public, max-age=300",
  });
}

function latestCtes() {
  return `
    WITH latest_stats AS (
      SELECT s.*
      FROM player_stats_snapshots s
      JOIN (
        SELECT player_id, MAX(snapshot_date) AS snapshot_date
        FROM player_stats_snapshots
        GROUP BY player_id
      ) latest ON latest.player_id = s.player_id AND latest.snapshot_date = s.snapshot_date
    ),
    latest_pre AS (
      SELECT pre.*
      FROM emerging_prescore_snapshots pre
      JOIN (
        SELECT player_id, card_target_id, MAX(snapshot_date) AS snapshot_date
        FROM emerging_prescore_snapshots
        GROUP BY player_id, card_target_id
      ) latest ON latest.player_id = pre.player_id
        AND (latest.card_target_id = pre.card_target_id OR (latest.card_target_id IS NULL AND pre.card_target_id IS NULL))
        AND latest.snapshot_date = pre.snapshot_date
    ),
    latest_market AS (
      SELECT m.*
      FROM card_market_snapshots m
      JOIN (
        SELECT player_id, card_target_id, MAX(snapshot_date) AS snapshot_date
        FROM card_market_snapshots
        GROUP BY player_id, card_target_id
      ) latest ON latest.player_id = m.player_id
        AND (latest.card_target_id = m.card_target_id OR (latest.card_target_id IS NULL AND m.card_target_id IS NULL))
        AND latest.snapshot_date = m.snapshot_date
    ),
    latest_recommendation AS (
      SELECT rec.*
      FROM recommendation_snapshots rec
      JOIN (
        SELECT player_id, card_target_id, MAX(snapshot_date) AS snapshot_date
        FROM recommendation_snapshots
        WHERE board_type = 'emerging'
        GROUP BY player_id, card_target_id
      ) latest ON latest.player_id = rec.player_id
        AND (latest.card_target_id = rec.card_target_id OR (latest.card_target_id IS NULL AND rec.card_target_id IS NULL))
        AND latest.snapshot_date = rec.snapshot_date
      WHERE rec.board_type = 'emerging'
    )
  `;
}

function listFilters(url) {
  const includeWatch = url.searchParams.get("include_watch") === "true";
  const includeLowPriority = url.searchParams.get("include_low_priority") === "true";
  const tier = normalizeTier(url.searchParams.get("tier"));
  const year = numericParam(url.searchParams.get("year"));
  const product = String(url.searchParams.get("product") || "").trim();
  const role = String(url.searchParams.get("role") || "").trim();
  const search = String(url.searchParams.get("search") || "").trim().toLowerCase();
  const allowedTiers = new Set(DEFAULT_TIERS);
  if (includeWatch) allowedTiers.add("emerging_watch");
  if (includeLowPriority) allowedTiers.add("low_priority");
  if (tier) {
    allowedTiers.clear();
    allowedTiers.add(tier);
  }

  const where = [
    "pts.tracking_group = 'emerging'",
    "pts.status IN ('active', 'watch')",
    `pts.priority_tier IN (${[...allowedTiers].map((value) => `'${value}'`).join(", ")})`,
  ];
  const params = [];

  if (year) {
    where.push("ct.year = ?");
    params.push(year);
  }
  if (product) {
    where.push("LOWER(ct.product) LIKE ?");
    params.push(`%${product.toLowerCase()}%`);
  }
  if (role) {
    where.push("LOWER(s.stats_role) = ?");
    params.push(role.toLowerCase());
  }
  if (search) {
    where.push("LOWER(p.player_name) LIKE ?");
    params.push(`%${search}%`);
  }

  return {
    where: where.join(" AND "),
    params,
    limit: Math.max(1, Math.min(500, numericParam(url.searchParams.get("limit")) || 150)),
  };
}

function apiRow(row) {
  const normalized = normalizeRow(row);
  const priorityTier = normalized.priority_tier || normalized.pre_tier;
  const moveScore = normalized.emerging_pre_score || normalized.pre_score || normalized.recommendation_total_score || "";
  const marketRead = normalizeMarketRead(normalized.market_signal, normalized);
  const buyZone = normalizeBuyZone(normalized.recommendation, marketRead, moveScore);
  return {
    ...normalized,
    team: normalized.team || normalized.current_team || normalized.current_org || normalized.team_on_card,
    board_type: "emerging",
    trend: "",
    move_score: moveScore,
    market_read: marketRead,
    buy_zone: buyZone,
    profile_url: `./player.html?type=emerging&id=${encodeURIComponent(String(normalized.player_id))}`,
    tier_label: TIER_LABELS.get(priorityTier) || labelize(priorityTier),
    latest_market_snapshot: marketSnapshot(normalized),
    latest_recommendation: recommendationSnapshot(normalized),
  };
}

function normalizeMarketRead(value, row = {}) {
  const text = String(value || "").toLowerCase();
  if (text.includes("avoid")) return "Avoid Chase";
  if (text.includes("no liquidity")) return "No Liquidity";
  if (text.includes("need")) return "Needs Market";
  const sales30 = Number(row.market_sales_count_30d);
  const sales90 = Number(row.market_sales_count_90d);
  const avg30 = Number(row.market_avg_price_30d);
  const avg90 = Number(row.market_avg_price_90d);
  if ((!Number.isFinite(sales30) || sales30 <= 0) && (!Number.isFinite(sales90) || sales90 <= 0)) {
    if (text.includes("thin")) return "Thin";
    return "Needs Market";
  }

  let volume = "Confirmed";
  if (text.includes("thin") || (Number.isFinite(sales90) && sales90 > 0 && sales90 < 4)) volume = "Thin";
  else if (text.includes("liquid") || sales30 >= 12 || sales90 >= 20) volume = "Liquid";

  let trend = "";
  if (text.includes("heating") || text.includes("up")) trend = "Up";
  else if (text.includes("priced")) trend = "Priced In";
  else if (text.includes("cooling") || text.includes("down")) trend = "Down";
  else if (Number.isFinite(avg30) && Number.isFinite(avg90) && avg90 > 0) {
    const movement = ((avg30 - avg90) / avg90) * 100;
    if (movement >= 12) trend = "Up";
    else if (movement <= -12) trend = "Down";
    else trend = "Stable";
  }
  if (!trend) trend = Number.isFinite(sales30) && Number.isFinite(sales90) && sales30 >= Math.max(3, sales90 * 0.4) ? "Active" : "Watch";
  return `${volume} · ${trend}`;
}

function normalizeBuyZone(value, marketRead, moveScore) {
  const text = String(value || "").toLowerCase();
  if (text.includes("strong")) return "Strong Buy";
  if (text.includes("avoid")) return "Avoid Chase";
  if (text.includes("no liquidity")) return "No Liquidity";
  if (text.includes("need")) return "Needs Market";
  if (text.includes("buy")) return "Buy Zone";
  if (text.includes("watch")) return "Watch";
  if (text.includes("research")) return "Research";
  if (marketRead === "No Liquidity") return "No Liquidity";
  if (marketRead === "Needs Market") return "Needs Market";
  return Number(moveScore) >= 60 ? "Research" : "Needs Market";
}

function marketSnapshot(row) {
  const hasMarket = [
    row.market_sales_count_7d,
    row.market_sales_count_30d,
    row.market_sales_count_90d,
    row.market_avg_price_7d,
    row.market_avg_price_30d,
    row.market_avg_price_90d,
    row.market_last_sold_price,
    row.market_sell_through_30d,
    row.market_sell_through_90d,
  ].some((value) => value !== null && value !== undefined && value !== "");
  if (!hasMarket) return null;
  return {
    sales_count_7d: row.market_sales_count_7d,
    sales_count_30d: row.market_sales_count_30d,
    sales_count_90d: row.market_sales_count_90d,
    avg_price_7d: row.market_avg_price_7d,
    avg_price_30d: row.market_avg_price_30d,
    avg_price_90d: row.market_avg_price_90d,
    last_sold_price: row.market_last_sold_price,
    last_sold_at: row.market_last_sold_at,
    sell_through_30d: row.market_sell_through_30d,
    sell_through_90d: row.market_sell_through_90d,
    market_signal: row.market_signal,
  };
}

function recommendationSnapshot(row) {
  if (!row.recommendation_grade && !row.recommendation) return null;
  return {
    grade: row.recommendation_grade,
    recommendation: row.recommendation,
    thesis: row.recommendation_thesis,
    risk_notes: row.recommendation_risk_notes,
  };
}

function normalizeTier(value) {
  const normalized = String(value || "").trim().toLowerCase().replace(/\+/g, "plus").replaceAll(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  if (!normalized || normalized === "all") return "";
  if (normalized === "card_candidate" || normalized === "card_candidates") return "card_api_candidate";
  if (normalized === "emerging_b_plus") return "emerging_bplus";
  return [...DEFAULT_TIERS, ...EXTRA_TIERS].includes(normalized) ? normalized : "";
}

function numericParam(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function normalizeRow(row) {
  return Object.fromEntries(Object.entries(row || {}).map(([key, value]) => [key, value ?? ""]));
}

function labelize(value) {
  return String(value || "").replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
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

function emptyResponse(message) {
  return jsonResponse({
    items: [],
    prospects: [],
    count: 0,
    status: "empty",
    message,
  }, 200, {
    "Cache-Control": "public, max-age=120",
  });
}

function safeError(error) {
  return {
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
  };
}
