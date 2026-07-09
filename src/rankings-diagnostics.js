import { parseCsv } from "./lib/csv.js";
import { mergeProspectData } from "./lib/scoring.js";

const rowsElement = document.querySelector("#diagnostics-rows");
const countElement = document.querySelector("#diagnostics-count");
const filterButtons = [...document.querySelectorAll("[data-diagnostics-filter]")];

const state = {
  rows: [],
  filter: "all",
};

init();

async function init() {
  try {
    const [
      top100,
      stats,
      savantStats,
      depthCharts,
      news,
      enrichment,
      rankHistory,
      marketData,
      onDeckData,
      emergingData,
      removedData,
    ] = await Promise.all([
      csv("./data/mlb-top100-2026.csv?v=20260702-current"),
      csv("./data/current-stats.csv"),
      csv("./data/savant-stats.csv"),
      csv("./data/depth-chart-current.csv"),
      csv("./data/player-news.csv"),
      csv("./data/player-enrichment.csv"),
      csv("./data/rank-history.csv?v=20260702-current"),
      json("/api/top100-market-data").catch(() => ({ snapshots: [] })),
      json("/api/on-deck?limit=50").catch(() => ({ items: [] })),
      json("/api/emerging?limit=500&include_watch=true&include_low_priority=true").catch(() => ({ items: [] })),
      json("/api/emerging?tier=top100_removed&limit=500").catch(() => ({ items: [] })),
    ]);

    const enrichedTop100 = applyOverlay(top100, mergeRowsByPlayerId(enrichment, rankHistory));
    const scoredTop100 = mergeProspectData(
      enrichedTop100,
      mergeRowsByPlayerId(stats, savantStats),
      mergeRowsByPlayerId(depthCharts, news),
    );
    const marketById = new Map((marketData.snapshots || []).map((row) => [String(row.playerId), row]));
    const onDeckById = new Map((onDeckData.items || onDeckData.players || []).map((row) => [String(row.player_id || row.playerId), row]));
    const pool = [
      ...scoredTop100.map((row) => normalizeTop100(row, marketById.get(String(row.player_id)), onDeckById.get(String(row.player_id)))),
      ...(emergingData.items || emergingData.prospects || []).map((row) => normalizeEmerging(row, onDeckById.get(String(row.player_id)))),
      ...(removedData.items || removedData.prospects || []).map((row) => normalizeEmerging(row, onDeckById.get(String(row.player_id)), "Graduated")),
    ];

    state.rows = dedupe(pool).map(enrichDiagnostics).sort(defaultSort).map((row, index) => ({ ...row, finalRank: index + 1 }));
    render();
  } catch (error) {
    console.error(error);
    rowsElement.innerHTML = `<tr><td colspan="20" class="muted">Diagnostics failed to load.</td></tr>`;
    countElement.textContent = "Diagnostics unavailable";
  }
}

filterButtons.forEach((button) => {
  button.addEventListener("click", () => {
    state.filter = button.dataset.diagnosticsFilter;
    filterButtons.forEach((candidate) => candidate.classList.toggle("primary", candidate === button));
    filterButtons.forEach((candidate) => candidate.classList.toggle("ghost", candidate !== button));
    render();
  });
});

async function csv(path) {
  const response = await fetch(path);
  if (!response.ok) return [];
  return parseCsv(await response.text());
}

