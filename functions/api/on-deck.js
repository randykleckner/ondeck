import { parseCsv } from "../../src/lib/csv.js";
import { mergeProspectData } from "../../src/lib/scoring.js";

export async function onOnDeckRequest(context) {
  if (context.request.method !== "GET") {
    return jsonResponse({ error: "Method not allowed." }, 405, { Allow: "GET" });
  }

  try {
    const [top100, stats, savantStats, depthCharts, news, cardTargets] = await Promise.all([
      readCsvAsset(context, "/data/mlb-top100-2026.csv").catch(() => []),
      readCsvAsset(context, "/data/current-stats.csv").catch(() => []),
      readCsvAsset(context, "/data/savant-stats.csv").catch(() => []),
      readCsvAsset(context, "/data/depth-chart-current.csv").catch(() => []),
      readCsvAsset(context, "/data/player-news.csv").catch(() => []),
      readCsvAsset(context, "/data/card-targets.csv").catch(() => []),
    ]);

    if (!top100.length) {
      return emptyResponse("No current records found");
    }

    const scored = applyCardTargets(
      mergeProspectData(top100, mergeRowsByPlayerId(stats, savantStats), mergeRowsByPlayerId(depthCharts, news)),
      cardTargets,
    )
      .filter((player) => String(player.level || "").toUpperCase() !== "MLB")
      .sort((a, b) => Number(b.callup_score || 0) - Number(a.callup_score || 0) || Number(a.prospect_rank || 9999) - Number(b.prospect_rank || 9999));

    const items = scored.slice(0, 10).map(onDeckApiRow);
    if (!items.length) {
      return emptyResponse("No current records found");
    }

    return jsonResponse({
      items,
      players: items,
      count: items.length,
      status: "ok",
      source: "cached_static_profile_data",
      message: "Cached On Deck board response. Recommendation snapshots are not required for this fallback route.",
    }, 200, {
      "Cache-Control": "public, max-age=300",
    });
  } catch (error) {
    console.error("on-deck route failed", safeError(error));
    return emptyResponse("No current records found");
  }
}

function onDeckApiRow(player) {
  return {
    playerId: player.player_id,
    playerName: player.player_name,
    team: player.org,
    position: player.position,
    level: player.level,
    age: player.age,
    eta: player.eta,
    rank: player.prospect_rank,
    moveScore: player.callup_score,
    onDeckGrade: player.recommendation_grade || "",
    marketRead: player.market_signal || "",
    benchmarkCardCode: player.card_code || "",
    canonicalQuery: player.card_query || "",
  };
}

function applyCardTargets(players, cardTargets) {
  const enabledTargets = cardTargets.filter((row) => String(row.enabled ?? "true").toLowerCase() !== "false");
  const byId = new Map(enabledTargets.map((row) => [String(row.player_id), row]));
  const byName = new Map(enabledTargets.map((row) => [normalizeName(row.player_name), row]));
  return players.map((player) => {
    const target = byId.get(String(player.player_id)) || byName.get(normalizeName(player.player_name));
    return target ? { ...player, ...target, player_id: player.player_id, player_name: player.player_name } : player;
  });
}

function mergeRowsByPlayerId(primaryRows, overlayRows) {
  const byId = new Map(primaryRows.map((row) => [String(row.player_id), row]));
  for (const row of overlayRows) {
    const key = String(row.player_id || "");
    if (!key) continue;
    byId.set(key, { ...(byId.get(key) || {}), ...nonBlank(row) });
  }
  return [...byId.values()];
}

function nonBlank(row) {
  return Object.fromEntries(Object.entries(row).filter(([, value]) => value !== "" && value != null));
}

function normalizeName(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replaceAll(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, " ")
    .trim();
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

function jsonResponse(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

function emptyResponse(message) {
  return jsonResponse({
    items: [],
    players: [],
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
