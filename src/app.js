import { parseCsv, toCsv } from "./lib/csv.js";
import { mergeProspectData } from "./lib/scoring.js?v=20260626-6";

const state = {
  prospects: [],
  stats: [],
  depthCharts: [],
  cardMarket: [],
  scored: [],
  calledUp: [],
  selectedId: null,
  filters: {
    search: "",
    org: "all",
    minScore: 0,
  },
};

const TEAM_IDS = new Map([
  ["Arizona Diamondbacks", 109],
  ["Athletics", 133],
  ["Atlanta Braves", 144],
  ["Baltimore Orioles", 110],
  ["Boston Red Sox", 111],
  ["Chicago Cubs", 112],
  ["Chicago White Sox", 145],
  ["Cincinnati Reds", 113],
  ["Cleveland Guardians", 114],
  ["Colorado Rockies", 115],
  ["Detroit Tigers", 116],
  ["Houston Astros", 117],
  ["Kansas City Royals", 118],
  ["Los Angeles Angels", 108],
  ["Los Angeles Dodgers", 119],
  ["Miami Marlins", 146],
  ["Milwaukee Brewers", 158],
  ["Minnesota Twins", 142],
  ["New York Mets", 121],
  ["New York Yankees", 147],
  ["Philadelphia Phillies", 143],
  ["Pittsburgh Pirates", 134],
  ["San Diego Padres", 135],
  ["Seattle Mariners", 136],
  ["San Francisco Giants", 137],
  ["St. Louis Cardinals", 138],
  ["Tampa Bay Rays", 139],
  ["Texas Rangers", 140],
  ["Toronto Blue Jays", 141],
  ["Washington Nationals", 120],
]);

const elements = {
  loadTop100: document.querySelector("#load-top100"),
  exportCsv: document.querySelector("#export-csv"),
  search: document.querySelector("#search"),
  orgFilter: document.querySelector("#org-filter"),
  scoreFilter: document.querySelector("#score-filter"),
  scoreFilterValue: document.querySelector("#score-filter-value"),
  rows: document.querySelector("#prospect-rows"),
  playerCard: document.querySelector("#player-card"),
  totalCount: document.querySelector("#total-count"),
  calledUpCount: document.querySelector("#called-up-count"),
  alertCount: document.querySelector("#alert-count"),
  avgScore: document.querySelector("#avg-score"),
  bestOrg: document.querySelector("#best-org"),
  edgeRiser: document.querySelector("#edge-riser"),
  edgePath: document.querySelector("#edge-path"),
  edgeBreak: document.querySelector("#edge-break"),
  edgeCard: document.querySelector("#edge-card"),
  rowCount: document.querySelector("#row-count"),
  teamBoard: document.querySelector("#team-board"),
  teamBoardCount: document.querySelector("#team-board-count"),
  marketBoard: document.querySelector("#market-board"),
  marketCount: document.querySelector("#market-count"),
  edgeActions: document.querySelectorAll(".edge-card-action"),
};

elements.loadTop100.addEventListener("click", () => {
  loadTop100Prospects();
});

elements.exportCsv.addEventListener("click", () => {
  const records = getFilteredRows().map((player) => ({
    player_id: player.player_id,
    player_name: player.player_name,
    org: player.org,
    position: player.position,
    level: player.level,
    callup_score: player.callup_score,
    previous_rank: player.previous_rank ?? "",
    rank_trend: rankTrendText(player),
    performance_score: player.performance_score,
    opportunity_score: player.opportunity_score,
    readiness_score: player.readiness_score,
    card_signal: player.market_signal ?? "",
    card_last_sale: player.last_sale ?? "",
    card_last_sale_date: player.last_sale_date ?? "",
    card_avg_30: player.avg_30 ?? "",
    card_data_source: player.data_source ?? "",
    sell_through: player.sell_through ?? "",
    buy_zone: buyZone(player),
  }));
  download("prospect-callup-scores.csv", toCsv(records));
});

elements.search.addEventListener("input", (event) => {
  state.filters.search = event.target.value.trim().toLowerCase();
  state.selectedId = null;
  render();
});

elements.orgFilter.addEventListener("change", (event) => {
  state.filters.org = event.target.value;
  state.selectedId = null;
  render();
});

elements.scoreFilter.addEventListener("input", (event) => {
  state.filters.minScore = Number(event.target.value);
  elements.scoreFilterValue.textContent = event.target.value;
  state.selectedId = null;
  render();
});

