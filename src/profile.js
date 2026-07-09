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
    renderProfile(normalizePlayerProfile(player, profileType));
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
  const savedInsight = await loadSavedInsight(player.player_id);
  return {
    ...player,
    ...(cachedMarkets.get(String(player.player_id)) || {}),
    ...savedInsight,
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

async function loadSavedInsight(id) {
  try {
    const response = await fetch(`/api/player-insight?player_id=${encodeURIComponent(String(id))}`, { headers: { Accept: "application/json" } });
    if (!response.ok) return {};
    const data = await response.json();
    return data.insight || {};
  } catch {
    return {};
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

function normalizePlayerProfile(row, boardType) {
  const physical = splitHeightWeight(row.height_weight || "");
  const name = cleanValue(firstValue(row.player_name, row.name, "Player"));
  const rank = cleanValue(firstValue(row.prospect_rank, row.rank, ""));
  const cardCode = cleanValue(validCardCode(row, boardType));
  const player = {
    id: cleanValue(firstValue(row.player_id, row.playerId, row.id, "")),
    mlbamId: cleanValue(firstValue(row.mlbam_id, row.mlbamId, row.mlbam, "")),
    name,
    organization: cleanValue(firstValue(row.org, row.current_org, row.team_on_card, row.team, "Org pending")),
    position: cleanValue(firstValue(row.position, row.pos, row.stats_role, "Position pending")),
    level: cleanValue(firstValue(row.level, row.current_level, row.stat_level, "Level pending")),
    age: cleanValue(firstValue(row.age, "")),
    height: cleanValue(firstValue(row.height, physical.height, "")),
    weight: cleanValue(firstValue(row.weight, physical.weight, "")),
    bats: cleanValue(firstValue(row.bats, "")),
    throws: cleanValue(firstValue(row.throws, "")),
    eta: cleanValue(firstValue(row.eta, "")),
    rank,
    cardCode,
  };
  const score = normalizeScore(row, boardType);
  const stats = normalizeStats(row, player.position);
  const market = {
    benchmarkCard: benchmarkCard({ ...row, card_code: cardCode }),
    marketStatus: getMarketStatus(row),
    liquidity: getLiquidity(row),
    trend: getTrend(row),
    actionableRange: getActionableRange(row),
  };
  return {
    boardType,
    player,
    score,
    briefing: {
      title: briefingTitleText(boardType),
      resume: resumeText(row, player, score),
      signals: signalsText(row, player),
      edgeWhy: whyMatters(row, player, boardType),
      edgeRisk: mainRisk(row),
    },
    stats,
    market,
    details: {
      cardRows: cardDetailRows(row, player),
      statsRows: stats.columns.map((column) => [column, stats.rows[0]?.[column] || "Pending"]),
      movementRows: movementDetailRows(row, player, score),
      trendSentence: trendSentence(row),
    },
  };
}

function normalizeScore(row, boardType) {
  const rawScore = boardType === "emerging"
    ? firstValue(row.opportunity_score, row.emerging_pre_score, row.recommendation_total_score, "")
    : boardType === "top100"
      ? firstValue(row.opportunity_score, rankPlaceholderScore(row), "")
      : firstValue(row.opportunity_score, row.move_score, row.callup_score, "");
  const opportunityScore = numberLabel(rawScore);
  const investmentScore = profileInvestmentScore(row, rawScore);
  const moonshot = profileMoonshotRating(row, rawScore);
  let action = cleanValue(firstValue(row.final_action, row.action, row.recommendation, row.market_action, ""));
  if (!action) {
    if (boardType === "emerging") action = hasValidSoldData(row) ? getMarketStatus(row) : "Market Review Pending";
    else action = getMarketStatus(row) === "Pending" ? "Pending" : getMarketStatus(row);
  }
  let status = "Watch";
  if (boardType === "top100") status = "Top 100";
  else if (boardType === "emerging") status = cleanValue(firstValue(row.tier_label, row.priority_tier, row.pre_tier, row.status, "Emerging"));
  else if (hasValidSoldData(row)) status = "On Deck";
  else status = "Needs Market";
  return {
    opportunityScore,
    investmentScore,
    moonshot,
    action: cleanValue(action || "Pending"),
    status: cleanValue(status),
  };
}

function profileInvestmentScore(row, rawMoveScore) {
  const direct = firstValue(row.investment_score, row.market_opportunity_score, row.marketOpportunityScore, row.on_deck_opportunity_score, "");
  if (direct !== "") return numberLabel(direct);
  const move = Number(rawMoveScore);
  const sales30 = Number(firstValue(row.sales_30, row.salesCount30d, row.sales_count_30d, row.market_sales_count_30d, ""));
  const sales90 = Number(firstValue(row.sales_90, row.salesCount90d, row.sales_count_90d, row.market_sales_count_90d, ""));
  const avg30 = numericMoney(firstValue(row.avg_30, row.avgSoldPrice30d, row.avg_sold_price_30d, row.market_avg_price_30d, ""));
  const avg90 = numericMoney(firstValue(row.avg_90, row.avgSoldPrice90d, row.avg_sold_price_90d, row.market_avg_price_90d, ""));
  const volume = Math.min(100, Math.max(Number.isFinite(sales30) ? sales30 * 4 : 0, Number.isFinite(sales90) ? sales90 * 1.3 : 0));
  const priceDiscipline = Number.isFinite(avg30) && Number.isFinite(avg90) && avg90 > 0
    ? clampScore(72 - Math.max(0, ((avg30 - avg90) / avg90) * 100 - 18))
    : 58;
  const score = (Number.isFinite(move) ? move : 50) * 0.48 + volume * 0.32 + priceDiscipline * 0.20;
  return numberLabel(clampScore(score));
}

function profileMoonshotRating(row, rawMoveScore) {
  const direct = Number(firstValue(row.moonshot_rating, row.moonshot, ""));
  if (Number.isFinite(direct) && direct > 0) return "★".repeat(Math.min(5, Math.round(direct)));
  const move = Number(rawMoveScore);
  const age = Number(firstValue(row.age, ""));
  const rank = Number(firstValue(row.prospect_rank, row.rank, ""));
  const level = String(firstValue(row.level, row.current_level, "")).toUpperCase();
  const price = numericMoney(firstValue(row.avg_30, row.avgSoldPrice30d, row.avg_sold_price_30d, row.avg_price_30d, row.market_avg_price_30d, row.last_sale, row.market_last_sold_price, ""));
  const levelBoost = { AAA: 12, AA: 14, "A+": 10, A: 8, ROK: 7, RK: 7 }[level] || 5;
  const ageBoost = Number.isFinite(age) ? Math.max(0, 24 - age) * 3 : 6;
  const rankBoost = Number.isFinite(rank) && rank > 0 ? Math.max(0, 105 - rank) / 4 : 8;
  const ceiling = (Number.isFinite(move) ? move : 50) + levelBoost + ageBoost + rankBoost;
  const priceLeverage = !Number.isFinite(price) || price <= 0
    ? -10
    : price <= 20
      ? 18
      : price <= 60
        ? 9
        : price <= 150
          ? 0
          : price <= 300
            ? -18
            : -30;
  const upside = clampScore((ceiling - 82) * 1.8 + priceLeverage);
  let rating = 1;
  if (!Number.isFinite(price) || price <= 0) {
    rating = upside >= 80 ? 3 : upside >= 58 ? 2 : 1;
  } else if (price <= 20) {
    rating = upside >= 72 ? 5 : upside >= 54 ? 4 : upside >= 36 ? 3 : upside >= 22 ? 2 : 1;
  } else if (price <= 60) {
    rating = upside >= 90 ? 5 : upside >= 66 ? 4 : upside >= 44 ? 3 : upside >= 28 ? 2 : 1;
  } else if (price <= 150) {
    rating = upside >= 84 ? 4 : upside >= 58 ? 3 : upside >= 36 ? 2 : 1;
  } else if (price <= 300) {
    rating = upside >= 76 ? 2 : 1;
  } else {
    rating = upside >= 90 ? 2 : 1;
  }
  return "★".repeat(rating);
}

function rankPlaceholderScore(row) {
  const rank = Number(firstValue(row.prospect_rank, row.rank, ""));
  if (!Number.isFinite(rank)) return "";
  return Math.max(0, Math.min(100, 101 - rank));
}

function normalizeStats(row, position) {
  const pitcher = isPitcher(position);
  const recordTitle = pitcher ? "2026 Minor League Pitching Record" : "2026 Minor League Batting Record";
  const cells = pitcher ? pitchingColumns(row) : hittingColumns(row);
  const columns = cells.map((cell) => cell.label);
  const values = Object.fromEntries(cells.map((cell) => [cell.label, safeDisplay(cell.value)]));
  return {
    role: pitcher ? "Pitcher" : "Hitter",
    recordTitle,
    columns,
    rows: [values, { ...values, YR: "TOTALS" }],
  };
}

function renderProfile(profile) {
  document.title = `OnDeck Prospect | ${profile.player.name}`;
  root.innerHTML = `
    <section class="profile-card-page">
      <nav class="profile-back-nav" aria-label="Profile navigation">
        <a href="${escapeHtml(backHref(profile.boardType))}">Back to ${escapeHtml(backLabel(profile.boardType))}</a>
      </nav>
      <article class="odp-card-shell" aria-label="On Deck briefing for ${escapeHtml(profile.player.name)}">
        <div class="odp-card-frame">
          <div class="odp-card-inner">
            ${profileHeader(profile)}
            ${briefingTitle(profile)}
            ${briefingSections(profile)}
            ${recordTable(profile)}
            ${marketSnapshot(profile)}
          </div>
        </div>
      </article>
      ${profileDetails(profile)}
    </section>
  `;
}

function profileHeader(profile) {
  const player = profile.player;
  return `
    <header class="odp-card-header">
      ${profileHeadshotMarkup(player)}
      <div class="odp-nameplate">
        <h1>${escapeHtml(player.name)}</h1>
        <p>${escapeHtml(player.organization)} · ${escapeHtml(player.position)} · ${escapeHtml(player.level)}</p>
      </div>
      <div class="odp-code-block">
        <span>${escapeHtml(player.cardCode)}</span>
      </div>
    </header>
    <div class="odp-bio-line">
      ${bioSegments(profile).map(([label, value]) => `<span><b>${escapeHtml(label)}:</b> ${escapeHtml(value)}</span>`).join("")}
    </div>
  `;
}

function profileHeadshotMarkup(player) {
  const url = playerHeadshotUrl(player);
  const initials = playerInitials(player.name);
  if (!url) return `<span class="player-headshot player-headshot-profile player-headshot-fallback" aria-hidden="true">${escapeHtml(initials)}</span>`;
  return `<img class="player-headshot player-headshot-profile" src="${escapeHtml(url)}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'player-headshot player-headshot-profile player-headshot-fallback',textContent:'${escapeHtml(initials)}'}))" />`;
}

function playerHeadshotUrl(player) {
  const id = player.mlbamId;
  if (!id || !/^\d+$/.test(String(id))) return "";
  return `https://img.mlbstatic.com/mlb-photos/image/upload/w_220,q_auto:best/v1/people/${encodeURIComponent(String(id))}/headshot/67/current`;
}

function playerInitials(name) {
  return String(name || "OP")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || "")
    .join("") || "OP";
}

function bioSegments(profile) {
  const player = profile.player;
  return [
    ["Age", player.age],
    ["HT", player.height],
    ["WT", player.weight],
    ["Bats", handedness(player.bats)],
    ["Throws", handedness(player.throws)],
    ["ETA", player.eta],
    ["Rank", player.rank ? `#${player.rank}` : ""],
    ["Move Score", profile.score.opportunityScore],
    ["Investment Score", profile.score.investmentScore],
    ["Moonshot", profile.score.moonshot],
  ].filter(([, value]) => value !== "" && value != null);
}

function briefingTitle(profile) {
  return `<h2 class="odp-briefing-title"><span>---- ${escapeHtml(profile.briefing.title)} ----</span></h2>`;
}

function briefingSections(profile) {
  return `
    <section class="odp-briefing-copy">
      ${briefingBlock("Resume", profile.briefing.resume)}
      ${briefingBlock("Signals", profile.briefing.signals)}
      <div class="odp-briefing-block">
        <h3>Edge:</h3>
        <p><strong>Why This Matters:</strong> ${escapeHtml(profile.briefing.edgeWhy)}</p>
        <p><strong>Main Risk:</strong> ${escapeHtml(profile.briefing.edgeRisk)}</p>
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

function briefingTitleText(boardType) {
  if (boardType === "top100") return "TOP 100 MARKET SNAPSHOT";
  if (boardType === "emerging") return "EMERGING PROSPECT BRIEFING";
  return "ON DECK BRIEFING";
}

function resumeText(raw, player, score) {
  const loaded = firstValue(raw.thesis, raw.resume, raw.resume_summary, raw.recommendation_thesis, raw.pre_score_notes, "");
  if (loaded && !isGenericEmergingCopy(loaded)) return loaded;
  if (raw.source_type === "emerging" || raw.board_type === "emerging") return emergingResumeText(raw, player, score);
  const scoreText = score.opportunityScore !== "—" ? `${score.opportunityScore} opportunity score` : "opportunity score pending";
  const rank = player.rank ? ` ranked #${player.rank}` : "";
  const stat = compactStatLine(raw);
  return `${player.name} is a ${player.position} in the ${player.organization} system${rank}, currently at ${player.level}, with ${scoreText}. ${stat || "Briefing pending latest refresh."}`;
}

function signalsText(raw, player) {
  if (raw.why_now && !isGenericEmergingCopy(raw.why_now)) return raw.why_now;
  if (raw.signals && !isGenericEmergingCopy(raw.signals)) return raw.signals;
  if (raw.source_type === "emerging" || raw.board_type === "emerging") return emergingSignalsText(raw, player);
  const signals = [];
  signals.push(onDeckCatalyst(raw));
  const movement = rankTrendText(raw);
  if (movement !== "Untracked") signals.push(movement.startsWith("Up") ? "Rank Riser" : movement.startsWith("Down") ? "Rank Risk" : "Rank Stable");
  if (strongRecentForm(raw)) signals.push("Strong Stats Signal");
  else if (compactStatLine(raw)) signals.push("Stats Loaded");
  const status = getMarketStatus(raw);
  if (status !== "Pending" && status !== "Needs Market") signals.push("Card Market Confirmed");
  if (raw.on_deck_rank) signals.push(`On Deck #${raw.on_deck_rank}`);
  if (player.rank && !signals.some((signal) => signal.includes("Rank"))) signals.push(`Rank #${player.rank}`);
  return signals.length ? signals.join(" ... ") : "Signals pending latest refresh.";
}

function whyMatters(raw, player, boardType) {
  if (raw.edge && !isGenericEmergingCopy(raw.edge)) return raw.edge;
  if (boardType === "emerging") {
    return emergingEdgeText(raw, player);
  }
  if (rankMovement(raw) > 0) {
    return `${player.name} is gaining Top 100 momentum while the next baseball catalyst is still ahead.`;
  }
  if (strongRecentForm(raw)) {
    return `Current form is improving, which can move collector attention before the next promotion headline.`;
  }
  return `The next assignment or roster decision can change how quickly the market prices this player.`;
}

function mainRisk(raw) {
  if (raw.do_not_buy_if) return raw.do_not_buy_if;
  if (raw.risk && !isGenericEmergingCopy(raw.risk)) return raw.risk;
  if (raw.source_type === "emerging" || raw.board_type === "emerging") return emergingRiskText(raw);
  if (getMarketStatus(raw) === "Avoid Chase") return "The market may already be ahead of the baseball catalyst.";
  if (rankMovement(raw) < 0) return "Top 100 movement is negative, so demand may need a stronger performance catalyst.";
  if (!hasValidSoldData(raw)) return "Card-market data is not loaded yet, so the entry read needs confirmation.";
  if (!compactStatLine(raw)) return "Current stat detail is thin until the next stats refresh.";
  return "Timing remains the key risk: the player path can be right while the market window moves first.";
}

function emergingResumeText(raw, player, score) {
  const stat = compactStatLine(raw);
  const level = player.level && player.level !== "Level pending" ? player.level : "current level";
  const scoreText = score.opportunityScore !== "—" ? `${score.opportunityScore} move score` : "move score pending";
  const market = marketReadSentence(raw);
  if (isPitcher(player.position || raw.stats_role)) {
    return `${player.name} is an Emerging arm at ${level} with ${stat || "a loaded 2026 pitching line"} and a ${scoreText}. ${market}`;
  }
  return `${player.name} is an Emerging bat at ${level} with ${stat || "a loaded 2026 hitting line"} and a ${scoreText}. ${market}`;
}

function emergingSignalsText(raw, player) {
  const parts = [];
  const level = player.level && player.level !== "Level pending" ? player.level : "";
  if (level) parts.push(`${level} assignment`);
  const stat = compactStatLine(raw);
  if (stat) parts.push(stat);
  const sales30 = countValue(firstValue(raw.sales_count_30d, raw.market_sales_count_30d, ""));
  const sales90 = countValue(firstValue(raw.sales_count_90d, raw.market_sales_count_90d, ""));
  if (sales30 !== "-") parts.push(`${sales30} sales in 30D`);
  else if (sales90 !== "-") parts.push(`${sales90} sales in 90D`);
  const avg30 = currency(firstValue(raw.avg_price_30d, raw.market_avg_price_30d, ""));
  if (avg30 !== "Pending") parts.push(`${avg30} 30D avg`);
  const trend = getTrend(raw);
  if (trend && trend !== "Pending") parts.push(`market ${trend.toLowerCase()}`);
  return parts.length ? parts.join(" ... ") : "Stats and benchmark-card market are loaded for review.";
}

function emergingEdgeText(raw, player) {
  const score = numberLabel(firstValue(raw.opportunity_score, raw.move_score, raw.emerging_pre_score, ""));
  const trend = getTrend(raw);
  const liquidity = getLiquidity(raw);
  if (trend === "Up" && liquidity !== "Pending") {
    return `${player.name} has early market activity with improving price direction before Top 100 attention is the main driver.`;
  }
  if (liquidity === "Strong" || liquidity === "Moderate") {
    return `${player.name} has enough sold volume to monitor without waiting for a ranking-list catalyst.`;
  }
  return `${player.name} is on the feeder board because the stats/market blend grades out at ${score}, but the catalyst still needs to sharpen.`;
}

function emergingRiskText(raw) {
  const levelScore = Number(firstValue(raw.level_score, ""));
  const performanceScore = Number(firstValue(raw.performance_score, ""));
  const sales30 = Number(firstValue(raw.sales_count_30d, raw.market_sales_count_30d, ""));
  if (Number.isFinite(levelScore) && levelScore < 12) return "The baseball timeline is still early, so the next assignment matters more than the current card activity.";
  if (Number.isFinite(performanceScore) && performanceScore < 45) return "The market has activity, but the performance score needs to climb before this becomes a stronger On Deck case.";
  if (!Number.isFinite(sales30) || sales30 < 6) return "Sold volume is still thin enough that one comp can distort the card read.";
  return "The risk is paying for early attention before the player earns a clearer promotion or ranking catalyst.";
}

function marketReadSentence(raw) {
  const avg30 = currency(firstValue(raw.avg_price_30d, raw.market_avg_price_30d, ""));
  const sales30 = countValue(firstValue(raw.sales_count_30d, raw.market_sales_count_30d, ""));
  if (avg30 !== "Pending" && sales30 !== "-") return `Benchmark card is trading around ${avg30} over 30D with ${sales30} sales.`;
  if (sales30 !== "-") return `Benchmark card has ${sales30} sales in the last 30D.`;
  return "Benchmark card market is loaded but still needs a cleaner read.";
}

function isGenericEmergingCopy(value) {
  return /current stats and benchmark card market data are available|combined baseball and market profile|needs continued stats and market confirmation|tracked player with stats and card-market data|hitter score from|pitcher score from/i.test(String(value || ""));
}

function recordTable(profile) {
  const { stats } = profile;
  const hasStats = stats.rows[0] && stats.columns.some((column) => column !== "YR" && stats.rows[0][column] !== "-");
  return `
    <section class="odp-record-section">
      <h3>${escapeHtml(stats.recordTitle.toUpperCase())}</h3>
      ${hasStats ? `
        <table class="odp-record-table">
          <thead><tr>${stats.columns.map((column) => `<th>${escapeHtml(column)}</th>`).join("")}</tr></thead>
          <tbody>
            ${stats.rows.map((row) => `<tr${row.YR === "TOTALS" ? " class=\"totals\"" : ""}>${stats.columns.map((column) => `<td>${escapeHtml(row[column])}</td>`).join("")}</tr>`).join("")}
          </tbody>
        </table>
        <p>${escapeHtml(profile.details.trendSentence)}</p>
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

function marketSnapshot(profile) {
  const market = profile.market;
  const items = [
    ["Benchmark Card", market.benchmarkCard],
    ["Market Status", market.marketStatus],
    ["Liquidity", market.liquidity],
    ["Trend", market.trend],
    ["Actionable Range", market.actionableRange],
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

function profileDetails(profile) {
  return `
    <section class="profile-detail-actions" aria-label="Detailed player data">
      ${detailPanel("Card Details", detailList(profile.details.cardRows))}
      ${detailPanel("Stats Details", `${detailList(profile.details.statsRows)}<p>${escapeHtml(profile.details.trendSentence)}</p>`)}
      ${detailPanel("Movement Details", detailList(profile.details.movementRows))}
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

function detailList(rows) {
  return `<dl class="profile-detail-list">${rows.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(safeDisplay(value || "Pending"))}</dd></div>`).join("")}</dl>`;
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
    source: snapshot.source ?? "",
    targetOnly: snapshot.targetOnly ?? snapshot.target_only ?? "",
  });
}

function benchmarkCard(player) {
  const year = firstValue(player.card_year, player.year, "");
  const code = firstValue(player.card_code, player.auto_code, "");
  return [year, "Bowman Chrome Auto", code].filter(Boolean).join(" · ") || "Bowman Chrome Auto";
}

function hasValidSoldData(row) {
  return positiveNumber(firstValue(row.salesCount30d, row.sales_count_30d, row.sales_30, row.market_sales_count_30d, ""))
    || positiveNumber(firstValue(row.salesCount90d, row.sales_count_90d, row.sales_90, row.market_sales_count_90d, ""));
}

function getMarketStatus(row) {
  const source = String(firstValue(row.source, row.data_source, row.market_source, "")).toLowerCase();
  const targetOnly = String(firstValue(row.targetOnly, row.target_only, "")).toLowerCase() === "true";
  if (targetOnly || source.includes("card target")) return "Needs Market";
  const loaded = firstValue(row.final_action, row.market_status, row.market_signal, row.recommendation, "");
  const lower = String(loaded).toLowerCase();
  if (lower.includes("avoid") || lower.includes("spiked") || lower.includes("priced")) return "Avoid Chase";
  if (lower.includes("strong")) return "Strong Buy";
  if (lower.includes("buy")) return "Buy Zone";
  if (lower.includes("watch")) return "Watch";
  if (lower.includes("research")) return "Research";

  const avg30 = numericMoney(firstValue(row.avg_30, row.avgSoldPrice30d, row.avg_sold_price_30d, row.avg_price_30d, row.market_avg_price_30d, ""));
  const avg90 = numericMoney(firstValue(row.avg_90, row.avgSoldPrice90d, row.avg_sold_price_90d, row.avg_price_90d, row.market_avg_price_90d, ""));
  const sales30 = Number(firstValue(row.sales_30, row.salesCount30d, row.sales_count_30d, row.market_sales_count_30d, ""));
  const sales90 = Number(firstValue(row.sales_90, row.salesCount90d, row.sales_count_90d, row.market_sales_count_90d, ""));
  if (Number.isFinite(sales30) && Number.isFinite(sales90) && sales30 <= 0 && sales90 <= 0 && !Number.isFinite(avg30) && !Number.isFinite(avg90)) return "No Liquidity";
  if (!hasValidSoldData(row)) return firstValue(row.card_code, row.auto_code, row.benchmark_card_code, row.benchmarkCardCode, "") ? "Needs Market" : "Pending";
  if (Number.isFinite(avg30) && Number.isFinite(avg90) && avg90 > 0 && avg30 > avg90 * 1.35) return "Avoid Chase";
  if (Number.isFinite(sales30) && sales30 >= 12 && getTrend(row) === "Up") return "Buy Zone";
  if (Number.isFinite(avg30)) return "Watch";
  return "Research";
}

function getLiquidity(row) {
  if (!hasValidSoldData(row)) return "Pending";
  const value = sellThroughValue(row, 30);
  if (Number.isFinite(value) && value > 0) {
    if (value >= 70) return "Strong";
    if (value >= 50) return "Good";
    if (value >= 30) return "Moderate";
    return "Thin";
  }
  const sales = Number(firstValue(row.sales_30, row.salesCount30d, row.sales_count_30d, row.market_sales_count_30d, ""));
  if (Number.isFinite(sales)) {
    if (sales >= 12) return "Good";
    if (sales >= 5) return "Moderate";
    if (sales >= 1) return "Thin";
    return "No Liquidity";
  }
  return "Pending";
}

function getTrend(row) {
  if (!hasValidSoldData(row)) return "Pending";
  const avg30 = numericMoney(firstValue(row.avg_30, row.avgSoldPrice30d, row.avg_sold_price_30d, row.avg_price_30d, row.market_avg_price_30d, ""));
  const avg90 = numericMoney(firstValue(row.avg_90, row.avgSoldPrice90d, row.avg_sold_price_90d, row.avg_price_90d, row.market_avg_price_90d, ""));
  const last = numericMoney(firstValue(row.last_sale, row.lastSoldPrice, row.last_sold_price, row.market_last_sold_price, ""));
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

function getActionableRange(row) {
  const low = numericMoney(row.buy_low);
  const high = numericMoney(row.buy_high);
  const explicitRange = [low, high].filter((value) => Number.isFinite(value) && value > 0);
  if (explicitRange.length) {
    return explicitRange.map(currency).join(" - ");
  }
  const avg30 = numericMoney(firstValue(row.avg_30, row.avgSoldPrice30d, row.avg_sold_price_30d, row.avg_price_30d, row.market_avg_price_30d, ""));
  if (!Number.isFinite(avg30) || avg30 <= 0) return "Pending";
  return `${currency(avg30 * 0.8)} - ${currency(avg30 * 0.94)}`;
}

function cardDetailRows(row, player) {
  const rows = [
    ["Card Code", player.cardCode],
    ["Query", firstValue(row.card_query, row.canonical_query, row.card_query_seed, "Pending")],
    ["Last Sale", currency(firstValue(row.last_sale, row.lastSoldPrice, row.last_sold_price, row.market_last_sold_price, ""))],
    ["30D Avg", currency(firstValue(row.avg_30, row.avgSoldPrice30d, row.avg_sold_price_30d, row.avg_price_30d, row.market_avg_price_30d, ""))],
    ["90D Avg", currency(firstValue(row.avg_90, row.avgSoldPrice90d, row.avg_sold_price_90d, row.avg_price_90d, row.market_avg_price_90d, ""))],
    ["30D Sales", countValue(firstValue(row.sales_30, row.salesCount30d, row.sales_count_30d, row.market_sales_count_30d, ""))],
    ["90D Sales", countValue(firstValue(row.sales_90, row.salesCount90d, row.sales_count_90d, row.market_sales_count_90d, ""))],
  ];
  const marketMemo = firstValue(row.market_read, row.card_market_take, "");
  if (marketMemo) {
    rows.push(["Card Market Take", marketMemo]);
  }
  if (hasValidSoldData(row)) {
    rows.push(["30D Sell-Through", percentStat(firstValue(row.sell_through_30, row.sellThruRate30d, row.sell_through_30d, row.market_sell_through_30d, ""))]);
  } else {
    rows.push(["Sell-Through", "Pending"]);
  }
  return rows;
}

function movementDetailRows(row, player, score) {
  const rows = [
    ["Current Rank", player.rank ? `#${player.rank}` : "Pending"],
    ["Previous Rank", row.previous_rank ? `#${row.previous_rank}` : "Pending"],
    ["Trend", rankTrendText(row)],
    ["Next Catalyst", firstValue(row.next_trigger, onDeckCatalyst(row))],
    ["Move Score", score.opportunityScore || "Pending"],
    ["Investment Score", score.investmentScore || "Pending"],
    ["Moonshot", score.moonshot || "Pending"],
    ["Status", score.status],
    ["Action", score.action],
    ["Confidence", row.confidence || "Pending"],
  ];
  const doNotBuyIf = firstValue(row.do_not_buy_if, row.what_would_change_my_mind, "");
  if (doNotBuyIf) {
    rows.push(["Do Not Buy If", doNotBuyIf]);
  }
  return rows;
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

function validCardCode(row, boardType) {
  const code = firstValue(row.benchmarkCardCode, row.benchmark_card_code, row.card_code, row.auto_code, row.card_number, "");
  const cleaned = cleanValue(code);
  if (/^(0|o|-|pending)$/i.test(cleaned) || cleaned.length < 3) return boardType === "emerging" ? "Card Pending" : fallbackCardCode(firstValue(row.player_name, row.name, ""));
  return cleaned;
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

function cleanValue(value, fallback = "") {
  if (value === "" || value == null) return fallback;
  const text = String(value);
  if (["undefined", "null", "nan"].includes(text.trim().toLowerCase())) return fallback;
  return text;
}

function safeDisplay(value, fallback = "Pending") {
  const cleaned = cleanValue(value, fallback);
  return cleaned === "" ? fallback : cleaned;
}

function numberLabel(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? String(Math.round(numeric)) : "—";
}

function positiveNumber(value) {
  const numeric = Number(String(value ?? "").replaceAll(/[^0-9.-]/g, ""));
  return Number.isFinite(numeric) && numeric > 0;
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

function clampScore(value) {
  return Math.max(0, Math.min(100, Number(value) || 0));
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
