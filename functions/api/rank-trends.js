const DEFAULT_TOP100_SOURCE_URL = "https://www.mlb.com/prospects/stats/top-prospects";
const MIN_RUN_INTERVAL_DAYS = 14;

export async function onRequest({ request, env }) {
  if (request.method === "OPTIONS") {
    return jsonResponse({}, 204);
  }

  if (!env.MARKET_DB) {
    return jsonResponse({ error: "MARKET_DB D1 binding is not configured." }, 503);
  }

  const url = new URL(request.url);
  if (request.method === "GET" && url.searchParams.get("run") !== "true") {
    return rankTrendStatus(env);
  }

  if (!["GET", "POST"].includes(request.method)) {
    return jsonResponse({ error: "Method not allowed." }, 405);
  }

  const force = url.searchParams.get("force") === "true";
  try {
    const result = await runTop100TrendUpdate(env, { force });
    return jsonResponse(result);
  } catch (error) {
    await logRankRun(env, {
      status: "error",
      playersFound: 0,
      message: error?.message || "Top 100 trend update failed.",
    });
    return jsonResponse({ error: error?.message || "Top 100 trend update failed." }, 500);
  }
}

export async function runTop100TrendUpdate(env, options = {}) {
  if (!env.MARKET_DB) {
    throw new Error("MARKET_DB D1 binding is not configured.");
  }

  const sourceUrl = env.TOP100_SOURCE_URL || DEFAULT_TOP100_SOURCE_URL;
  const today = isoDate();
  const lastRun = await latestSuccessfulRun(env);
  if (!options.force && lastRun?.snapshot_date && daysBetween(lastRun.snapshot_date, today) < MIN_RUN_INTERVAL_DAYS) {
    return {
      status: "skipped",
      reason: `Last successful Top 100 snapshot was ${lastRun.snapshot_date}. Next write is allowed after ${MIN_RUN_INTERVAL_DAYS} days.`,
      lastSnapshotDate: lastRun.snapshot_date,
    };
  }

  const response = await fetch(sourceUrl, {
    headers: {
      Accept: "text/html,application/json,text/csv;q=0.9,*/*;q=0.8",
      "User-Agent": "OnDeckProspectBot/1.0 (+https://ondeckprospect.com)",
    },
  });
  if (!response.ok) {
    throw new Error(`Could not fetch MLB Top 100 source: ${response.status}`);
  }

  const contentType = response.headers.get("content-type") || "";
  const body = await response.text();
  const rankings = extractTop100Rankings(body, contentType, sourceUrl);
  if (rankings.length < 50) {
    throw new Error(`Only found ${rankings.length} ranked players from Top 100 source; refusing to store partial snapshot.`);
  }

  const latestPreviousSnapshotDate = await previousSnapshotDate(env, today);
  const previousRanks = latestPreviousSnapshotDate
    ? await rankMapForSnapshot(env, latestPreviousSnapshotDate)
    : new Map();

  await env.MARKET_DB.batch(rankings.map((player) => env.MARKET_DB.prepare(`
    INSERT OR REPLACE INTO top100_rank_snapshots (
      snapshot_date,
      player_key,
      player_id,
      mlbam_id,
      player_name,
      org,
      position,
      rank,
      source_url,
      raw_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    today,
    player.playerKey,
    player.playerId || "",
    player.mlbamId || "",
    player.playerName,
    player.org || "",
    player.position || "",
    player.rank,
    sourceUrl,
    JSON.stringify(player.raw || {})
  )));

  for (const player of rankings) {
    const previousRank = previousRanks.get(player.playerKey) ?? null;
    const history = await rankHistorySummary(env, player.playerKey);
    await env.MARKET_DB.prepare(`
      INSERT INTO top100_rank_trends (
        player_key,
        player_id,
        mlbam_id,
        player_name,
        org,
        position,
        current_rank,
        previous_rank,
        movement,
        first_seen_rank,
        best_rank,
        worst_rank,
        snapshots_count,
        last_snapshot_date,
        previous_snapshot_date,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(player_key) DO UPDATE SET
        player_id = excluded.player_id,
        mlbam_id = excluded.mlbam_id,
        player_name = excluded.player_name,
        org = excluded.org,
        position = excluded.position,
        current_rank = excluded.current_rank,
        previous_rank = excluded.previous_rank,
        movement = excluded.movement,
        first_seen_rank = excluded.first_seen_rank,
        best_rank = excluded.best_rank,
        worst_rank = excluded.worst_rank,
        snapshots_count = excluded.snapshots_count,
        last_snapshot_date = excluded.last_snapshot_date,
        previous_snapshot_date = excluded.previous_snapshot_date,
        updated_at = CURRENT_TIMESTAMP
    `).bind(
      player.playerKey,
      player.playerId || "",
      player.mlbamId || "",
      player.playerName,
      player.org || "",
      player.position || "",
      player.rank,
      previousRank,
      previousRank == null ? null : previousRank - player.rank,
      history.firstSeenRank,
      history.bestRank,
      history.worstRank,
      history.snapshotsCount,
      today,
      latestPreviousSnapshotDate
    ).run();
  }

  await logRankRun(env, {
    snapshotDate: today,
    sourceUrl,
    status: "success",
    playersFound: rankings.length,
    message: `Stored ${rankings.length} MLB Top 100 rank rows.`,
  });

  return {
    status: "success",
    snapshotDate: today,
    playersFound: rankings.length,
    sourceUrl,
    previousSnapshotDate: latestPreviousSnapshotDate,
  };
}

async function rankTrendStatus(env) {
  const latestRun = await latestSuccessfulRun(env);
  const latestSnapshot = await env.MARKET_DB.prepare(`
    SELECT snapshot_date, COUNT(*) AS players_found
    FROM top100_rank_snapshots
    GROUP BY snapshot_date
    ORDER BY snapshot_date DESC
    LIMIT 1
  `).first();
  const movers = await env.MARKET_DB.prepare(`
    SELECT player_name, org, current_rank, previous_rank, movement, last_snapshot_date
    FROM top100_rank_trends
    WHERE movement IS NOT NULL
    ORDER BY ABS(movement) DESC, current_rank ASC
    LIMIT 10
  `).all();

  return jsonResponse({
    latestRun,
    latestSnapshot,
    topMovers: movers.results || [],
  });
}

async function latestSuccessfulRun(env) {
  return env.MARKET_DB.prepare(`
    SELECT run_at, snapshot_date, source_url, players_found, message
    FROM top100_rank_run_log
    WHERE status = 'success'
    ORDER BY run_at DESC
    LIMIT 1
  `).first();
}

async function previousSnapshotDate(env, today) {
  const row = await env.MARKET_DB.prepare(`
    SELECT snapshot_date
    FROM top100_rank_snapshots
    WHERE snapshot_date < ?
    GROUP BY snapshot_date
    ORDER BY snapshot_date DESC
    LIMIT 1
  `).bind(today).first();
  return row?.snapshot_date || null;
}

async function rankMapForSnapshot(env, snapshotDate) {
  const rows = await env.MARKET_DB.prepare(`
    SELECT player_key, rank
    FROM top100_rank_snapshots
    WHERE snapshot_date = ?
  `).bind(snapshotDate).all();
  return new Map((rows.results || []).map((row) => [row.player_key, Number(row.rank)]));
}

async function rankHistorySummary(env, playerKey) {
  const summary = await env.MARKET_DB.prepare(`
    SELECT MIN(rank) AS best_rank, MAX(rank) AS worst_rank, COUNT(*) AS snapshots_count
    FROM top100_rank_snapshots
    WHERE player_key = ?
  `).bind(playerKey).first();
  const first = await env.MARKET_DB.prepare(`
    SELECT rank
    FROM top100_rank_snapshots
    WHERE player_key = ?
    ORDER BY snapshot_date ASC
    LIMIT 1
  `).bind(playerKey).first();

  return {
    firstSeenRank: first?.rank ?? null,
    bestRank: summary?.best_rank ?? null,
    worstRank: summary?.worst_rank ?? null,
    snapshotsCount: summary?.snapshots_count ?? 0,
  };
}

async function logRankRun(env, { snapshotDate = null, sourceUrl = "", status, playersFound = 0, message = "" }) {
  if (!env.MARKET_DB) return;
  await env.MARKET_DB.prepare(`
    INSERT INTO top100_rank_run_log (snapshot_date, source_url, status, players_found, message)
    VALUES (?, ?, ?, ?, ?)
  `).bind(snapshotDate, sourceUrl, status, playersFound, message).run();
}

export function extractTop100Rankings(body, contentType = "", sourceUrl = "") {
  const trimmed = String(body || "").trim();
  if (!trimmed) return [];

  if (contentType.includes("text/csv") || sourceUrl.endsWith(".csv") || looksLikeCsv(trimmed)) {
    return rankingsFromCsv(trimmed);
  }

  const jsonText = contentType.includes("application/json") ? trimmed : nextDataJson(trimmed);
  if (jsonText) {
    try {
      return rankingsFromJson(JSON.parse(jsonText));
    } catch {
      return [];
    }
  }

  return [];
}

function rankingsFromCsv(csv) {
  const rows = parseCsv(csv);
  return rows
    .map((row) => normalizeRanking({
      rank: row.prospect_rank || row.rank || row.Rank,
      playerName: row.player_name || row.name || row.Player,
      playerId: row.player_id || row.id || "",
      mlbamId: row.mlbam_id || row.mlbamId || row.mlbId || "",
      org: row.org || row.team || row.Team || "",
      position: row.position || row.pos || row.Position || "",
      raw: row,
    }))
    .filter(Boolean)
    .sort((a, b) => a.rank - b.rank)
    .slice(0, 100);
}

function rankingsFromJson(root) {
  const candidates = [];
  walk(root, (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const rank = firstValue(value, ["prospect_rank", "prospectRank", "rank", "ranking", "rankNum"]);
    const playerName = firstValue(value, ["player_name", "playerName", "fullName", "name", "playerFullName"]);
    if (rank == null || !playerName) return;
    const normalized = normalizeRanking({
      rank,
      playerName,
      playerId: firstValue(value, ["player_id", "playerId", "id", "prospectId"]) || "",
      mlbamId: firstValue(value, ["mlbam_id", "mlbamId", "mlbId", "mlbAMID", "playerMlbamId"]) || "",
      org: firstValue(value, ["org", "organization", "team", "teamName", "parentOrgName"]) || "",
      position: firstValue(value, ["position", "pos", "primaryPosition", "primaryPositionName"]) || "",
      raw: value,
    });
    if (normalized) candidates.push(normalized);
  });

  const byKey = new Map();
  for (const player of candidates) {
    if (player.rank < 1 || player.rank > 100) continue;
    const existing = byKey.get(player.playerKey);
    if (!existing || player.rank < existing.rank) byKey.set(player.playerKey, player);
  }
  return [...byKey.values()].sort((a, b) => a.rank - b.rank).slice(0, 100);
}

function normalizeRanking({ rank, playerName, playerId = "", mlbamId = "", org = "", position = "", raw = {} }) {
  const numericRank = Number(String(rank).replaceAll(/[^0-9]/g, ""));
  const name = cleanText(playerName);
  if (!Number.isFinite(numericRank) || numericRank < 1 || numericRank > 100 || !name) return null;
  const cleanMlbam = cleanText(mlbamId);
  const cleanId = cleanText(playerId);
  const playerKey = cleanMlbam ? `mlbam:${cleanMlbam}` : cleanId ? `id:${cleanId}` : `name:${normalizeName(name)}`;
  return {
    playerKey,
    playerId: cleanId,
    mlbamId: cleanMlbam,
    playerName: name,
    org: cleanText(org),
    position: cleanPosition(position),
    rank: numericRank,
    raw,
  };
}

function nextDataJson(html) {
  const match = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  return match?.[1] ? decodeHtml(match[1]) : "";
}

function walk(value, visitor) {
  visitor(value);
  if (Array.isArray(value)) {
    value.forEach((item) => walk(item, visitor));
  } else if (value && typeof value === "object") {
    Object.values(value).forEach((item) => walk(item, visitor));
  }
}

function firstValue(object, keys) {
  for (const key of keys) {
    if (object[key] != null && object[key] !== "") return object[key];
  }
  return null;
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
      if (row.some((value) => value.trim() !== "")) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  row.push(cell);
  if (row.some((value) => value.trim() !== "")) rows.push(row);

  const [header = [], ...records] = rows;
  return records.map((record) => Object.fromEntries(header.map((key, index) => [key.trim(), record[index]?.trim() ?? ""])));
}

function looksLikeCsv(value) {
  const firstLine = value.split(/\r?\n/, 1)[0] || "";
  return firstLine.includes(",") && /rank|player|prospect/i.test(firstLine);
}

function cleanText(value) {
  if (value == null) return "";
  if (typeof value === "object") {
    if (value.name) return cleanText(value.name);
    if (value.fullName) return cleanText(value.fullName);
    if (value.abbreviation) return cleanText(value.abbreviation);
    return "";
  }
  return decodeHtml(String(value)).replaceAll(/\s+/g, " ").trim();
}

function cleanPosition(value) {
  const text = cleanText(value);
  if (!text.includes(",")) return text;
  return text.split(",")[0].trim();
}

function normalizeName(value) {
  return cleanText(value)
    .normalize("NFD")
    .replaceAll(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, " ")
    .trim();
}

function decodeHtml(value) {
  return String(value)
    .replaceAll("&quot;", '"')
    .replaceAll("&#x27;", "'")
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function isoDate(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function daysBetween(startDate, endDate) {
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  return Math.floor((end - start) / 86400000);
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
    },
  });
}