elements.edgeActions.forEach((card) => {
  const activate = () => activateEdgeCard(card.dataset.edge);
  card.addEventListener("click", activate);
  card.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      activate();
    }
  });
});

refreshScoredData();

loadTop100Prospects();

async function loadTop100Prospects() {
  const response = await fetch("./data/mlb-top100-2026.csv");
  if (!response.ok) {
    throw new Error(`Could not load MLB Top 100 seed data: ${response.status}`);
  }
  state.prospects = parseCsv(await response.text());
  const [stats, savantStats, depthCharts, enrichment, news, rankHistory, cardMarket] = await Promise.all([
    loadOptionalCsv("./data/current-stats.csv?v=20260626-2"),
    loadOptionalCsv("./data/savant-stats.csv?v=20260626-1"),
    loadOptionalCsv("./data/depth-chart-current.csv"),
    loadOptionalCsv("./data/player-enrichment.csv"),
    loadOptionalCsv("./data/player-news.csv"),
    loadOptionalCsv("./data/rank-history.csv?v=20260626-full-ranks"),
    loadOptionalCsv("./data/card-market.csv?v=20260626-3"),
  ]);
  state.prospects = applyProspectEnrichment(state.prospects, mergeRowsByPlayerId(enrichment, rankHistory));
  state.stats = mergeRowsByPlayerId(stats, savantStats);
  state.depthCharts = mergeRowsByPlayerId(depthCharts, news);
  state.cardMarket = cardMarket;
  state.selectedId = null;
  state.filters.org = "all";
  refreshScoredData();
}

async function loadOptionalCsv(path) {
  const response = await fetch(path);
  if (!response.ok) {
    return [];
  }
  return parseCsv(await response.text());
}

function applyProspectEnrichment(prospects, enrichment) {
  const byId = new Map(enrichment.map((row) => [String(row.player_id), row]));
  return prospects.map((prospect) => {
    const overlay = byId.get(String(prospect.player_id));
    if (!overlay) {
      return prospect;
    }
    return {
      ...prospect,
      ...overlay,
      level: overlay.current_level || prospect.level,
      on_40man: overlay.on_40man,
    };
  });
}

function mergeRowsByPlayerId(primaryRows, overlayRows) {
  const byId = new Map(primaryRows.map((row) => [String(row.player_id), { ...row }]));
  for (const row of overlayRows) {
    const key = String(row.player_id);
    byId.set(key, mergeNonBlank(byId.get(key) ?? {}, row));
  }
  return [...byId.values()];
}

function mergeNonBlank(base, overlay) {
  const merged = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    if (value !== "" && value != null) {
      merged[key] = value;
    } else if (!(key in merged)) {
      merged[key] = value;
    }
  }
  return merged;
}

function refreshScoredData() {
  const allScored = applyCardMarket(mergeProspectData(state.prospects, state.stats, state.depthCharts)).sort((a, b) => b.callup_score - a.callup_score);
  state.calledUp = allScored.filter(isCalledUp);
  state.scored = allScored.filter((player) => !isCalledUp(player));
  if (!state.selectedId && state.scored.length) {
    state.selectedId = state.scored[0].player_id;
  }
  if (state.selectedId && !state.scored.some((player) => String(player.player_id) === String(state.selectedId))) {
    state.selectedId = state.scored[0]?.player_id ?? null;
  }
  hydrateOrgFilter();
  render();
}

function hydrateOrgFilter() {
  const current = state.filters.org;
  const orgs = [...new Set(state.scored.map((player) => player.org).filter(Boolean))].sort();
  elements.orgFilter.innerHTML = `<option value="all">All orgs</option>${orgs.map((org) => `<option value="${escapeHtml(org)}">${escapeHtml(org)}</option>`).join("")}`;
  elements.orgFilter.value = orgs.includes(current) ? current : "all";
  state.filters.org = elements.orgFilter.value;
}

function render() {
  const rows = getFilteredRows();
  renderSummary(rows);
  renderTeamBoard();
  renderMarketBoard(rows);
  renderRows(rows);
  const selected = rows.find((player) => String(player.player_id) === String(state.selectedId)) ?? rows[0];
  renderCard(selected);
}

