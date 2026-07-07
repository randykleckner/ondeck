import { parseCsv } from "./lib/csv.js";
import { mergeProspectData } from "./lib/scoring.js?v=20260626-6";

const root = document.querySelector("#player-profile-root");
const params = new URLSearchParams(window.location.search);
const profileType = params.get("type") || "on-deck";
const playerId = params.get("id") || "";

loadProfile();

async function loadProfile() {
  if (!root) return;
  if (!playerId) {
    renderError("No player was selected.");
    return;
  }

  try {
    const player = profileType === "emerging"
      ? await loadEmergingProfile(playerId)
      : await loadTop100Profile(playerId);

    if (!player) {
      renderError("Player profile not found.");
      return;
    }
    renderProfile(normalizeProfile(player, profileType));
  } catch (error) {
    console.error(error);
    renderError("Player briefing is unavailable right now.");
  }
}

async function loadEmergingProfile(id) {
  const response = await fetch(`/api/emerging/${encodeURIComponent(id)}`, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`Emerging profile unavailable (${response.status})`);
  const data = await response.json();
  const prospect = data.prospect || {};
  return {
    ...prospect,
    ...(prospect.latest_market_snapshot || {}),
    ...(prospect.latest_recommendation || {}),
    source_type: "emerging",
  };
}

async function loadTop100Profile(id) {
  const top100Prospects = (await loadCsv("./data/mlb-top100-2026.csv?v=20260702-current")).map((player) => ({
    ...player,
    prospect_source: player.prospect_source || "MLB Top 100",
  }));
  const [orgProspects, stats, savantStats, depthCharts, enrichment, news, rankHistory, cardTargets] = await Promise.all([
    loadOptionalCsv("./data/org-prospects.csv?v=20260630-1"),
    loadOptionalCsv("./data/current-stats.csv?v=20260626-2"),
    loadOptionalCsv("./data/savant-stats.csv?v=20260626-1"),
    loadOptionalCsv("./data/depth-chart-current.csv"),
    loadOptionalCsv("./data/player-enrichment.csv"),
    loadOptionalCsv("./data/player-news.csv"),
    loadOptionalCsv("./data/rank-history.csv?v=20260702-current"),
    loadOptionalCsv("./data/card-targets.csv?v=20260706-1"),
  ]);
  const enrichmentRows = mergeRowsByPlayerId(enrichment, rankHistory);
  const prospects = applyProspectEnrichment(mergeProspectUniverse(top100Prospects, orgProspects, enrichmentRows), enrichmentRows);
  const scored = applyCardTargets(mergeProspectData(prospects, mergeRowsByPlayerId(stats, savantStats), mergeRowsByPlayerId(depthCharts, news)), cardTargets);
  const cachedMarkets = await loadCachedMarkets();
  const player = scored.find((candidate) => String(candidate.player_id) === String(id));
  if (!player) return null;
  return {
    ...player,
    ...(cachedMarkets.get(String(player.player_id)) || {}),
    source_type: profileType,
    on_deck_rank: onDeckRank(scored, player),
  };
}

async function loadCsv(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`Could not load ${path}`);
  return parseCsv(await response.text());
}

async function loadOptionalCsv(path) {
  const response = await fetch(path).catch(() => null);
  if (!response?.ok) return [];
  return parseCsv(await response.text());
}

async function loadCachedMarkets() {
  try {
    const response = await fetch("/api/top100-market-data", { headers: { Accept: "application/json" } });
    if (!response.ok) return new Map();
    const data = await response.json();
    return new Map((data.snapshots || [])
      .map(normalizeMarketSnapshot)
      .filter((snapshot) => snapshot.player_id)
      .map((snapshot) => [String(snapshot.player_id), snapshot]));
  } catch {
    return new Map();
  }
}