async function json(path) {
  const response = await fetch(path, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  return response.json();
}

function mergeRowsByPlayerId(primaryRows, overlayRows) {
  const byId = new Map(primaryRows.map((row) => [String(row.player_id || ""), row]));
  for (const row of overlayRows) {
    const key = String(row.player_id || "");
    if (!key) continue;
    byId.set(key, { ...(byId.get(key) || {}), ...nonBlank(row) });
  }
  return [...byId.values()];
}

function nonBlank(row) {
  return Object.fromEntries(Object.entries(row || {}).filter(([, value]) => value !== "" && value != null));
}

function applyOverlay(rows, overlayRows) {
  const byId = new Map(overlayRows.map((row) => [String(row.player_id || ""), row]));
  return rows.map((row) => ({ ...row, ...nonBlank(byId.get(String(row.player_id || "")) || {}) }));
}

function normalizeTop100(row, market = {}, onDeck = {}) {
  const marketRow = marketFields(market);
  return {
    ...row,
    ...marketRow,
    ...nonBlank(onDeck || {}),
    key: `top100:${row.player_id}`,
    playerId: row.player_id,
    playerName: row.player_name,
    source: isGraduated(row) ? "Graduated" : "Top 100",
    team: row.org || market.team || "",
    age: cleanNumber(row.age),
    level: row.level || row.current_level || "",
    moveScore: cleanNumber(onDeck.move_score ?? onDeck.opportunity_score ?? row.callup_score),
    top100Rank: cleanNumber(row.prospect_rank),
    previousRank: cleanNumber(row.previous_rank),
    cardCode: market.benchmarkCardCode || row.card_code || "",
    currentPrice: money(onDeck.market_last_sold_price ?? onDeck.market_avg_price_30d ?? marketRow.currentPrice),
    avg30: money(onDeck.market_avg_price_30d ?? marketRow.avg30),
    avg90: money(onDeck.market_avg_price_90d ?? marketRow.avg90),
    sales30: cleanNumber(onDeck.market_sales_count_30d ?? marketRow.sales30),
    sales90: cleanNumber(onDeck.market_sales_count_90d ?? marketRow.sales90),
    sellThrough30: cleanNumber(onDeck.market_sell_through_30d ?? marketRow.sellThrough30),
    sellThrough90: cleanNumber(onDeck.market_sell_through_90d ?? marketRow.sellThrough90),
    marketRead: onDeck.market_read || marketRow.marketRead || "",
    status: isGraduated(row) ? "Graduated" : "",
  };
}

function normalizeEmerging(row, onDeck = {}, forcedSource = "") {
  const tier = String(row.priority_tier || row.pre_tier || "").toLowerCase();
  const source = forcedSource || (tier.includes("watch") || row.status === "watch" ? "Watchlist" : "Emerging");
  return {
    ...row,
    ...nonBlank(onDeck || {}),
    key: `${source.toLowerCase()}:${row.player_id}`,
    playerId: row.player_id,
    playerName: row.player_name,
    source,
    team: row.team || row.current_team || row.current_org || row.team_on_card || "",
    age: cleanNumber(row.age ?? row.player_age),
    level: row.level || row.stat_level || row.stats_level || "",
    moveScore: cleanNumber(onDeck.move_score ?? row.move_score ?? row.emerging_pre_score ?? row.recommendation_total_score),
    cardCode: row.card_code || row.auto_code || row.card_number || row.benchmarkCardCode || "",
    currentPrice: money(onDeck.market_last_sold_price ?? row.market_last_sold_price ?? row.market_avg_price_30d),
    avg30: money(onDeck.market_avg_price_30d ?? row.market_avg_price_30d),
    avg90: money(onDeck.market_avg_price_90d ?? row.market_avg_price_90d),
    sales30: cleanNumber(onDeck.market_sales_count_30d ?? row.market_sales_count_30d),
    sales90: cleanNumber(onDeck.market_sales_count_90d ?? row.market_sales_count_90d),
    sellThrough30: cleanNumber(onDeck.market_sell_through_30d ?? row.market_sell_through_30d),
    sellThrough90: cleanNumber(onDeck.market_sell_through_90d ?? row.market_sell_through_90d),
    marketRead: onDeck.market_read || row.market_read || row.market_signal || "",
    status: forcedSource || "",
    ops: cleanNumber(row.hitter_ops),
    era: cleanNumber(row.pitcher_era),
    kMinusBb: cleanNumber(row.pitcher_k_minus_bb_pct),
  };
}

function marketFields(market) {
  return {
    currentPrice: money(market.lastSoldPrice ?? market.avgSoldPrice30d),
    avg30: money(market.avgSoldPrice30d),
    avg90: money(market.avgSoldPrice90d),
    sales30: cleanNumber(market.salesCount30d),
    sales90: cleanNumber(market.salesCount90d),
    sellThrough30: cleanNumber(market.sellThruRate30d),
    sellThrough90: cleanNumber(market.sellThruRate90d),
    marketRead: market.targetOnly ? "Needs Market" : "",
  };
}

function dedupe(rows) {
  const byKey = new Map();
  for (const row of rows) {
    const key = `${normalize(row.playerName)}:${row.source}`;
    if (!row.playerName || byKey.has(key)) continue;
    byKey.set(key, row);
  }
  return [...byKey.values()];
}

function enrichDiagnostics(row) {
  const current = money(row.currentPrice ?? row.last_sale ?? row.avg30);
  const target = targetEntry(row, current);
  const marketOpportunityScore = marketOpportunity(row, current);
  const catalyst = catalystScore(row);
  const ceiling = ceilingScore(row);
  const excludedReason = excludedReasonFor(row, current, target, marketOpportunityScore);
  const eligible = excludedReason === "Eligible";
  const thesis = thesisFor(row, current);
  return {
    ...row,
    currentPrice: current,
    targetEntry: target,
    entryLabel: Number.isFinite(target) ? currency(target) : "-",
    marketOpportunityScore,
    catalystScore: catalyst,
    ceilingScore: ceiling,
    thesis,
    liquidity: liquidityLabel(row),
    sellThrough: sellThroughLabel(row),
    trend30: trend30(row),
    trend90: trend90(row),
    eligible,
    excludedReason: eligible ? "" : excludedReason,
  };
}

function excludedReasonFor(row, current, target, marketOpportunityScore) {
  if (row.source === "Graduated" || String(row.status).toLowerCase() === "graduated") return "Graduated";
  if (!row.cardCode) return "No Bowman auto target";
  if (!Number.isFinite(current)) return "Missing card price";
  if (!Number.isFinite(row.age)) return "Missing age";
  if (!Number.isFinite(row.moveScore) || row.moveScore < 80) return "Score below cutoff";
  if (!positiveBaseball(row)) return "Not enough confidence";
  if (liquidityScore(row) < 58) return "Liquidity below threshold";
  if (sellThroughTooLow(row)) return "Sell-through too low";
  if (marketCooling(row)) return "Market trend cooling";
  if (Number.isFinite(target) && current > target) return "Entry above target";
  if (marketOpportunityScore < 70) return "Not enough confidence";
  return "Eligible";
}

function targetEntry(row, current) {
  if (!Number.isFinite(current)) return NaN;
  if (marketCooling(row)) return current * 0.86;
  if (trendPercent(row) >= 12) return current * 1.03;
  if (Number.isFinite(row.avg30) && Number.isFinite(row.avg90)) return Math.min(row.avg30 * 0.97, row.avg90 * 1.02);
  if (Number.isFinite(row.avg30)) return row.avg30 * 0.97;
  return current * 0.94;
}

function marketOpportunity(row, current) {
  const attention = attentionSignal(row);
  const performance = performanceSignal(row);
  const market = marketSignal(row);
  const discipline = priceDiscipline(row);
  return Math.round(clamp(attention * 0.5 + performance * 0.2 + market * 0.2 + discipline * 0.1));
}

function attentionSignal(row) {
  const rankScore = Number.isFinite(row.top100Rank) ? inverseScale(row.top100Rank, 1, 100) : cleanNumber(row.moveScore) || 45;
  const movement = rankMovement(row);
  const movementScore = Number.isFinite(movement) ? clamp(50 + movement * 3) : 50;
  const levelScore = levelAttention(row.level);
  const ageScore = ageToLevel(row.age, row.level);
  return clamp(rankScore * 0.5 + movementScore * 0.2 + levelScore * 0.15 + ageScore * 0.15);
}

function performanceSignal(row) {
  if (Number.isFinite(row.ops)) return scale(row.ops, 0.68, 1.0);
  if (Number.isFinite(row.era)) return inverseScale(row.era, 2.2, 5.2);
  return Number.isFinite(row.moveScore) ? clamp(row.moveScore) : 50;
}

function marketSignal(row) {
  if (!row.cardCode) return 20;
  if ((!Number.isFinite(row.sales30) || row.sales30 <= 0) && (!Number.isFinite(row.sales90) || row.sales90 <= 0)) return 35;
  const volume = clamp(scale(Number.isFinite(row.sales30) ? row.sales30 : row.sales90 / 3, 1, 30));
  return clamp(volume * 0.65 + liquidityScore(row) * 0.35);
}

function priceDiscipline(row) {
  const move = trendPercent(row);
  if (!Number.isFinite(move)) return 55;
  if (move > 40) return 20;
  if (move > 25) return 35;
  if (move >= -10 && move <= 18) return 85;
  if (move < -25) return 45;
  return 65;
}

function catalystScore(row) {
  const level = String(row.level || "").toUpperCase();
  let score = 0;
  if (level === "AAA") score += 40;
  else if (level === "AA") score += 30;
  else if (level === "A+" || level === "A") score += 18;
  if (rankMovement(row) > 0) score += 12;
  if (Number(row.moveScore) >= 85) score += 8;
  return score;
}

function ceilingScore(row) {
  const levelBoost = { AAA: 12, AA: 14, "A+": 10, A: 8 }[String(row.level || "").toUpperCase()] || 5;
  const ageBoost = Number.isFinite(row.age) ? Math.max(0, 24 - row.age) * 3 : 6;
  const rankBoost = Number.isFinite(row.top100Rank) ? Math.max(0, 105 - row.top100Rank) / 4 : 8;
  return Math.round((cleanNumber(row.moveScore) || 0) + levelBoost + ageBoost + rankBoost + Math.max(0, rankMovement(row) || 0) * 1.2);
}

function positiveBaseball(row) {
  if (Number(row.moveScore) >= 82) return true;
  if (rankMovement(row) > 0) return true;
  if (Number(row.ops) >= 0.82) return true;
  if (Number(row.era) <= 3.75) return true;
  if (Number(row.kMinusBb) >= 18) return true;
  return String(row.level || "").toUpperCase() === "AAA" && Number(row.moveScore) >= 70;
}

function thesisFor(row, current) {
  const parts = [];
  if (Number.isFinite(current)) parts.push(`${currency(current)} current comp`);
  if (Number.isFinite(row.sales30) && row.sales30 > 0) parts.push(`${Math.round(row.sales30)} sales in 30D`);
  if (Number.isFinite(trendPercent(row))) {
    const trend = trendPercent(row);
    parts.push(trend >= 8 ? `price up ${Math.round(trend)}% vs 90D` : trend <= -8 ? `price down ${Math.abs(Math.round(trend))}% vs 90D` : "price steady vs 90D");
  }
  if (rankMovement(row) > 0) parts.push(`rank/move signal +${Math.round(rankMovement(row))}`);
  return parts.length ? parts.slice(0, 3).join("; ") : "No market thesis yet";
}

function liquidityScore(row) {
  if (Number(row.sales30) >= 25) return 95;
  if (Number(row.sales30) >= 12) return 85;
  if (Number(row.sales30) >= 5) return 72;
  if (Number(row.sales90) >= 30) return 68;
  if (Number(row.sales90) >= 12) return 58;
  return 35;
}

function liquidityLabel(row) {
  const score = liquidityScore(row);
  if (score >= 85) return "Liquid";
  if (score >= 58) return "Acceptable";
  if (score > 35) return "Thin";
  return "Missing";
}

function sellThroughTooLow(row) {
  if (Number.isFinite(row.sellThrough30) && row.sellThrough30 > 0 && row.sellThrough30 < 15) return true;
  if (Number.isFinite(row.sellThrough90) && row.sellThrough90 > 0 && row.sellThrough90 < 20) return true;
  return false;
}

function sellThroughLabel(row) {
  if (Number.isFinite(row.sellThrough30) && row.sellThrough30 > 0) return `${row.sellThrough30.toFixed(1)}% 30D`;
  if (Number.isFinite(row.sellThrough90) && row.sellThrough90 > 0) return `${row.sellThrough90.toFixed(1)}% 90D`;
  return "-";
}

function marketCooling(row) {
  return trendPercent(row) <= -12 || String(row.marketRead || "").toLowerCase().includes("down") || String(row.marketRead || "").toLowerCase().includes("cooling");
}

function trendPercent(row) {
  if (Number.isFinite(row.avg30) && Number.isFinite(row.avg90) && row.avg90 > 0) return ((row.avg30 - row.avg90) / row.avg90) * 100;
  return NaN;
}

function trend30(row) {
  const trend = trendPercent(row);
  if (!Number.isFinite(trend)) return "-";
  return `${trend >= 0 ? "+" : ""}${Math.round(trend)}%`;
}

function trend90(row) {
  if (Number.isFinite(row.avg90)) return currency(row.avg90);
  return "-";
}

function rankMovement(row) {
  if (Number.isFinite(row.previousRank) && Number.isFinite(row.top100Rank)) return row.previousRank - row.top100Rank;
  const direct = cleanNumber(row.trend ?? row.rank_movement ?? row.movement);
  return Number.isFinite(direct) ? direct : 0;
}

function defaultSort(a, b) {
  return Number(b.eligible) - Number(a.eligible)
    || b.marketOpportunityScore - a.marketOpportunityScore
    || Number(b.moveScore || 0) - Number(a.moveScore || 0)
    || a.playerName.localeCompare(b.playerName);
}

function render() {
  const rows = state.rows.filter(matchesFilter);
  countElement.textContent = `${rows.length} of ${state.rows.length} players`;
  rowsElement.innerHTML = rows.length
    ? rows.map(rowMarkup).join("")
    : `<tr><td colspan="20" class="muted">No players match this filter.</td></tr>`;
}

function matchesFilter(row) {
  if (state.filter === "eligible") return row.eligible;
  if (state.filter === "excluded") return !row.eligible;
  if (state.filter === "top100") return row.source === "Top 100";
  if (state.filter === "emerging") return row.source === "Emerging";
  if (state.filter === "under20") return Number(row.currentPrice) < 20;
  if (state.filter === "missing-market") return !Number.isFinite(row.currentPrice);
  if (state.filter === "wait") return row.excludedReason === "Entry above target" || row.excludedReason === "Market trend cooling";
  if (state.filter === "need-comps") return row.excludedReason === "Missing card price" || row.excludedReason === "No Bowman auto target";
  return true;
}

function rowMarkup(row) {
  return `
    <tr class="${row.eligible ? "diagnostic-eligible" : "diagnostic-excluded"}">
      <td><strong>${escapeHtml(row.playerName)}</strong></td>
      <td>${escapeHtml(row.source)}</td>
      <td>${escapeHtml(row.team || "-")}</td>
      <td>${display(row.age)}</td>
      <td>${escapeHtml(row.level || "-")}</td>
      <td>${display(row.moveScore)}</td>
      <td>${display(row.marketOpportunityScore)}</td>
      <td>${moneyDisplay(row.currentPrice)}</td>
      <td>${moneyDisplay(row.targetEntry)}</td>
      <td>${escapeHtml(row.entryLabel)}</td>
      <td>${escapeHtml(row.thesis)}</td>
      <td>${escapeHtml(row.liquidity)}</td>
      <td>${escapeHtml(row.sellThrough)}</td>
      <td>${escapeHtml(row.trend30)}</td>
      <td>${escapeHtml(row.trend90)}</td>
      <td>${display(row.catalystScore)}</td>
      <td>${display(row.ceilingScore)}</td>
      <td>${row.eligible ? "Yes" : "No"}</td>
      <td>${escapeHtml(row.excludedReason || "Eligible")}</td>
      <td>${row.finalRank}</td>
    </tr>
  `;
}

function isGraduated(row) {
  return String(row.lifecycleStatus || row.lifecycle_status || "").toLowerCase() === "graduated"
    || String(row.graduated || "").toLowerCase() === "true"
    || String(row.level || "").toUpperCase() === "MLB";
}

function levelAttention(level) {
  return { MLB: 100, AAA: 88, AA: 70, "A+": 46, A: 34, ROK: 12, RK: 12 }[String(level || "").toUpperCase()] || 45;
}

function ageToLevel(age, level) {
  if (!Number.isFinite(age)) return 50;
  const baseline = { AAA: 24, AA: 23, "A+": 22, A: 21, ROK: 20, RK: 20 }[String(level || "").toUpperCase()] || 23;
  return clamp(65 + (baseline - age) * 8);
}

function scale(value, min, max) {
  if (!Number.isFinite(value)) return NaN;
  return clamp(((value - min) / (max - min)) * 100);
}

function inverseScale(value, min, max) {
  if (!Number.isFinite(value)) return NaN;
  return clamp(100 - ((value - min) / (max - min)) * 100);
}

function clamp(value) {
  return Math.max(0, Math.min(100, value));
}

function cleanNumber(value) {
  if (value === "" || value == null) return NaN;
  const numeric = Number(String(value).replaceAll(/[$,%]/g, ""));
  return Number.isFinite(numeric) ? numeric : NaN;
}

function money(value) {
  if (value === "" || value == null) return NaN;
  const numeric = Number(String(value).replaceAll(/[^0-9.-]/g, ""));
  return Number.isFinite(numeric) && numeric > 0 ? numeric : NaN;
}

function currency(value) {
  return `$${Number(value).toFixed(Number(value) >= 100 ? 0 : 2)}`;
}

function moneyDisplay(value) {
  return Number.isFinite(value) ? currency(value) : "-";
}

function display(value) {
  return Number.isFinite(Number(value)) ? String(Math.round(Number(value))) : "-";
}

function normalize(value) {
  return String(value || "").toLowerCase().replaceAll(/[^a-z0-9]+/g, " ").trim();
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}