function getFilteredRows() {
  return state.scored.filter((player) => {
    const searchBlob = `${player.player_name ?? ""} ${player.org ?? ""} ${player.position ?? ""}`.toLowerCase();
    const matchesSearch = state.filters.search === "" || searchBlob.includes(state.filters.search);
    const matchesOrg = state.filters.org === "all" || player.org === state.filters.org;
    const matchesScore = Number(player.callup_score) >= state.filters.minScore;
    return matchesSearch && matchesOrg && matchesScore;
  });
}

function renderSummary(rows) {
  elements.totalCount.textContent = state.scored.length;
  elements.calledUpCount.textContent = state.calledUp.length;
  elements.alertCount.textContent = state.scored.filter((player) => player.callup_score >= 60).length;
  elements.avgScore.textContent = state.scored.length
    ? Math.round(state.scored.reduce((sum, player) => sum + player.callup_score, 0) / state.scored.length)
    : 0;
  elements.bestOrg.textContent = bestOpportunityOrg() ?? "-";
  renderEdgeBoard();
  elements.rowCount.textContent = `${rows.length} ${rows.length === 1 ? "player" : "players"}`;
}

function renderEdgeBoard() {
  const riser = bestRankRiser();
  const path = bestPathTarget();
  const breakOrg = bestBreakExposureOrg();
  const card = bestCardResearchTarget();
  elements.edgeRiser.textContent = riser ? `${riser.player_name} +${rankMovement(riser)}` : "-";
  elements.edgePath.textContent = path ? `${path.player_name} ${path.callup_score}%` : "-";
  elements.edgeBreak.textContent = breakOrg ? `${breakOrg.name} ${breakOrg.count}` : "-";
  elements.edgeCard.textContent = card ? `${card.player_name} ${card.callup_score}%` : "-";
  setEdgeCardTarget("riser", riser?.player_id);
  setEdgeCardTarget("path", path?.player_id);
  setEdgeCardTarget("break", breakOrg?.name);
  setEdgeCardTarget("card", card?.player_id);
}

function setEdgeCardTarget(edge, value) {
  const card = [...elements.edgeActions].find((item) => item.dataset.edge === edge);
  if (!card) return;
  if (value) {
    card.dataset.target = value;
    card.removeAttribute("aria-disabled");
  } else {
    delete card.dataset.target;
    card.setAttribute("aria-disabled", "true");
  }
}

function activateEdgeCard(edge) {
  const card = [...elements.edgeActions].find((item) => item.dataset.edge === edge);
  const target = card?.dataset.target;
  if (!target) return;

  if (edge === "break") {
    state.filters.org = target;
    elements.orgFilter.value = target;
    state.selectedId = null;
  } else {
    state.filters.search = "";
    state.filters.org = "all";
    state.filters.minScore = 0;
    elements.search.value = "";
    elements.orgFilter.value = "all";
    elements.scoreFilter.value = "0";
    elements.scoreFilterValue.textContent = "0";
    state.selectedId = target;
  }

  render();
  document.querySelector("#prospects")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function applyCardMarket(players) {
  const byId = new Map(state.cardMarket.map((row) => [String(row.player_id), row]));
  return players.map((player) => ({ ...player, ...(byId.get(String(player.player_id)) ?? {}) }));
}

function renderTeamBoard() {
  const orgs = buildOrgExposure();
  elements.teamBoardCount.textContent = `${orgs.length} ${orgs.length === 1 ? "org" : "orgs"}`;
  if (!orgs.length) {
    elements.teamBoard.innerHTML = `<p class="muted">Load MLB Top 100 to view team exposure.</p>`;
    return;
  }

  elements.teamBoard.innerHTML = orgs
    .map((org) => {
      const logo = teamLogoUrl(org.name);
      const names = org.players
        .slice(0, 4)
        .map((player) => `#${player.prospect_rank} ${player.player_name}`)
        .join(", ");
      return `
        <button class="team-card" type="button" data-org="${escapeHtml(org.name)}">
          <span class="team-logo-wrap">
            ${logo ? `<img src="${escapeHtml(logo)}" alt="${escapeHtml(org.name)} logo" loading="lazy" />` : `<strong>${escapeHtml(orgInitials(org.name))}</strong>`}
          </span>
          <span class="team-card-body">
            <span class="team-card-top">
              <strong>${escapeHtml(org.name)}</strong>
              <b>${org.count}</b>
            </span>
            <span>${escapeHtml(names)}</span>
          </span>
        </button>
      `;
    })
    .join("");

  elements.teamBoard.querySelectorAll(".team-card").forEach((card) => {
    card.addEventListener("click", () => {
      state.filters.org = card.dataset.org;
      if ([...elements.orgFilter.options].some((option) => option.value === state.filters.org)) {
        elements.orgFilter.value = state.filters.org;
      }
      state.selectedId = null;
      render();
    });
  });
}

function renderMarketBoard() {
  const tracked = state.scored
    .slice()
    .sort((a, b) => b.callup_score - a.callup_score || b.opportunity_score - a.opportunity_score || Number(a.prospect_rank) - Number(b.prospect_rank))
    .slice(0, 10);
  elements.marketCount.textContent = `Top ${tracked.length}`;
  if (!tracked.length) {
    elements.marketBoard.innerHTML = `<p class="muted">Load MLB Top 100 to view the next call-up board.</p>`;
    return;
  }

  const cardMarkup = tracked
    .map((player) => callupCardMarkup(player))
    .join("");

  elements.marketBoard.innerHTML = `
    <div class="market-track">
      ${cardMarkup}
      ${tracked.length > 2 ? cardMarkup : ""}
    </div>
  `;

  elements.marketBoard.querySelectorAll(".market-card[data-player-id]").forEach((card) => {
    const activate = () => {
      state.selectedId = card.dataset.playerId;
      render();
      document.querySelector("#prospects")?.scrollIntoView({ behavior: "smooth", block: "start" });
    };
    card.addEventListener("click", activate);
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        activate();
      }
    });
  });
}