function mergeProspectUniverse(top100Prospects, orgProspects, enrichmentRows = []) {
  const byId = new Map(top100Prospects.map((player) => [String(player.player_id), player]));
  for (const player of orgProspects) {
    if (!player.player_id || !player.player_name) continue;
    const key = String(player.player_id);
    byId.set(key, {
      ...(byId.get(key) || {}),
      ...player,
      prospect_source: player.prospect_source || byId.get(key)?.prospect_source || "Org Top Prospect",
    });
  }
  for (const player of enrichmentRows) {
    if (!player.player_id || !player.player_name || byId.has(String(player.player_id))) continue;
    byId.set(String(player.player_id), {
      ...player,
      level: player.current_level || player.level,
      org: player.org || player.current_team || "",
      prospect_source: player.prospect_source || "Previous Top 100",
    });
  }
  return [...byId.values()];
}

function applyProspectEnrichment(prospects, enrichment) {
  const byId = new Map(enrichment.map((row) => [String(row.player_id), row]));
  return prospects.map((prospect) => {
    const overlay = byId.get(String(prospect.player_id));
    if (!overlay) return prospect;
    return {
      ...prospect,
      ...overlay,
      level: overlay.current_level || prospect.level,
      on_40man: overlay.on_40man ?? prospect.on_40man,
    };
  });
}

function mergeRowsByPlayerId(primaryRows, overlayRows) {
  const byId = new Map(primaryRows.map((row) => [String(row.player_id), { ...row }]));
  for (const row of overlayRows) {
    const key = String(row.player_id);
    byId.set(key, mergeNonBlank(byId.get(key) || {}, row));
  }
  return [...byId.values()];
}

function mergeNonBlank(base, overlay) {
  const merged = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    if (value !== "" && value != null) merged[key] = value;
    else if (!(key in merged)) merged[key] = value;
  }
  return merged;
}

function applyCardTargets(players, cardTargets) {
  const enabledTargets = cardTargets.filter((row) => String(row.enabled ?? "true").toLowerCase() !== "false");
  const byId = new Map(enabledTargets.map((row) => [String(row.player_id), row]));
  const byName = new Map(enabledTargets.map((row) => [normalizeName(row.player_name), row]));
  return players.map((player) => {
    const target = byId.get(String(player.player_id)) || byName.get(normalizeName(player.player_name));
    if (!target) return player;
    return {
      ...player,
      card_code: target.card_code || player.card_code,
      card_query: target.card_query || player.card_query,
      card_name: target.card_name || player.card_name,
      sell_through_30: target.sell_through_30 || player.sell_through_30,
      sell_through_90: target.sell_through_90 || player.sell_through_90,
      sellers_30: target.sellers_30 || player.sellers_30,
      sellers_90: target.sellers_90 || player.sellers_90,
      card_year: target.card_year || player.card_year,
      card_notes: target.notes || player.card_notes,
    };
  });
}

function onDeckRank(scored, player) {
  const active = scored
    .filter((candidate) => !isCalledUp(candidate))
    .sort((a, b) => b.callup_score - a.callup_score || b.opportunity_score - a.opportunity_score || Number(a.prospect_rank) - Number(b.prospect_rank))
    .slice(0, 10);
  const index = active.findIndex((candidate) => String(candidate.player_id) === String(player.player_id));
  return index >= 0 ? index + 1 : "";
}

function normalizeProfile(row, type) {
  const physical = splitHeightWeight(row.height_weight || "");
  const score = firstValue(row.callup_score, row.move_score, row.emerging_pre_score, row.recommendation_total_score);
  return {
    ...row,
    type,
    name: firstValue(row.player_name, row.name, "Player"),
    org: firstValue(row.org, row.current_org, row.team_on_card, row.team, "Org pending"),
    position: firstValue(row.position, row.pos, row.stats_role, "Position pending"),
    level: firstValue(row.level, row.current_level, row.stat_level, "Level pending"),
    age: firstValue(row.age, ""),
    height: firstValue(row.height, physical.height, ""),
    weight: firstValue(row.weight, physical.weight, ""),
    bats: firstValue(row.bats, ""),
    throws: firstValue(row.throws, ""),
    eta: firstValue(row.eta, ""),
    rank: firstValue(row.prospect_rank, row.rank, ""),
    opportunityScore: Number.isFinite(Number(score)) ? Math.round(Number(score)) : "",
    code: firstValue(row.card_code, row.auto_code, row.benchmark_card_code, fallbackCardCode(row.player_name || row.name)),
    market: normalizeMarketFields(row),
  };
}

