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
    const limit = Math.max(1, Math.min(5000, Number(url.searchParams.get("limit")) || 1000));
    const rows = await db.prepare(`
      WITH latest_stats AS (
        SELECT *
        FROM (
          SELECT
            s.*,
            ROW_NUMBER() OVER (
              PARTITION BY s.player_id
              ORDER BY s.snapshot_date DESC, COALESCE(s.hitter_pa, 0) + COALESCE(s.pitcher_ip, 0) DESC, s.id DESC
            ) AS stat_rank
          FROM player_stats_snapshots s
        )
        WHERE stat_rank = 1
      ),
      latest_emerging_market AS (
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
      ),
      target_union AS (
        SELECT
          p.id AS player_id,
          ect.id AS card_target_id,
          NULL AS top100_player_id,
          'emerging' AS card_target_type,
          ect.auto_code AS target_card_code,
          ect.generated_card_code,
          COALESCE(ect.verified_card_code, ect.auto_code) AS verified_card_code,
          ect.card_status,
          ect.review_status AS card_review_status,
          ect.card_code_confidence,
          ect.checklist_match_confidence,
          ect.checklist_source_name,
          ect.checklist_source_url,
          CASE WHEN ect.checklist_card_id IS NOT NULL THEN 1 ELSE 0 END AS has_checklist_card
        FROM emerging_card_targets ect
        JOIN players p ON p.id = ect.player_id
        WHERE ect.active = 1
          AND COALESCE(ect.verified_card_code, ect.auto_code, '') LIKE 'CPA%'

        UNION ALL

        SELECT
          p.id AS player_id,
          NULL AS card_target_id,
          ct.player_id AS top100_player_id,
          'top100' AS card_target_type,
          ct.card_code AS target_card_code,
          ct.generated_card_code,
          COALESCE(ct.verified_card_code, ct.card_code) AS verified_card_code,
          ct.card_status,
          ct.review_status AS card_review_status,
          ct.card_code_confidence,
          ct.checklist_match_confidence,
          ct.checklist_source_name,
          ct.checklist_source_url,
          CASE WHEN ct.checklist_card_id IS NOT NULL THEN 1 ELSE 0 END AS has_checklist_card
        FROM card_targets ct
        JOIN players p ON p.id = ct.player_registry_id
          OR CAST(p.id AS TEXT) = ct.player_id
          OR lower(p.player_name) = lower(ct.player_name)
        WHERE COALESCE(ct.enabled, 1) = 1
          AND COALESCE(ct.verified_card_code, ct.card_code, '') LIKE 'CPA%'

        UNION ALL

        SELECT
          p.id AS player_id,
          NULL AS card_target_id,
          tm.player_id AS top100_player_id,
          'market' AS card_target_type,
          tm.benchmark_card_code AS target_card_code,
          NULL AS generated_card_code,
          tm.benchmark_card_code AS verified_card_code,
          'Card Target Found' AS card_status,
          'Verified' AS card_review_status,
          'soldcomps_market_cpa' AS card_code_confidence,
          'high' AS checklist_match_confidence,
          'SoldComps API' AS checklist_source_name,
          NULL AS checklist_source_url,
          0 AS has_checklist_card
        FROM market_player_snapshots tm
        JOIN players p ON tm.player_id = CAST(p.id AS TEXT) OR lower(tm.player_name) = lower(p.player_name)
        WHERE COALESCE(tm.benchmark_card_code, '') LIKE 'CPA%'
      ),
      ranked_targets AS (
        SELECT
          tu.*,
          ROW_NUMBER() OVER (
            PARTITION BY tu.player_id
            ORDER BY
              CASE WHEN COALESCE(tu.verified_card_code, tu.target_card_code, '') LIKE 'CPA%' THEN 0 ELSE 1 END,
              CASE WHEN tu.card_target_type = 'market' THEN 0 ELSE 1 END,
              CASE WHEN tu.card_review_status = 'Verified' THEN 0 ELSE 1 END,
              CASE WHEN tu.has_checklist_card = 1 THEN 0 ELSE 1 END,
              CASE WHEN tu.card_target_type = 'emerging' THEN 0 ELSE 1 END
          ) AS target_rank
        FROM target_union tu
      ),
      best_target AS (
        SELECT *
        FROM ranked_targets
        WHERE target_rank = 1
      ),
      top100_market AS (
        SELECT *
        FROM market_player_snapshots
      ),
      market_code_rollup AS (
        SELECT card_code, COUNT(DISTINCT player_ref) AS player_count
        FROM (
          SELECT COALESCE(ect.verified_card_code, ect.auto_code) AS card_code, 'emerging:' || m.player_id AS player_ref
          FROM card_market_snapshots m
          JOIN emerging_card_targets ect ON ect.id = m.card_target_id
          WHERE COALESCE(ect.verified_card_code, ect.auto_code, '') LIKE 'CPA%'

          UNION ALL

          SELECT benchmark_card_code AS card_code, 'top100:' || player_id AS player_ref
          FROM market_player_snapshots
          WHERE COALESCE(benchmark_card_code, '') LIKE 'CPA%'
        )
        GROUP BY card_code
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
        CASE WHEN bt.player_id IS NOT NULL THEN 1 ELSE 0 END AS has_card_target,
        bt.card_target_id,
        bt.top100_player_id,
        bt.card_target_type,
        bt.target_card_code,
        bt.generated_card_code,
        bt.verified_card_code,
        bt.card_status,
        bt.card_review_status,
        bt.card_code_confidence,
        bt.checklist_match_confidence,
        bt.checklist_source_name,
        bt.checklist_source_url,
        bt.has_checklist_card,
        CASE WHEN em.id IS NOT NULL OR tm.player_id IS NOT NULL THEN 1 ELSE 0 END AS has_market_snapshot,
        CASE WHEN COALESCE(em.current_auto_price, em.last_sold_price, em.avg_price_30d, em.avg_price_90d, tm.last_sold_price, tm.avg_sold_price_30d, tm.avg_sold_price_90d, 0) > 0 THEN 1 ELSE 0 END AS has_market_price,
        COALESCE(em.current_auto_price, em.last_sold_price, em.avg_price_30d, em.avg_price_90d, tm.last_sold_price, tm.avg_sold_price_30d, tm.avg_sold_price_90d) AS current_auto_price,
        COALESCE(em.sales_count_30d, tm.sales_count_30d) AS sales_count_30d,
        COALESCE(em.sales_count_90d, tm.sales_count_90d) AS sales_count_90d,
        COALESCE(em.sell_through_30d, tm.sell_thru_rate_30d) AS sell_through_30d,
        COALESCE(em.sell_through_90d, tm.sell_thru_rate_90d) AS sell_through_90d,
        COALESCE(em.market_signal, tm.source) AS market_signal,
        CASE WHEN COALESCE(mcr.player_count, 0) > 1 THEN 1 ELSE 0 END AS duplicate_market_elsewhere,
        COALESCE(ps.move_score, rec.total_score, pre.emerging_pre_score) AS move_score,
        ps.investment_score,
        ps.moonshot_rating,
        ps.catalyst_score,
        ps.ceiling_score,
        COALESCE(ps.eligible_for_top100, 0) AS eligible_top100,
        COALESCE(ps.eligible_for_emerging, CASE WHEN bt.player_id IS NOT NULL AND pts.tracking_group = 'emerging' THEN 1 ELSE 0 END) AS eligible_emerging,
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
      LEFT JOIN best_target bt ON bt.player_id = p.id
      LEFT JOIN latest_emerging_market em ON bt.card_target_type = 'emerging'
        AND em.player_id = p.id
        AND (em.card_target_id = bt.card_target_id OR em.card_target_id IS NULL)
      LEFT JOIN top100_market tm ON tm.player_id = bt.top100_player_id
        OR tm.player_id = CAST(p.id AS TEXT)
        OR (
          lower(tm.player_name) = lower(p.player_name)
          AND COALESCE(tm.benchmark_card_code, '') = COALESCE(bt.target_card_code, '')
        )
      LEFT JOIN market_code_rollup mcr ON mcr.card_code = bt.target_card_code
      LEFT JOIN latest_score ps ON ps.player_id = p.id
      LEFT JOIN emerging_prescore_snapshots pre ON pre.player_id = p.id AND pre.snapshot_date = (
        SELECT MAX(snapshot_date) FROM emerging_prescore_snapshots WHERE player_id = p.id
      )
      LEFT JOIN recommendation_snapshots rec ON rec.player_id = p.id AND rec.snapshot_date = (
        SELECT MAX(snapshot_date) FROM recommendation_snapshots WHERE player_id = p.id
      )
      LEFT JOIN name_counts nc ON nc.player_name = p.player_name
      WHERE
        COALESCE(p.active_status, 'active') = 'active'
        AND p.mlbam_id IS NOT NULL
      ORDER BY
        CASE WHEN bt.player_id IS NULL THEN 1 ELSE 0 END,
        CASE WHEN COALESCE(em.current_auto_price, em.last_sold_price, em.avg_price_30d, em.avg_price_90d, tm.last_sold_price, tm.avg_sold_price_30d, tm.avg_sold_price_90d, 0) > 0 THEN 0 ELSE 1 END,
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
  const missing = diagnosticLabels(row);
  return {
    ...normalizeRow(row),
    source_type: row.tracking_group && row.tracking_group !== "inactive" ? row.tracking_group : "unassigned",
    source_detail: row.source_types || row.first_seen_source || "",
    excluded_reason: excludedReason(row, missing),
    missing_fields: missing,
    same_name_collision: Number(row.same_name_count || 0) > 1 || isCollisionTarget(row),
  };
}

function diagnosticLabels(row) {
  const labels = [];
  if (!row.mlb_player_id && !row.milb_player_id) labels.push("Missing Player ID");
  if (!row.has_stats) labels.push("Missing Stats");
  if (!row.has_card_target) labels.push("Missing CPA Card Target");
  if (row.has_card_target && !row.verified_card_code && !row.target_card_code) labels.push("Missing Card Code");
  if (row.has_card_target && !isCpaTarget(row)) labels.push("Non-CPA Card Target Ignored");
  if (row.has_card_target && checklistNeedsReview(row)) labels.push("Checklist Match Needs Review");
  if (Number(row.same_name_count || 0) > 1 || isCollisionTarget(row)) labels.push("Same-Name Collision");
  if (row.has_card_target && !row.has_market_snapshot) labels.push("Card Target Exists, Market Pull Failed");
  if (row.has_card_target && row.has_market_snapshot && !row.has_market_price) labels.push("Card Target Exists, Missing Market Price");
  return labels;
}

function isCpaTarget(row) {
  return String(row.verified_card_code || row.target_card_code || "").toUpperCase().startsWith("CPA");
}

function checklistNeedsReview(row) {
  const review = String(row.card_review_status || "").toLowerCase();
  const confidence = String(row.checklist_match_confidence || row.card_code_confidence || "").toLowerCase();
  return review && review !== "verified"
    || confidence.includes("low")
    || confidence.includes("medium")
    || confidence.includes("collision");
}

function isCollisionTarget(row) {
  const confidence = String(row.checklist_match_confidence || row.card_code_confidence || "").toLowerCase();
  return confidence.includes("collision");
}

function excludedReason(row, labels) {
  if (String(row.active_status || "").toLowerCase() === "inactive") return "Inactive";
  for (const label of [
    "Missing CPA Card Target",
    "Missing Card Code",
    "Non-CPA Card Target Ignored",
    "Checklist Match Needs Review",
    "Same-Name Collision",
    "Card Target Exists, Market Pull Failed",
    "Card Target Exists, Missing Market Price",
    "Missing Stats",
  ]) {
    if (labels.includes(label)) return label;
  }
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