function callupCardMarkup(player) {
  const trend = rankTrendText(player);
  const trendLabel = trend === "Untracked" ? "No rank trend" : trend;
  return `
      <article class="market-card" role="button" tabindex="0" data-player-id="${escapeHtml(player.player_id)}">
        <div>
          <span class="market-label">Next-up candidate</span>
          <h3>${escapeHtml(player.player_name)}</h3>
          <p>${escapeHtml([player.org, player.level, player.position].filter(Boolean).join(" · "))}</p>
        </div>
        <div class="market-price">
          <strong>${escapeHtml(player.callup_score)}%</strong>
          <span>Call-up chance</span>
        </div>
        <dl>
          <div><dt>Stats</dt><dd>${escapeHtml(player.performance_score)}%</dd></div>
          <div><dt>Org Path</dt><dd>${escapeHtml(player.opportunity_score)}%</dd></div>
          <div><dt>Trend</dt><dd>${escapeHtml(trendLabel)}</dd></div>
        </dl>
      </article>
    `;
}

function buildOrgExposure() {
  const byOrg = new Map();
  for (const player of state.prospects) {
    if (!player.org) continue;
    const current = byOrg.get(player.org) ?? [];
    current.push(player);
    byOrg.set(player.org, current);
  }
  return [...byOrg.entries()]
    .map(([name, players]) => ({
      name,
      players: players.sort((a, b) => Number(a.prospect_rank) - Number(b.prospect_rank)),
      count: players.length,
    }))
    .sort((a, b) => b.count - a.count || Number(a.players[0]?.prospect_rank ?? 999) - Number(b.players[0]?.prospect_rank ?? 999) || a.name.localeCompare(b.name));
}

function renderRows(rows) {
  if (!rows.length) {
    elements.rows.innerHTML = `<tr><td colspan="7" class="muted">No prospects match the current filters.</td></tr>`;
    return;
  }

  elements.rows.innerHTML = rows
    .map((player) => {
      const selected = String(player.player_id) === String(state.selectedId) ? "selected" : "";
      return `
        <tr class="${selected}" data-player-id="${escapeHtml(player.player_id)}">
          <td>
            <span class="player-name">
              <strong>${escapeHtml(player.player_name)}</strong>
              <span>Rank ${escapeHtml(player.prospect_rank ?? "-")} · Age ${escapeHtml(player.age ?? "-")}</span>
            </span>
          </td>
          <td>${escapeHtml(player.org ?? "-")}</td>
          <td>${escapeHtml(player.position ?? "-")}</td>
          <td>${escapeHtml(player.level ?? "-")}</td>
          <td>${rankTrend(player)}</td>
          <td>${marketBadge(player)}</td>
          <td><span class="score-pill ${scoreClass(player.callup_score)}">${player.callup_score}%</span></td>
        </tr>
      `;
    })
    .join("");

  elements.rows.querySelectorAll("tr[data-player-id]").forEach((row) => {
    row.addEventListener("click", () => {
      state.selectedId = row.dataset.playerId;
      render();
    });
  });
}