function renderProfile(player) {
  document.title = `OnDeck Prospect | ${player.name}`;
  root.innerHTML = `
    <section class="profile-card-page">
      <nav class="profile-back-nav" aria-label="Profile navigation">
        <a href="${escapeHtml(backHref(player.type))}">Back to ${escapeHtml(backLabel(player.type))}</a>
      </nav>
      <article class="odp-card-shell" aria-label="On Deck briefing for ${escapeHtml(player.name)}">
        <div class="odp-card-frame">
          <div class="odp-card-inner">
            ${profileHeader(player)}
            ${briefingTitle(player)}
            ${briefingSections(player)}
            ${recordTable(player)}
            ${marketSnapshot(player)}
          </div>
        </div>
      </article>
      ${profileDetails(player)}
    </section>
  `;
}

function profileHeader(player) {
  return `
    <header class="odp-card-header">
      <div class="odp-nameplate">
        <h1>${escapeHtml(player.name)}</h1>
        <p>${escapeHtml(player.org)} · ${escapeHtml(player.position)} · ${escapeHtml(player.level)}</p>
      </div>
      <div class="odp-code-block">
        <span>${escapeHtml(player.code)}</span>
      </div>
    </header>
    <div class="odp-bio-line">
      ${bioSegments(player).map(([label, value]) => `<span><b>${escapeHtml(label)}:</b> ${escapeHtml(value)}</span>`).join("")}
    </div>
  `;
}

function bioSegments(player) {
  return [
    ["Age", player.age],
    ["HT", player.height],
    ["WT", player.weight],
    ["Bats", handedness(player.bats)],
    ["Throws", handedness(player.throws)],
    ["ETA", player.eta],
    ["Rank", player.rank ? `#${player.rank}` : ""],
    ["Opportunity Score", player.opportunityScore],
  ].filter(([, value]) => value !== "" && value != null);
}

function briefingTitle(player) {
  const title = player.type === "top100"
    ? "Top 100 Market Snapshot"
    : player.type === "emerging"
      ? "Emerging Prospect Briefing"
      : "On Deck Briefing";
  return `<h2 class="odp-briefing-title"><span>---- ${escapeHtml(title.toUpperCase())} ----</span></h2>`;
}

function briefingSections(player) {
  return `
    <section class="odp-briefing-copy">
      ${briefingBlock("Resume", resumeText(player))}
      ${briefingBlock("Signals", signalsText(player))}
      <div class="odp-briefing-block">
        <h3>Edge:</h3>
        <p><strong>Why This Matters:</strong> ${escapeHtml(whyMatters(player))}</p>
        <p><strong>Main Risk:</strong> ${escapeHtml(mainRisk(player))}</p>
      </div>
    </section>
  `;
}

function briefingBlock(label, text) {
  return `
    <div class="odp-briefing-block">
      <h3>${escapeHtml(label)}:</h3>
      <p>${escapeHtml(text)}</p>
    </div>
  `;
}

function resumeText(player) {
  const loaded = firstValue(player.resume_summary, player.thesis, player.recommendation_thesis, player.pre_score_notes, "");
  if (loaded) return loaded;
  const score = player.opportunityScore ? `${player.opportunityScore} opportunity score` : "opportunity score pending";
  const rank = player.rank ? ` ranked #${player.rank}` : "";
  const stat = compactStatLine(player);
  return `${player.name} is a ${player.position} in the ${player.org} system${rank}, currently at ${player.level}, with ${score}. ${stat || "Briefing pending latest refresh."}`;
}

function signalsText(player) {
  const signals = [];
  signals.push(onDeckCatalyst(player));
  const movement = rankTrendText(player);
  if (movement !== "Untracked") signals.push(movement.startsWith("Up") ? "Rank Riser" : movement.startsWith("Down") ? "Rank Risk" : "Rank Stable");
  if (strongRecentForm(player)) signals.push("Strong Stats Signal");
  else if (compactStatLine(player)) signals.push("Stats Loaded");
  const status = marketStatusLabel(player);
  if (status !== "Pending" && status !== "Needs Market") signals.push("Card Market Confirmed");
  if (player.on_deck_rank) signals.push(`On Deck #${player.on_deck_rank}`);
  return signals.length ? signals.join(" ... ") : "Signals pending latest refresh.";
}

