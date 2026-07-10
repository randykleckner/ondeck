export async function onDiagnosticsRequest(context) {
  if (context.request.method !== "GET") {
    return jsonResponse({ error: "Method not allowed." }, 405, { Allow: "GET" });
  }

  const db = context.env?.MARKET_DB;
  if (!db) {
    return jsonResponse({ items: [], count: 0, status: "empty", message: "MARKET_DB is not configured." });
  }

  try {
    const url = new URL(context.request.url);
    const limit = Math.max(1, Math.min(2000, Number(url.searchParams.get("limit")) || 1000));
    const rows = await db.prepare(`
      WITH latest_stats AS (
        SELECT s.*
        FROM player_stats_snapshots s
        JOIN (
          SELECT player_id, MAX(snapshot_date) AS snapshot_date
          FROM player_stats_snapshots
          GROUP BY player_id
        ) latest ON latest.player_id = s.player_id AND latest.snapshot_date = s.snapshot_date
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
      latest_score AS (
        SELECT ps.*
        FROM player_scores ps
        JOIN (
          SELECT player_id, MAX(score_date) AS score_date
          FROM player_scores
          GROUP BY player_id
        ) latest ON latest.player_id = ps.player_id AND latest.score_date = ps.score_date
      ),
      source_rollup AS (
        SELECT player_id, GROUP_CONCAT(DISTINCT source_type) AS source_types
        FROM player_sources
        GROUP BY player_id
      ),
      name_counts AS (
        SELECT player_name, COUNT(*) AS same_name_count
        FROM players
        GROUP BY player_name
      )
      SELECT
        p.id AS player_id,
        p.mlbam_id AS mlb_player_id,
        p.milb_player_id,
        p.identity_key,
        p.player_name,
        p.full_name,
        p.normalized_name,
        p.current_team AS team,
        p.current_org AS org,
        COALESCE(p.current_level, s.level) AS level,
        p.age,
        p.position,
        p.birth_date,
        p.draft_year,
        p.draft_round,
        p.draft_overall,
        p.draft_team,
        p.school,
        p.active_status,
        p.first_seen_source,
        p.last_seen_date,
        sr.source_types,
        CASE WHEN s.id IS NOT NULL THEN 1 ELSE 0 END AS has_stats,
        s.snapshot_date AS latest_stats_date,
        CASE WHEN ect.id IS NOT NULL THEN 1 ELSE 0 END AS has_card_target,
        ect.id AS card_target_id,
        ect.generated_card_code,
        COALESCE(ect.verified_card_code, ect.auto_code) AS verified_card_code,
        ect.card_status,
        ect.review_status AS card_review_status,
        ect.card_code_confidence,
        CASE WHEN COALESCE(m.current_auto_price, m.last_sold_price, m.avg_price_30d, m.avg_price_90d, 0) > 0 THEN 1 ELSE 0 END AS has_market_price,
        COALESCE(m.current_auto_price, m.last_sold_price, m.avg_price_30d, m.avg_price_90d) AS current_auto_price,
        m.sales_count_30d,
        m.sales_count_90d,
        m.sell_through_30d,
        m.sell_through_90d,
        m.market_signal,
        COALESCE(ps.move_score, rec.total_score, pre.emerging_pre_score) AS move_score,
        ps.investment_score,
        ps.moonshot_rating,
        ps.catalyst_score,
        ps.ceiling_score,
        COALESCE(ps.eligible_for_top100, 0) AS eligible_top100,
        COALESCE(ps.eligible_for_emerging, CASE WHEN ect.id IS NOT NULL AND pts.tracking_group = 'emerging' THEN 1 ELSE 0 END) AS eligible_emerging,
        COALESCE(ps.eligible_for_on_deck, 0) AS eligible_ondeck,
        ps.excluded_reason AS score_excluded_reason,
        pts.tracking_group,
        pts.priority_tier,
        pts.status AS tracking_status,
        nc.same_name_count
      FROM players p
      LEFT JOIN player_tracking_status pts ON pts.player_id = p.id
      LEFT JOIN source_rollup sr ON sr.player_id = p.id
      LEFT JOIN latest_stats s ON s.player_id = p.id
      LEFT JOIN emerging_card_targets ect ON ect.player_id = p.id AND ect.active = 1
      LEFT JOIN latest_market m ON m.player_id = p.id AND (m.card_target_id = ect.id OR m.card_target_id IS NULL)
      LEFT JOIN latest_score ps ON ps.player_id = p.id
      LEFT JOIN emerging_prescore_snapshots pre ON pre.player_id = p.id AND pre.snapshot_date = (
        SELECT MAX(snapshot_date) FROM emerging_prescore_snapshots WHERE player_id = p.id
      )
      LEFT JOIN recommendation_snapshots rec ON rec.player_id = p.id AND rec.snapshot_date = (
        SELECT MAX(snapshot_date) FROM recommendation_snapshots WHERE player_id = p.id
      )
      LEFT JOIN name_counts nc ON nc.player_name = p.player_name
      ORDER BY
        CASE WHEN ect.id IS NULL THEN 1 ELSE 0 END,
        CASE WHEN COALESCE(m.current_auto_price, m.last_sold_price, m.avg_price_30d, m.avg_price_90d, 0) > 0 THEN 0 ELSE 1 END,
        COALESCE(ps.investment_score, rec.total_score, pre.emerging_pre_score, 0) DESC,
        p.player_name ASC
      LIMIT ?
    `).bind(limit).all();

    const items = (rows.results || []).map(toDiagnosticItem);
    return jsonResponse({ items, count: items.length, status: "ok" }, 200, {
      "Cache-Control": "public, max-age=120",
    });
  } catch (error) {
    console.error("diagnostics route failed", safeError(error));
    return jsonResponse({
      items: [],
      count: 0,
      status: "empty",
      message: "Diagnostics data is not available until the player pipeline migration is applied.",
    }, 200, {
      "Cache-Control": "public, max-age=60",
    });
  }
}

function toDiagnosticItem(row) {
  const missing = missingFields(row);
  return {
    ...normalizeRow(row),
    source_type: row.source_types || row.first_seen_source || row.tracking_group || "Registry",
    excluded_reason: excludedReason(row, missing),
    missing_fields: missing,
    same_name_collision: Number(row.same_name_count || 0) > 1,
  };
}

function missingFields(row) {
  const fields = [];
  if (!row.mlb_player_id && !row.milb_player_id) fields.push("Missing player ID");
  if (!row.has_stats) fields.push("Missing stats");
  if (!row.has_card_target) fields.push("Missing card target");
  if (row.has_card_target && !row.verified_card_code) fields.push("Missing card code");
  if (row.has_card_target && String(row.card_review_status || "").toLowerCase() !== "verified") fields.push("Needs card review");
  if (row.has_card_target && !row.has_market_price) fields.push("Missing market price");
  return fields;
}

function excludedReason(row, missing) {
  if (String(row.active_status || "").toLowerCase() === "inactive") return "Inactive";
  if (missing.includes("Missing card target")) return "Missing card target";
  if (missing.includes("Missing card code")) return "Missing card code";
  if (missing.includes("Needs card review")) return "Needs card review";
  if (missing.includes("Missing market price")) return "Missing market price";
  if (missing.includes("Missing stats")) return "Missing stats";
  if (row.score_excluded_reason) return row.score_excluded_reason;
  return "Fully scorable";
}

function normalizeRow(row) {
  return Object.fromEntries(Object.entries(row || {}).map(([key, value]) => [key, value ?? ""]));
}

function jsonResponse(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

function safeError(error) {
  return {
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
  };
}