function renderCard(player) {
  if (!player) {
    elements.playerCard.className = "player-card empty";
    elements.playerCard.innerHTML = "<p>Import prospect, stats, and depth-chart CSVs or load the sample dataset.</p>";
    return;
  }

  elements.playerCard.className = "player-card";
  elements.playerCard.innerHTML = `
    <div class="card-title">
      <div>
        <p class="card-kicker">${escapeHtml(player.org ?? "-")} · ${escapeHtml(player.level ?? "-")} · ${escapeHtml(player.position ?? "-")}</p>
        <h3>${escapeHtml(player.player_name)}</h3>
        <p class="muted">Rank ${escapeHtml(player.prospect_rank ?? "-")} · Age ${escapeHtml(player.age ?? "-")} · ETA ${escapeHtml(player.eta ?? "-")}</p>
      </div>
    <span class="score-pill ${scoreClass(player.callup_score)}">${player.callup_score}% call-up chance</span>
    </div>

    <div class="breakdown">
      ${bar("Stats", player.performance_score)}
      ${bar("Org Path", player.opportunity_score)}
      ${bar("Readiness", player.readiness_score)}
    </div>

    <h3>Market Edge</h3>
    <ul class="insight-list">
      ${player.insights.map((insight) => `<li>${escapeHtml(insight)}</li>`).join("")}
    </ul>
    ${newsPanel(player)}
    ${marketPanel(player)}
  `;
}

function marketPanel(player) {
  if (!player.market_signal) {
    return `
      <section class="card-market-panel">
        <div class="panel-heading compact">
          <h3>Card Market</h3>
          <span>Awaiting comps</span>
        </div>
        <p class="muted">No eBay CPA Chrome Prospect Auto sold-comps row is loaded yet for ${escapeHtml(player.player_name)}. Run scripts/update-ebay-comps.mjs with eBay API access to activate buy-zone analysis.</p>
      </section>
    `;
  }

  return `
    <section class="card-market-panel">
      <div class="panel-heading compact">
        <h3>Card Market</h3>
        <span>${escapeHtml(player.market_signal)}</span>
      </div>
      <div class="card-market-grid">
        <div>
          <span>Last Sale</span>
          <strong>${currency(player.last_sale)}</strong>
        </div>
        <div>
          <span>Last Sold</span>
          <strong>${escapeHtml(formatShortDate(player.last_sale_date) || "-")}</strong>
        </div>
        <div>
          <span>30D Avg</span>
          <strong>${currency(player.avg_30)}</strong>
        </div>
        <div>
          <span>Sell-through</span>
          <strong>${percent(player.sell_through)}</strong>
        </div>
        <div>
          <span>Buy Zone</span>
          <strong>${escapeHtml(buyZone(player))}</strong>
        </div>
        <div>
          <span>Source</span>
          <strong>${escapeHtml(player.data_source ?? "Manual comp")}</strong>
        </div>
      </div>
      <p class="market-source">${escapeHtml(cardDescription(player))}</p>
      <p>${escapeHtml(player.market_note ?? "")}</p>
      <div class="market-reasons">
        <h4>Why this signal</h4>
        <ul>
          ${marketReasonBullets(player).map((reason) => `<li>${escapeHtml(reason)}</li>`).join("")}
        </ul>
      </div>
      ${player.source_url ? `<a href="${escapeHtml(player.source_url)}" target="_blank" rel="noreferrer">Open eBay sold search</a>` : ""}
    </section>
  `;
}

function cardDescription(player) {
  return [player.card_name, player.card_code].filter(Boolean).join(" · ") || "Bowman 1st Auto";
}

function formatShortDate(value) {
  if (!value) return "";
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "2-digit" });
}