function whyMatters(player) {
  if (player.type === "emerging") {
    return `${player.name} is being monitored before the broader Top 100 attention cycle catches up.`;
  }
  if (rankMovement(player) > 0) {
    return `${player.name} is gaining Top 100 momentum while the next baseball catalyst is still ahead.`;
  }
  if (strongRecentForm(player)) {
    return `Current form is improving, which can move collector attention before the next promotion headline.`;
  }
  return `The next assignment or roster decision can change how quickly the market prices this player.`;
}

function mainRisk(player) {
  if (marketStatusLabel(player) === "Avoid Chase") return "The market may already be ahead of the baseball catalyst.";
  if (rankMovement(player) < 0) return "Top 100 movement is negative, so demand may need a stronger performance catalyst.";
  if (!hasMarketData(player)) return "Card-market data is not loaded yet, so the entry read needs confirmation.";
  if (!compactStatLine(player)) return "Current stat detail is thin until the next stats refresh.";
  return "Timing remains the key risk: the player path can be right while the market window moves first.";
}

function recordTable(player) {
  const pitcher = isPitcher(player.position);
  const title = pitcher ? "2026 Minor League Pitching Record" : "2026 Minor League Batting Record";
  const columns = pitcher
    ? pitchingColumns(player)
    : hittingColumns(player);
  const hasStats = columns.some((cell) => cell.key !== "yr" && cell.value !== "-");
  return `
    <section class="odp-record-section">
      <h3>${escapeHtml(title.toUpperCase())}</h3>
      ${hasStats ? `
        <table class="odp-record-table">
          <thead><tr>${columns.map((cell) => `<th>${escapeHtml(cell.label)}</th>`).join("")}</tr></thead>
          <tbody>
            <tr>${columns.map((cell) => `<td>${escapeHtml(cell.value)}</td>`).join("")}</tr>
            <tr class="totals">${columns.map((cell) => `<td>${escapeHtml(cell.value)}</td>`).join("")}</tr>
          </tbody>
        </table>
        <p>${escapeHtml(trendSentence(player))}</p>
      ` : `<p class="odp-pending">2026 stat line pending latest stats refresh.</p>`}
    </section>
  `;
}

function hittingColumns(player) {
  return [
    { key: "yr", label: "YR", value: "2026" },
    { key: "g", label: "G", value: countValue(firstValue(player.hitter_games, player.games, "")) },
    { key: "ab", label: "AB", value: countValue(firstValue(player.hitter_ab, player.ab, player.pa, "")) },
    { key: "hr", label: "HR", value: countValue(firstValue(player.hitter_hr, player.hr, "")) },
    { key: "rbi", label: "RBI", value: countValue(firstValue(player.hitter_rbi, player.rbi, "")) },
    { key: "slg", label: "SLG", value: statValue(firstValue(player.hitter_slg, player.slg, "")) },
    { key: "avg", label: "AVG", value: statValue(firstValue(player.hitter_avg, player.avg, "")) },
    { key: "ops", label: "OPS", value: statValue(firstValue(player.hitter_ops, player.ops, "")) },
  ];
}

function pitchingColumns(player) {
  return [
    { key: "yr", label: "YR", value: "2026" },
    { key: "g", label: "G", value: countValue(firstValue(player.pitcher_games, player.games, "")) },
    { key: "ip", label: "IP", value: statValue(firstValue(player.pitcher_ip, player.ip, "")) },
    { key: "era", label: "ERA", value: eraValue(firstValue(player.pitcher_era, player.era, "")) },
    { key: "whip", label: "WHIP", value: statValue(firstValue(player.pitcher_whip, player.whip, "")) },
    { key: "so", label: "SO", value: countValue(firstValue(player.pitcher_so, player.so, player.strikeouts, "")) },
    { key: "bb", label: "BB", value: countValue(firstValue(player.pitcher_bb, player.bb, player.walks, "")) },
    { key: "k_pct", label: "K%", value: percentStat(firstValue(player.pitcher_k_pct, player.k_pct, player.k_rate, player.k_per_9, "")) },
    { key: "bb_pct", label: "BB%", value: percentStat(firstValue(player.pitcher_bb_pct, player.bb_pct, player.bb_rate, player.bb_per_9, "")) },
  ];
}