function marketReasonBullets(player) {
  const reasons = [];
  const last = numericMoney(player.last_sale);
  const avg30 = numericMoney(player.avg_30);
  const avg90 = numericMoney(player.avg_90);
  const movement = rankMovement(player);
  const sellThrough = player.sell_through === "" || player.sell_through == null ? NaN : Number(player.sell_through);

  if (Number.isFinite(last) && Number.isFinite(avg30) && avg30 > 0) {
    const diff = ((last - avg30) / avg30) * 100;
    if (diff < -3) {
      reasons.push(`Latest comp is ${Math.abs(Math.round(diff))}% below the 30-day average, so the entry price is discounted versus recent market.`);
    } else if (diff > 3) {
      reasons.push(`Latest comp is ${Math.round(diff)}% above the 30-day average, so this is momentum buying rather than a discount.`);
    } else {
      reasons.push("Latest comp is close to the 30-day average, which keeps the buy zone tied to recent market reality.");
    }
  }

  if (Number.isFinite(last) && Number.isFinite(avg90) && avg90 > 0) {
    const diff90 = ((last - avg90) / avg90) * 100;
    if (diff90 < -8) {
      reasons.push(`Price is still ${Math.abs(Math.round(diff90))}% under the 90-day average, leaving rebound room if the player gets a fresh catalyst.`);
    } else if (diff90 > 8) {
      reasons.push(`Price is ${Math.round(diff90)}% above the 90-day average, so some of the upside may already be priced in.`);
    }
  }

  if (Number.isFinite(sellThrough)) {
    reasons.push(`${Math.round(sellThrough)}% sell-through shows ${sellThrough >= 35 ? "healthy demand against current listings" : "demand is present but not yet urgent"}.`);
  }

  if (movement != null) {
    if (movement < 0) {
      reasons.push(`Top 100 rank is down ${Math.abs(movement)} spots, so the buy case needs the current stats and discount to outweigh ranking pressure.`);
    } else if (movement > 0) {
      reasons.push(`Top 100 rank is up ${movement} spots, adding prospect-hype momentum to the card signal.`);
    } else {
      reasons.push("Top 100 rank is flat, so the card signal leans more on price, stats, and call-up path.");
    }
  }

  reasons.push(`${player.callup_score}% call-up chance keeps the card case tied to promotion upside, not just raw card comps.`);
  return reasons;
}

function marketBadge(player) {
  if (!player.market_signal) {
    return `<span class="muted">-</span>`;
  }
  return `<span class="market-badge">${escapeHtml(player.market_signal)}</span>`;
}

function rankTrend(player) {
  const movement = rankMovement(player);
  if (movement == null) {
    return `<span class="muted">-</span>`;
  }
  if (movement > 0) {
    return `<span class="trend-up">+${movement}</span>`;
  }
  if (movement < 0) {
    return `<span class="trend-down">${movement}</span>`;
  }
  return `<span class="muted">0</span>`;
}

function rankTrendText(player) {
  const movement = rankMovement(player);
  if (movement == null) {
    return "Untracked";
  }
  if (movement > 0) return `Up ${movement}`;
  if (movement < 0) return `Down ${Math.abs(movement)}`;
  return "Flat";
}

function rankMovement(player) {
  const previous = Number(player.previous_rank);
  const current = Number(player.prospect_rank);
  if (!Number.isFinite(previous) || !Number.isFinite(current)) {
    return null;
  }
  return previous - current;
}

function newsPanel(player) {
  const note = player.news_note || fallbackProfileNote(player);
  const headline = player.news_headline || "MLB Pipeline profile";
  const source = player.news_source || "MLB Pipeline";
  const url = player.news_url || mlbProfileUrl(player) || player.source_url || "";
  const meta = [source, player.news_date].filter(Boolean).join(" · ");
  return `
    <section class="news-panel">
      <h3>Profile Notes</h3>
      <article>
        ${meta ? `<p class="news-meta">${escapeHtml(meta)}</p>` : ""}
        <h4>${escapeHtml(headline)}</h4>
        <p>${escapeHtml(note)}</p>
        ${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">Open source</a>` : ""}
      </article>
    </section>
  `;
}

function fallbackProfileNote(player) {
  const trend = rankTrendText(player);
  const trendText = trend === "Untracked" ? "rank movement is not tracked yet" : `rank trend is ${trend.toLowerCase()}`;
  const path = player.notes ? cleanShortNote(player.notes) : "the MLB path still needs more depth-chart context";
  return `${player.player_name} is a ${player.org} ${player.position} at ${player.level} with a ${player.callup_score}% call-up score; ${trendText}, and ${path}.`;
}

function cleanShortNote(note) {
  return String(note ?? "")
    .replace(/^Not currently found on the 40-man roster\.\s*/i, "")
    .replace(/^On the 40-man roster\.\s*/i, "")
    .replace(/\binjured 40-man\b/gi, "injured MLB")
    .replace(/\.$/, "");
}

function bar(label, value) {
  return `
    <div class="bar-row">
      <span>${label}</span>
      <span class="bar-track"><span class="bar-fill" style="width: ${Number(value)}%"></span></span>
      <strong>${Number(value)}%</strong>
    </div>
  `;
}

function bestOpportunityOrg() {
  if (!state.scored.length) {
    return null;
  }
  const orgScores = new Map();
  for (const player of state.scored) {
    if (!player.org) continue;
    const current = orgScores.get(player.org) ?? { total: 0, count: 0 };
    current.total += Number(player.opportunity_score);
    current.count += 1;
    orgScores.set(player.org, current);
  }
  return [...orgScores.entries()]
    .map(([org, value]) => [org, value.total / value.count])
    .sort((a, b) => b[1] - a[1])[0]?.[0];
}

function bestRankRiser() {
  return state.scored
    .filter((player) => Number.isFinite(rankMovement(player)) && rankMovement(player) > 0)
    .sort((a, b) => rankMovement(b) - rankMovement(a) || b.callup_score - a.callup_score)[0];
}

function bestPathTarget() {
  return state.scored
    .filter((player) => Number(player.callup_score) >= 50)
    .sort((a, b) => b.opportunity_score - a.opportunity_score || b.callup_score - a.callup_score)[0];
}

function bestBreakExposureOrg() {
  return buildOrgExposure()[0];
}

function bestCardResearchTarget() {
  return state.scored
    .slice()
    .sort((a, b) => b.callup_score - a.callup_score || b.opportunity_score - a.opportunity_score || Number(a.prospect_rank) - Number(b.prospect_rank))[0];
}

function marketScore(player) {
  if (!player.market_signal) return 0;
  const signal = String(player.market_signal).toLowerCase();
  const signalScore = signal.includes("strong") ? 35 : signal.includes("buy") ? 25 : signal.includes("watch") ? 12 : 5;
  const last = numericMoney(player.last_sale);
  const avg30 = numericMoney(player.avg_30);
  const discount = Number.isFinite(last) && Number.isFinite(avg30) && avg30 > 0 ? Math.max(-15, Math.min(25, ((avg30 - last) / avg30) * 100)) : 0;
  return signalScore + Number(player.sell_through || 0) * 0.7 + discount + Number(player.callup_score || 0) * 0.15;
}

function buyZone(player) {
  if (player.buy_low || player.buy_high) {
    return [player.buy_low, player.buy_high].filter(Boolean).join(" - ");
  }
  return "-";
}

function currency(value) {
  const numeric = numericMoney(value);
  if (!Number.isFinite(numeric)) return "-";
  return `$${numeric.toFixed(numeric >= 100 ? 0 : 2)}`;
}

function percent(value) {
  if (value === "" || value == null) return "-";
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "-";
  return `${Math.round(numeric)}%`;
}

function numericMoney(value) {
  const numeric = Number(String(value ?? "").replaceAll(/[^0-9.-]/g, ""));
  return Number.isFinite(numeric) ? numeric : NaN;
}

function sparkline(player) {
  const values = [player.avg_90, player.avg_30, player.avg_7, player.last_sale].map(numericMoney).filter(Number.isFinite);
  if (values.length < 2) return "";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const points = values
    .map((value, index) => {
      const x = (index / (values.length - 1)) * 100;
      const y = 42 - ((value - min) / range) * 34;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return `<svg viewBox="0 0 100 46" role="img" aria-label="Price trend"><polyline points="${points}" /></svg>`;
}

function scoreClass(score) {
  if (score >= 60) return "score-high";
  if (score >= 50) return "score-medium";
  return "score-low";
}

function teamLogoUrl(org) {
  const teamId = TEAM_IDS.get(org);
  return teamId ? `https://www.mlbstatic.com/team-logos/${teamId}.svg` : "";
}

function mlbProfileUrl(player) {
  if (!player.mlbam_id || !player.player_name) {
    return "";
  }
  return `https://www.mlb.com/milb/prospects/top100/${slugify(player.player_name)}-${player.mlbam_id}`;
}

function slugify(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replaceAll(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "");
}

function orgInitials(org) {
  return String(org ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word[0])
    .join("")
    .slice(0, 3)
    .toUpperCase();
}

function isCalledUp(player) {
  const level = String(player.level ?? "").toUpperCase();
  const calledUp = String(player.called_up ?? "").toLowerCase();
  return level === "MLB" || calledUp === "true" || Boolean(player.mlb_debut_date);
}

function download(filename, text) {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