function marketSnapshot(player) {
  const market = player.market;
  const items = [
    ["Benchmark Card", market.benchmark],
    ["Market Status", market.status],
    ["Liquidity", market.liquidity],
    ["Trend", market.trend],
    ["Actionable Range", market.range],
  ];
  return `
    <footer class="odp-market-snapshot">
      <h3>Market Snapshot</h3>
      <dl>
        ${items.map(([label, value]) => `
          <div>
            <dt>${escapeHtml(label)}:</dt>
            <dd>${escapeHtml(value)}</dd>
          </div>
        `).join("")}
      </dl>
    </footer>
  `;
}

function profileDetails(player) {
  return `
    <section class="profile-detail-actions" aria-label="Detailed player data">
      ${detailPanel("Card Details", cardDetails(player))}
      ${detailPanel("Stats Details", statsDetails(player))}
      ${detailPanel("Movement Details", movementDetails(player))}
    </section>
  `;
}

function detailPanel(title, body) {
  return `
    <details class="profile-detail-panel">
      <summary>${escapeHtml(title)}</summary>
      ${body}
    </details>
  `;
}

function cardDetails(player) {
  const rows = [
    ["Card Code", player.code],
    ["Query", firstValue(player.card_query, player.canonical_query, player.card_query_seed, "Pending")],
    ["Last Sale", currency(firstValue(player.last_sale, player.lastSoldPrice, ""))],
    ["30D Avg", currency(firstValue(player.avg_30, player.avgSoldPrice30d, ""))],
    ["90D Avg", currency(firstValue(player.avg_90, player.avgSoldPrice90d, ""))],
    ["30D Sales", countValue(firstValue(player.sales_30, player.salesCount30d, ""))],
    ["90D Sales", countValue(firstValue(player.sales_90, player.salesCount90d, ""))],
    ["30D Sell-Through", percentStat(firstValue(player.sell_through_30, player.sellThruRate30d, ""))],
  ];
  return detailList(rows);
}

function statsDetails(player) {
  const rows = isPitcher(player.position) ? pitchingColumns(player) : hittingColumns(player);
  return `
    ${detailList(rows.map((row) => [row.label, row.value]))}
    <p>${escapeHtml(trendSentence(player))}</p>
  `;
}

function movementDetails(player) {
  return detailList([
    ["Current Rank", player.rank ? `#${player.rank}` : "Pending"],
    ["Previous Rank", player.previous_rank ? `#${player.previous_rank}` : "Pending"],
    ["Trend", rankTrendText(player)],
    ["Next Catalyst", onDeckCatalyst(player)],
    ["Opportunity Score", player.opportunityScore || "Pending"],
  ]);
}

function detailList(rows) {
  return `<dl class="profile-detail-list">${rows.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value || "Pending")}</dd></div>`).join("")}</dl>`;
}

function normalizeMarketFields(player) {
  return {
    benchmark: benchmarkCard(player),
    status: marketStatusLabel(player),
    liquidity: liquidityLabel(player),
    trend: marketTrend(player),
    range: actionableRange(player),
  };
}

function normalizeMarketSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return {};
  const sellThrough30 = snapshotSellThroughPercent(snapshot.sellThruRate30d ?? snapshot.sell_thru_rate_30d);
  const sellThrough90 = snapshotSellThroughPercent(snapshot.sellThruRate90d ?? snapshot.sell_thru_rate_90d);
  return compactRow({
    player_id: snapshot.playerId ?? snapshot.player_id ?? "",
    card_code: snapshot.benchmarkCardCode ?? snapshot.benchmark_card_code ?? "",
    benchmark_card_code: snapshot.benchmarkCardCode ?? snapshot.benchmark_card_code ?? "",
    card_name: "Bowman Chrome Auto",
    card_query: snapshot.canonicalQuery ?? snapshot.canonical_query ?? "",
    canonical_query: snapshot.canonicalQuery ?? snapshot.canonical_query ?? "",
    last_sale: snapshot.lastSoldPrice ?? snapshot.last_sold_price ?? "",
    avg_30: snapshot.avgSoldPrice30d ?? snapshot.avg_sold_price_30d ?? "",
    avg_90: snapshot.avgSoldPrice90d ?? snapshot.avg_sold_price_90d ?? "",
    sales_30: snapshot.salesCount30d ?? snapshot.sales_count_30d ?? "",
    sales_90: snapshot.salesCount90d ?? snapshot.sales_count_90d ?? "",
    active_listings: snapshot.activeListingCount ?? snapshot.active_listing_count ?? "",
    sell_through_30: Number.isFinite(sellThrough30) ? sellThrough30 : "",
    sell_through_90: Number.isFinite(sellThrough90) ? sellThrough90 : "",
    card_year: snapshot.cardYear ?? snapshot.card_year ?? "",
  });
}

function benchmarkCard(player) {
  const year = firstValue(player.card_year, player.year, "");
  const code = firstValue(player.card_code, player.auto_code, "");
  return [year, "Bowman Chrome Auto", code].filter(Boolean).join(" · ") || "Bowman Chrome Auto";
}

function marketStatusLabel(player) {
  const loaded = firstValue(player.market_status, player.market_signal, player.recommendation, "");
  const lower = String(loaded).toLowerCase();
  const avg30 = numericMoney(firstValue(player.avg_30, player.avgSoldPrice30d, ""));
  const avg90 = numericMoney(firstValue(player.avg_90, player.avgSoldPrice90d, ""));
  const sales30 = Number(firstValue(player.sales_30, player.salesCount30d, ""));
  const sales90 = Number(firstValue(player.sales_90, player.salesCount90d, ""));
  if (lower.includes("avoid") || lower.includes("spiked") || lower.includes("priced")) return "Avoid Chase";
  if (lower.includes("strong")) return "Strong Buy";
  if (lower.includes("buy")) return "Buy Zone";
  if (Number.isFinite(sales90) && sales90 <= 0) return "No Liquidity";
  if (!Number.isFinite(avg30) && !Number.isFinite(avg90)) return player.code ? "Needs Market" : "Pending";
  if (Number.isFinite(avg30) && Number.isFinite(avg90) && avg90 > 0 && avg30 > avg90 * 1.35) return "Avoid Chase";
  if (Number.isFinite(sales30) && sales30 >= 12 && marketTrend(player) === "Up") return "Buy Zone";
  if (Number.isFinite(avg30)) return "Watch";
  return "Research";
}

function liquidityLabel(player) {
  const value = sellThroughValue(player, 30);
  if (Number.isFinite(value)) {
    if (value >= 70) return "Strong";
    if (value >= 50) return "Good";
    if (value >= 30) return "Moderate";
    if (value > 0) return "Thin";
    return "No Liquidity";
  }
  const sales = Number(firstValue(player.sales_30, player.salesCount30d, ""));
  if (Number.isFinite(sales)) {
    if (sales >= 12) return "Good";
    if (sales >= 5) return "Moderate";
    if (sales >= 1) return "Thin";
    return "No Liquidity";
  }
  return "Pending";
}

function marketTrend(player) {
  const avg30 = numericMoney(firstValue(player.avg_30, player.avgSoldPrice30d, ""));
  const avg90 = numericMoney(firstValue(player.avg_90, player.avgSoldPrice90d, ""));
  const last = numericMoney(firstValue(player.last_sale, player.lastSoldPrice, ""));
  if (Number.isFinite(last) && Number.isFinite(avg30) && avg30 > 0) {
    if (last >= avg30 * 1.08) return "Up";
    if (last <= avg30 * 0.92) return "Down";
    return "Flat";
  }
  if (Number.isFinite(avg30) && Number.isFinite(avg90) && avg90 > 0) {
    if (avg30 >= avg90 * 1.08) return "Up";
    if (avg30 <= avg90 * 0.92) return "Down";
    return "Flat";
  }
  return "Pending";
}

function actionableRange(player) {
  const low = numericMoney(player.buy_low);
  const high = numericMoney(player.buy_high);
  if (Number.isFinite(low) || Number.isFinite(high)) {
    return [low, high].filter(Number.isFinite).map(currency).join(" - ");
  }
  const avg30 = numericMoney(firstValue(player.avg_30, player.avgSoldPrice30d, ""));
  if (!Number.isFinite(avg30)) return "Pending";
  return `${currency(avg30 * 0.8)} - ${currency(avg30 * 0.94)}`;
}

function hasMarketData(player) {
  return [player.avg_30, player.avg_90, player.last_sale, player.sales_30, player.sales_90].some((value) => value !== "" && value != null);
}

function compactStatLine(player) {
  if (isPitcher(player.position)) {
    const era = eraValue(firstValue(player.pitcher_era, player.era, ""));
    const whip = statValue(firstValue(player.pitcher_whip, player.whip, ""));
    if (era !== "-" || whip !== "-") return `${era} ERA, ${whip} WHIP`;
    return "";
  }
  const avg = statValue(firstValue(player.hitter_avg, player.avg, ""));
  const ops = statValue(firstValue(player.hitter_ops, player.ops, ""));
  if (avg !== "-" || ops !== "-") return `${avg} AVG, ${ops} OPS`;
  return "";
}

function trendSentence(player) {
  if (isPitcher(player.position)) {
    const recent = firstWindow(player, [["last_14_era", 14], ["last_30_era", 30], ["last_60_era", 60]]);
    const season = Number(firstValue(player.pitcher_era, player.era, ""));
    if (!recent) return compactStatLine(player) ? `Recent ERA splits are pending; season baseline is ${compactStatLine(player)}.` : "Current pitching trend data is pending.";
    if (Number.isFinite(season)) {
      if (recent.value <= season - 0.35) return `${eraValue(recent.value)} ERA over the last ${recent.days} days is better than season baseline. Run prevention is trending up.`;
      if (recent.value >= season + 0.35) return `${eraValue(recent.value)} ERA over the last ${recent.days} days is worse than season baseline. Run prevention is trending down.`;
    }
    return `${eraValue(recent.value)} ERA over the last ${recent.days} days is the current trend marker.`;
  }
  const recent = firstWindow(player, [["last_14_ops", 14], ["last_30_ops", 30], ["last_60_ops", 60]]);
  const season = Number(firstValue(player.hitter_ops, player.ops, ""));
  if (!recent) return compactStatLine(player) ? `Recent OPS splits are pending; season baseline is ${compactStatLine(player)}.` : "Current hitting trend data is pending.";
  if (Number.isFinite(season)) {
    if (recent.value >= season + 0.05) return `${statValue(recent.value)} OPS over the last ${recent.days} days is above season baseline. Bat is trending up.`;
    if (recent.value <= season - 0.05) return `${statValue(recent.value)} OPS over the last ${recent.days} days is below season baseline. Bat is trending down.`;
  }
  return `${statValue(recent.value)} OPS over the last ${recent.days} days is the current trend marker.`;
}

function strongRecentForm(player) {
  const recent = isPitcher(player.position)
    ? firstWindow(player, [["last_14_era", 14], ["last_30_era", 30]])
    : firstWindow(player, [["last_14_ops", 14], ["last_30_ops", 30]]);
  const season = Number(isPitcher(player.position) ? firstValue(player.pitcher_era, player.era, "") : firstValue(player.hitter_ops, player.ops, ""));
  if (!recent || !Number.isFinite(season)) return false;
  return isPitcher(player.position) ? recent.value <= season - 0.35 : recent.value >= season + 0.05;
}

function firstWindow(player, fields) {
  for (const [field, days] of fields) {
    const value = Number(player[field]);
    if (player[field] !== "" && player[field] != null && Number.isFinite(value)) return { value, days };
  }
  return null;
}

function onDeckCatalyst(player) {
  const level = String(player.level ?? player.current_level ?? "").toUpperCase();
  if (level === "MLB") return "MLB Debut Follow-Up";
  if (level === "AAA") return "MLB Debut";
  if (level === "AA") return "Triple-A Promotion";
  if (level === "A+" || level === "A") return "Double-A Promotion";
  if (player.type === "emerging") return "Emerging Watch";
  if (rankMovement(player) > 0) return "Top 100 Momentum";
  return "Breakout Watch";
}

function rankTrendText(player) {
  const movement = rankMovement(player);
  if (movement == null) return "Untracked";
  if (movement > 0) return `Up ${movement}`;
  if (movement < 0) return `Down ${Math.abs(movement)}`;
  return "Flat";
}

function rankMovement(player) {
  const previous = Number(player.previous_rank);
  const current = Number(firstValue(player.prospect_rank, player.rank, ""));
  if (!Number.isFinite(previous) || !Number.isFinite(current)) return null;
  return previous - current;
}

function splitHeightWeight(value) {
  const [height = "", weight = ""] = String(value || "").split("/");
  return { height: height.trim(), weight: weight.trim().replace(/\s*lbs?\.?/i, "") };
}

function fallbackCardCode(name) {
  const initials = String(name || "Player")
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word[0])
    .join("")
    .toUpperCase()
    .slice(0, 3);
  return `CPA-${initials || "ODP"}`;
}

function backHref(type) {
  if (type === "emerging") return "./emerging.html";
  if (type === "top100") return "./top100.html";
  return "./index.html#on-deck";
}

function backLabel(type) {
  if (type === "emerging") return "Emerging";
  if (type === "top100") return "Top 100";
  return "On Deck Board";
}

function renderError(message) {
  root.innerHTML = `
    <section class="profile-card-page">
      <div class="profile-error">
        <h1>Briefing unavailable</h1>
        <p>${escapeHtml(message)}</p>
        <a class="button primary" href="./index.html">Back to On Deck</a>
      </div>
    </section>
  `;
}

function firstValue(...values) {
  for (const value of values) {
    if (value !== "" && value != null) return value;
  }
  return "";
}

function handedness(value) {
  const text = String(value || "");
  if (text === "R") return "Right";
  if (text === "L") return "Left";
  if (text === "S") return "Switch";
  return text;
}

function countValue(value) {
  if (value === "" || value == null) return "-";
  const numeric = Number(value);
  return Number.isFinite(numeric) ? String(Math.round(numeric)) : String(value);
}

function statValue(value) {
  if (value === "" || value == null) return "-";
  const numeric = Number(value);
  if (Number.isFinite(numeric) && Math.abs(numeric) < 2) return numeric.toFixed(3).replace(/^0/, "");
  return Number.isFinite(numeric) ? String(numeric) : String(value);
}

function eraValue(value) {
  if (value === "" || value == null) return "-";
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric.toFixed(2) : String(value);
}

function percentStat(value) {
  if (value === "" || value == null) return "-";
  const numeric = Number(String(value).replaceAll(/[^0-9.-]/g, ""));
  if (!Number.isFinite(numeric)) return String(value);
  return `${numeric.toFixed(numeric % 1 === 0 ? 0 : 1)}%`;
}

function currency(value) {
  const numeric = numericMoney(value);
  if (!Number.isFinite(numeric)) return "-";
  return `$${numeric.toFixed(numeric >= 100 ? 0 : 2)}`;
}

function numericMoney(value) {
  const numeric = Number(String(value ?? "").replaceAll(/[^0-9.-]/g, ""));
  return Number.isFinite(numeric) ? numeric : NaN;
}

function sellThroughValue(player, days = 30) {
  const value = days === 90 ? player.sell_through_90 : player.sell_through_30;
  const numeric = Number(String(value ?? "").replaceAll(/[^0-9.-]/g, ""));
  return Number.isFinite(numeric) ? numeric : NaN;
}

function snapshotSellThroughPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return NaN;
  return numeric <= 1 ? numeric * 100 : numeric;
}

function isPitcher(position) {
  return String(position || "").toUpperCase().includes("P");
}

function isCalledUp(player) {
  return String(player.level ?? player.current_level ?? "").toUpperCase() === "MLB"
    || String(player.called_up ?? "").toLowerCase() === "true"
    || Boolean(player.mlb_debut_date);
}

function normalizeName(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replaceAll(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, " ")
    .trim();
}

function compactRow(row) {
  return Object.fromEntries(Object.entries(row).filter(([, value]) => value !== "" && value != null));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
