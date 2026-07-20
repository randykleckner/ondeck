import { parseCsv, toCsv } from "./lib/csv.js";
import { mergeProspectData } from "./lib/scoring.js?v=20260626-6";

const state = {
  prospects: [],
  stats: [],
  depthCharts: [],
  cardMarket: [],
  cardTargets: [],
  mlbPlayerFlags: [],
  scorebook: [],
  latestTop100Keys: new Set(),
  previousTop100Keys: new Set(),
  marketSnapshots: new Map(),
  liveMarketData: new Map(),
  liveMarketRequests: new Set(),
  liveMarketErrors: new Map(),
  marketHistoryData: new Map(),
  marketHistoryRequests: new Set(),
  marketHistoryErrors: new Map(),
  dynamicOnDeckRows: [],
  onDeckSource: "csv-fallback",
  allScored: [],
  scored: [],
  calledUp: [],
  graduated: [],
  selectedId: null,
  selectedOrg: null,
  activeTool: "dashboard",
  filters: {
    search: "",
    org: "all",
    minScore: 0,
  },
  top100Filters: {
    search: "",
    org: "all",
    board: "all",
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

const FIELD_POSITIONS = [
  { key: "C", label: "C", title: "Catcher" },
  { key: "1B", label: "1B", title: "First Base" },
  { key: "2B", label: "2B", title: "Second Base" },
  { key: "3B", label: "3B", title: "Third Base" },
  { key: "SS", label: "SS", title: "Shortstop" },
  { key: "OF", label: "OF", title: "Outfield" },
];

const PITCHING_POSITIONS = [
  { key: "SP", label: "SP", title: "Starting Pitching" },
  { key: "RP", label: "RP", title: "Bullpen" },
];

const WAR_ROOM_POSITIONS = [...FIELD_POSITIONS, ...PITCHING_POSITIONS];

const elements = {
  loadTop100: document.querySelector("#load-top100"),
  exportCsv: document.querySelector("#export-csv"),
  search: document.querySelector("#search"),
  orgFilter: document.querySelector("#org-filter"),
  scoreFilter: document.querySelector("#score-filter"),
  scoreFilterValue: document.querySelector("#score-filter-value"),
  dashboardSummary: document.querySelector("#dashboard-summary"),
  contentGrid: document.querySelector("#prospects"),
  rows: document.querySelector("#prospect-rows"),
  top100Rows: document.querySelector("#top100-rows"),
  top100RowCount: document.querySelector("#top100-row-count"),
  top100Search: document.querySelector("#top100-search"),
  top100OrgFilter: document.querySelector("#top100-org-filter"),
  top100BoardFilter: document.querySelector("#top100-board-filter"),
  cardPanel: document.querySelector(".card-panel"),
  playerCard: document.querySelector("#player-card"),
  rowCount: document.querySelector("#row-count"),
  teamBoard: document.querySelector("#team-board"),
  teamBoardCount: document.querySelector("#team-board-count"),
  warRoom: document.querySelector("#dugout"),
  warRoomLogo: document.querySelector("#war-room-logo"),
  warRoomTitle: document.querySelector("#war-room-title"),
  warRoomSubtitle: document.querySelector("#war-room-subtitle"),
  warRoomBoard: document.querySelector("#war-room-board"),
  marketBoard: document.querySelector("#market-board"),
  marketCount: document.querySelector("#market-count"),
  scorebookBoard: document.querySelector("#scorebook-board"),
  graduatedBoard: document.querySelector("#graduated-board"),
  deckPrev: document.querySelector("#deck-prev"),
  deckNext: document.querySelector("#deck-next"),
  navLinks: document.querySelectorAll(".main-nav a"),
  secondaryTools: document.querySelectorAll(".secondary-tool"),
};

elements.loadTop100?.addEventListener("click", () => {
  loadTop100Prospects();
});

elements.exportCsv?.addEventListener("click", () => {
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
    card_avg_7: player.avg_7 ?? "",
    card_avg_14: player.avg_14 ?? "",
    card_avg_30: player.avg_30 ?? "",
    card_grade: marketGrade(player),
    card_sales_7: player.sales_7 ?? "",
    card_sales_14: player.sales_14 ?? "",
    card_sales_30: player.sales_30 ?? "",
    card_data_source: player.data_source ?? "",
    sell_through: player.sell_through ?? "",
    buy_zone: buyZone(player),
  }));
  download("prospect-ondeck-scores.csv", toCsv(records));
});

elements.search?.addEventListener("input", (event) => {
  state.filters.search = normalizeName(event.target.value);
  state.selectedId = null;
  render();
});

elements.orgFilter?.addEventListener("change", (event) => {
  state.filters.org = event.target.value;
  state.selectedId = null;
  render();
});

elements.scoreFilter?.addEventListener("input", (event) => {
  state.filters.minScore = Number(event.target.value);
  if (elements.scoreFilterValue) elements.scoreFilterValue.textContent = event.target.value;
  state.selectedId = null;
  render();
});

elements.top100Search?.addEventListener("input", (event) => {
  state.top100Filters.search = normalizeName(event.target.value);
  render();
});

elements.top100OrgFilter?.addEventListener("change", (event) => {
  state.top100Filters.org = event.target.value;
  render();
});

elements.top100BoardFilter?.addEventListener("change", (event) => {
  state.top100Filters.board = event.target.value;
  render();
});

elements.deckPrev?.addEventListener("click", () => {
  scrollOnDeckBoard(-1);
});

elements.deckNext?.addEventListener("click", () => {
  scrollOnDeckBoard(1);
});

let deckDragState = null;

elements.marketBoard?.addEventListener("pointerdown", (event) => {
  const track = elements.marketBoard.querySelector(".market-track");
  if (!track) return;
  deckDragState = {
    pointerId: event.pointerId,
    startX: event.clientX,
    scrollLeft: elements.marketBoard.scrollLeft,
    wasDragged: false,
  };
  elements.marketBoard.setPointerCapture(event.pointerId);
  track.classList.add("is-dragging");
});

elements.marketBoard?.addEventListener("pointermove", (event) => {
  if (!deckDragState || deckDragState.pointerId !== event.pointerId) return;
  if (Math.abs(event.clientX - deckDragState.startX) > 8) {
    deckDragState.wasDragged = true;
  }
  elements.marketBoard.scrollLeft = deckDragState.scrollLeft - (event.clientX - deckDragState.startX);
});

elements.marketBoard?.addEventListener("pointerup", (event) => {
  if (!deckDragState || deckDragState.pointerId !== event.pointerId) return;
  const card = document.elementFromPoint(event.clientX, event.clientY)?.closest(".market-card[data-player-id]");
  if (card && !deckDragState.wasDragged) {
    activateMarketCard(card, event);
  }
  elements.marketBoard.querySelector(".market-track")?.classList.remove("is-dragging");
  window.setTimeout(() => {
    deckDragState = null;
  }, 0);
});

elements.marketBoard?.addEventListener("click", (event) => {
  const card = event.target.closest(".market-card[data-player-id]");
  if (!card || deckDragState?.wasDragged) return;
  activateMarketCard(card, event);
}, true);

window.addEventListener("hashchange", () => {
  syncRouteFromHash();
});

window.addEventListener("popstate", () => {
  syncRouteFromHash();
});

document.addEventListener("click", (event) => {
  if (!state.selectedId) return;
  if (event.target.closest("#player-card, #prospect-rows tr[data-player-id], #top100-rows tr[data-player-id], .market-card[data-player-id], .bubble-card[data-player-id], .graduate-card[data-player-id], .war-prospect[data-player-id], [data-open-war-room], .tool-page-nav")) {
    return;
  }
  state.selectedId = null;
  render();
});

refreshScoredData();

loadTop100Prospects();
syncRouteFromHash();

async function loadTop100Prospects() {
  setBoardLoadingStatus("Loading board data...");
  try {
    const response = await fetch("./data/mlb-top100-2026.csv?v=20260702-current");
    if (!response.ok) {
      throw new Error(`Could not load MLB Top 100 seed data: ${response.status}`);
    }
    const top100Prospects = parseCsv(await response.text()).map((player) => ({
      ...player,
      prospect_source: player.prospect_source || "MLB Top 100",
    }));
    const [orgProspects, stats, savantStats, depthCharts, enrichment, news, rankHistory, cardTargets, mlbPlayerFlags, scorebook] = await Promise.all([
      loadOptionalCsv("./data/org-prospects.csv?v=20260630-1"),
      loadOptionalCsv("./data/current-stats.csv?v=20260626-2"),
      loadOptionalCsv("./data/savant-stats.csv?v=20260626-1"),
      loadOptionalCsv("./data/depth-chart-current.csv"),
      loadOptionalCsv("./data/player-enrichment.csv"),
      loadOptionalCsv("./data/player-news.csv"),
      loadOptionalCsv("./data/rank-history.csv?v=20260702-current"),
      loadOptionalCsv("./data/card-targets.csv?v=20260706-1"),
      loadOptionalCsv("./data/mlb-player-flags.csv?v=20260629-2"),
      loadOptionalCsv("./data/archive/scorebook/scorebook.csv?v=20260720-scoreboard-1"),
    ]);
    const enrichmentRows = mergeRowsByPlayerId(enrichment, rankHistory);
    state.latestTop100Keys = buildPlayerKeySet(top100Prospects);
    state.previousTop100Keys = buildPlayerKeySet(rankHistory);
    state.prospects = mergeProspectUniverse(top100Prospects, orgProspects, enrichmentRows);
    state.prospects = applyProspectEnrichment(state.prospects, enrichmentRows);
    state.stats = mergeRowsByPlayerId(stats, savantStats);
    state.depthCharts = mergeRowsByPlayerId(depthCharts, news);
    state.cardMarket = [];
    state.cardTargets = cardTargets;
    state.mlbPlayerFlags = mlbPlayerFlags;
    state.scorebook = scorebook;
    state.selectedId = null;
    state.filters.org = "all";
    state.top100Filters.org = "all";
    refreshScoredData();
    loadCachedTop100MarketData();
    loadDynamicOnDeckBoard();
  } catch (error) {
    console.error(error);
    renderBoardLoadError();
  }
}

async function loadDynamicOnDeckBoard() {
  try {
    const response = await fetch("/api/on-deck?limit=50", { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`On Deck API unavailable (${response.status})`);
    const data = await response.json();
    const items = Array.isArray(data.items) ? data.items : Array.isArray(data.players) ? data.players : [];
    if (data.source === "d1-insights" && items.length) {
      state.dynamicOnDeckRows = items.map(normalizeOnDeckApiRow);
      state.onDeckSource = "d1-insights";
      console.info("OnDeck board source = d1-insights");
    } else {
      state.dynamicOnDeckRows = [];
      state.onDeckSource = "csv-fallback";
      console.info("OnDeck board source = csv-fallback");
    }
    render();
  } catch (error) {
    state.dynamicOnDeckRows = [];
    state.onDeckSource = "csv-fallback";
    console.info("OnDeck board source = csv-fallback", error?.message || error);
    render();
  }
}

function normalizeOnDeckApiRow(row) {
  const age = normalizedAge(row);
  return {
    ...row,
    player_id: row.player_id ?? row.playerId ?? "",
    player_name: row.player_name ?? row.playerName ?? "",
    org: row.org ?? row.team ?? "",
    position: row.position ?? "",
    level: row.level ?? "",
    age,
    prospect_rank: row.prospect_rank ?? row.rank ?? "",
    opportunity_score: row.opportunity_score ?? row.opportunityScore ?? row.moveScore ?? "",
    callup_score: row.callup_score ?? row.moveScore ?? row.opportunityScore ?? "",
    card_code: row.card_code ?? row.benchmarkCardCode ?? "",
    market_signal: row.final_action ?? row.action ?? row.marketRead ?? "",
    market_status: row.market_status ?? row.marketStatus ?? row.market_read ?? "",
    source_board: row.source_board ?? row.sourceBoard ?? row.board_type ?? "top100",
    source_badge: row.source_badge ?? row.sourceBadge ?? "",
    context: row.context ?? [row.organization ?? row.org ?? row.team, row.position, row.level].filter(Boolean).join(" · "),
    final_action: row.final_action ?? row.action ?? "",
    recommendation: row.final_action ?? row.action ?? "",
    confidence: row.confidence ?? "",
    source_type: row.source_type || "d1-insights",
  };
}

function normalizedAge(row) {
  const direct = fieldValue(row, ["age", "player_age"], "");
  const directNumber = Number(direct);
  if (Number.isFinite(directNumber) && directNumber > 0) {
    return directNumber.toFixed(directNumber % 1 === 0 ? 0 : 1);
  }
  const birthDate = fieldValue(row, ["birthDate", "birth_date", "dob", "date_of_birth"], "");
  const calculated = ageFromBirthDate(birthDate);
  return Number.isFinite(calculated) ? String(calculated) : "";
}

function ageFromBirthDate(value) {
  if (!value) return NaN;
  const born = new Date(value);
  if (Number.isNaN(born.getTime())) return NaN;
  const today = new Date();
  let age = today.getFullYear() - born.getFullYear();
  const monthDelta = today.getMonth() - born.getMonth();
  if (monthDelta < 0 || (monthDelta === 0 && today.getDate() < born.getDate())) age -= 1;
  return age > 0 && age < 60 ? age : NaN;
}

function setBoardLoadingStatus(message) {
  if (elements.dashboardSummary) elements.dashboardSummary.innerHTML = `<article><span>Status</span><strong>${escapeHtml(message)}</strong></article>`;
  if (elements.marketCount) elements.marketCount.textContent = message;
  if (elements.rowCount) elements.rowCount.textContent = message;
  if (elements.top100RowCount) elements.top100RowCount.textContent = message;
  if (elements.marketBoard) elements.marketBoard.innerHTML = `<p class="muted">${escapeHtml(message)}</p>`;
  if (elements.rows) elements.rows.innerHTML = `<tr><td colspan="6" class="muted">${escapeHtml(message)}</td></tr>`;
  if (elements.top100Rows) elements.top100Rows.innerHTML = `<tr><td colspan="6" class="muted">${escapeHtml(message)}</td></tr>`;
}

function renderBoardLoadError() {
  const message = "Error loading board data";
  if (elements.dashboardSummary) elements.dashboardSummary.innerHTML = `<article><span>Status</span><strong>${message}</strong></article>`;
  if (elements.marketCount) elements.marketCount.textContent = message;
  if (elements.rowCount) elements.rowCount.textContent = message;
  if (elements.top100RowCount) elements.top100RowCount.textContent = message;
  if (elements.marketBoard) elements.marketBoard.innerHTML = `<p class="muted">${message}</p>`;
  if (elements.rows) elements.rows.innerHTML = `<tr><td colspan="5" class="muted">${message}</td></tr>`;
  if (elements.top100Rows) elements.top100Rows.innerHTML = `<tr><td colspan="6" class="muted">${message}</td></tr>`;
}

async function loadCachedTop100MarketData() {
  try {
    const response = await fetch("/api/top100-market-data", { headers: { Accept: "application/json" } });
    if (!response.ok) return;
    const data = await response.json();
    const snapshots = Array.isArray(data.snapshots) ? data.snapshots : [];
    state.marketSnapshots = new Map(snapshots
      .map((snapshot) => normalizeMarketSnapshot(snapshot))
      .filter((snapshot) => snapshot.player_id)
      .map((snapshot) => [String(snapshot.player_id), snapshot]));
    render();
  } catch {
    state.marketSnapshots = new Map();
  }
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
      on_40man: overlay.on_40man ?? prospect.on_40man,
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

function buildPlayerKeySet(rows) {
  const keys = new Set();
  for (const row of rows) {
    playerComparisonKeys(row).forEach((key) => keys.add(key));
  }
  return keys;
}

function playerComparisonKeys(player) {
  return [
    player.player_id ? `id:${String(player.player_id)}` : "",
    player.mlbam_id ? `mlbam:${String(player.mlbam_id)}` : "",
    player.player_name ? `name:${normalizeName(player.player_name)}` : "",
  ].filter(Boolean);
}

function isMissingFromLatestTop100(player) {
  return !playerComparisonKeys(player).some((key) => state.latestTop100Keys.has(key));
}

function wasPreviouslyTop100(player) {
  if (String(player.was_top100 ?? player.previous_top100 ?? "").toLowerCase() === "true") return true;
  if (player.previous_rank) return true;
  return playerComparisonKeys(player).some((key) => state.previousTop100Keys.has(key));
}

function applyGraduationStatus(player) {
  if (isGraduated(player)) return player;
  if (!hasMlbStatus(player) || !wasPreviouslyTop100(player) || !isMissingFromLatestTop100(player)) {
    return {
      ...player,
      onTop100: !isMissingFromLatestTop100(player),
    };
  }

  return {
    ...player,
    lifecycleStatus: "Graduated",
    graduated: true,
    graduatedDate: player.graduatedDate || player.graduated_date || todayIsoDate(),
    graduated_date: player.graduated_date || player.graduatedDate || todayIsoDate(),
    onTop100: false,
    on_top100: false,
    onDeckBoard: false,
    on_deck_board: false,
    prospectWatchBoard: false,
    prospect_watch_board: false,
    timeline_event_graduated: graduationTimelineMessage(),
    timeline_events: appendTimelineEvent(player.timeline_events, graduationTimelineMessage()),
  };
}

function appendTimelineEvent(events, message) {
  const existing = String(events ?? "").trim();
  if (!existing) return message;
  return existing.includes(message) ? existing : `${existing} | ${message}`;
}

function graduationTimelineMessage() {
  return "Moved to Graduated after MLB status and removal from Top 100.";
}

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function mergeProspectUniverse(top100Prospects, orgProspects, enrichmentRows = []) {
  const byId = new Map(top100Prospects.map((player) => [String(player.player_id), player]));
  for (const player of orgProspects) {
    if (!player.player_id || !player.player_name) continue;
    const key = String(player.player_id);
    byId.set(key, {
      ...(byId.get(key) ?? {}),
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
  const allScored = applyCardTargets(mergeProspectData(state.prospects, state.stats, state.depthCharts))
    .map(applyGraduationStatus)
    .sort((a, b) => b.callup_score - a.callup_score);
  state.allScored = allScored;
  state.graduated = allScored.filter(isGraduated);
  state.calledUp = allScored.filter((player) => isCalledUp(player) && !isGraduated(player));
  state.scored = allScored.filter((player) => !isCalledUp(player) && !isGraduated(player));
  if (state.selectedId && !state.allScored.some((player) => String(player.player_id) === String(state.selectedId))) {
    state.selectedId = null;
  }
  hydrateOrgFilter();
  hydrateTop100OrgFilter();
  render();
}

function hydrateOrgFilter() {
  if (!elements.orgFilter) return;
  const current = state.filters.org;
  const orgs = [...new Set(state.scored.map((player) => player.org).filter(Boolean))].sort();
  elements.orgFilter.innerHTML = `<option value="all">All orgs</option>${orgs.map((org) => `<option value="${escapeHtml(org)}">${escapeHtml(org)}</option>`).join("")}`;
  elements.orgFilter.value = orgs.includes(current) ? current : "all";
  state.filters.org = elements.orgFilter.value;
}

function hydrateTop100OrgFilter() {
  if (!elements.top100OrgFilter) return;
  const current = state.top100Filters.org;
  const orgs = [...new Set(state.allScored.filter((player) => isTop100Prospect(player) && !isGraduated(player)).map((player) => player.org).filter(Boolean))].sort();
  elements.top100OrgFilter.innerHTML = `<option value="all">All orgs</option>${orgs.map((org) => `<option value="${escapeHtml(org)}">${escapeHtml(org)}</option>`).join("")}`;
  elements.top100OrgFilter.value = orgs.includes(current) ? current : "all";
  state.top100Filters.org = elements.top100OrgFilter.value;
}

function render() {
  const rows = getFilteredRows();
  if (state.activeTool === "break") renderTeamBoard();
  if (state.activeTool === "war") renderWarRoom();
  renderDashboardSummary();
  renderMarketBoard();
  renderRows(rows);
  renderTop100Rows();
  renderScorebook();
  renderGraduated();
  if (elements.rowCount) elements.rowCount.textContent = rows.length ? `${rows.length} On Deck` : "No approved On Deck players found";
  const selected = state.selectedId ? state.allScored.find((player) => String(player.player_id) === String(state.selectedId)) : null;
  renderCard(selected);
  syncToolVisibility();
}

function renderDashboardSummary() {
  if (!elements.dashboardSummary) return;
  elements.dashboardSummary.innerHTML = "";
}

function getTop100Rows() {
  const topIds = new Set(onDeckPlayers().map((player) => String(player.player_id)));
  const bubbleIds = new Set(bubblePlayers().map((player) => String(player.player_id)));
  return state.allScored
    .filter(isTop100Prospect)
    .filter((player) => !isGraduated(player))
    .filter(hasPublicBowmanTarget)
    .filter((player) => {
      const searchBlob = normalizeName(`${player.player_name ?? ""} ${player.org ?? ""} ${player.position ?? ""}`);
      const matchesSearch = state.top100Filters.search === "" || searchBlob.includes(state.top100Filters.search);
      const matchesOrg = state.top100Filters.org === "all" || player.org === state.top100Filters.org;
      const matchesBoard = state.top100Filters.board === "all"
        || (state.top100Filters.board === "bubble" && (topIds.has(String(player.player_id)) || bubbleIds.has(String(player.player_id))))
        || (state.top100Filters.board === "outside" && !topIds.has(String(player.player_id)));
      return matchesSearch && matchesOrg && matchesBoard;
    })
    .sort((a, b) => Number(a.prospect_rank) - Number(b.prospect_rank));
}

function hasPublicBowmanTarget(player) {
  const code = fieldValue(player, ["card_code", "benchmarkCardCode", "benchmark_card_code"], "");
  const query = fieldValue(player, ["card_query", "canonicalQuery", "canonical_query"], "");
  return isValidCardCode(code) || /bowman/i.test(query);
}

function onDeckPlayers() {
  const sortBoard = (players) => players
    .filter(isActionableOnDeckTarget)
    .sort(onDeckInvestmentSort)
    .slice(0, 10);

  if (state.dynamicOnDeckRows.length) {
    return sortBoard(state.dynamicOnDeckRows
      .map((row) => {
        const scored = state.allScored.find((player) => String(player.player_id) === String(row.player_id));
        return scored ? { ...scored, ...row } : row;
      }));
  }
  return sortBoard(state.scored.slice());
}

function isOnDeckBoardPlayer(player) {
  if (!player?.player_id) return false;
  const id = String(player.player_id);
  return onDeckPlayers().some((candidate) => String(candidate.player_id) === id);
}

function openPlayerProfile(playerId, options = {}) {
  if (!playerId) return;
  const type = options.type || "on-deck";
  window.location.href = `./player.html?type=${encodeURIComponent(type)}&id=${encodeURIComponent(String(playerId))}`;
}

function getFilteredRows() {
  return onDeckPlayers().filter((player) => {
    const searchBlob = normalizeName(`${player.player_name ?? ""} ${player.org ?? ""} ${player.position ?? ""}`);
    const matchesSearch = state.filters.search === "" || searchBlob.includes(state.filters.search);
    const matchesOrg = state.filters.org === "all" || player.org === state.filters.org;
    const matchesScore = Number(boardMoveScore(player)) >= state.filters.minScore;
    return matchesSearch && matchesOrg && matchesScore;
  });
}

function applyCardTargets(players) {
  const enabledTargets = state.cardTargets
    .filter((row) => String(row.enabled ?? "true").toLowerCase() !== "false");
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

function renderTeamBoard() {
  if (!elements.teamBoard || !elements.teamBoardCount) return;
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
    card.addEventListener("click", (event) => {
      event.stopPropagation();
      openTeamWarRoom(card.dataset.org);
      render();
      openTool("war", "#dugout");
    });
  });
}

function openTeamWarRoom(org) {
  state.selectedOrg = org;
}

function renderWarRoom() {
  if (!elements.warRoomBoard || !elements.warRoomTitle || !elements.warRoomSubtitle || !elements.warRoomLogo) return;
  const org = state.selectedOrg ?? bestBreakExposureOrg()?.name;
  if (!org) {
    elements.warRoomTitle.textContent = "Select a team";
    elements.warRoomSubtitle.textContent = "Team depth tools are not part of this public version.";
    elements.warRoomBoard.innerHTML = `<p class="muted">Team depth tools are unavailable in this public version.</p>`;
    elements.warRoomLogo.innerHTML = "";
    return;
  }

  state.selectedOrg = org;
  const players = state.scored
    .filter((player) => player.org === org)
    .sort((a, b) => b.callup_score - a.callup_score || Number(a.prospect_rank) - Number(b.prospect_rank));
  const calledUp = state.calledUp.filter((player) => player.org === org);
  const logo = teamLogoUrl(org);
  const topTarget = players[0];
  elements.warRoomLogo.innerHTML = logo ? `<img src="${escapeHtml(logo)}" alt="${escapeHtml(org)} logo" loading="lazy" />` : `<strong>${escapeHtml(orgInitials(org))}</strong>`;
  elements.warRoomTitle.textContent = org;
  elements.warRoomSubtitle.textContent = topTarget
    ? `${topTarget.player_name} is the next name to watch as ${org} sorts its depth chart.`
    : "No active prospects remain on this board.";

  if (!players.length) {
    elements.warRoomBoard.innerHTML = `<p class="muted">No active prospects are loaded for ${escapeHtml(org)} right now.</p>`;
    return;
  }

  const board = buildPositionBoard(players);
  elements.warRoomBoard.innerHTML = positionWarRoomMarkup(board, players, calledUp);
  elements.warRoomBoard.querySelectorAll(".war-prospect[data-player-id]").forEach((card) => {
    card.addEventListener("click", (event) => {
      event.stopPropagation();
      clearListFilters();
      openPlayerProfile(card.dataset.playerId);
    });
  });
  elements.warRoomBoard.querySelectorAll(".current-player-chip.has-flag").forEach((chip) => {
    chip.addEventListener("click", (event) => {
      event.stopPropagation();
      const expanded = chip.getAttribute("aria-expanded") === "true";
      elements.warRoomBoard.querySelectorAll(".current-player-chip[aria-expanded='true']").forEach((openChip) => {
        if (openChip !== chip) openChip.setAttribute("aria-expanded", "false");
      });
      chip.setAttribute("aria-expanded", String(!expanded));
    });
  });
}

function syncRouteFromHash() {
  if (location.hash === "#graduated") {
    openTool("graduated", "#graduated", false);
  } else {
    state.activeTool = "dashboard";
    syncToolVisibility();
  }
}

function openTool(tool, selector, updateHash = true) {
  state.activeTool = tool;
  syncToolVisibility();
  if (updateHash && location.hash !== selector) {
    history.pushState(null, "", selector);
  }
  document.querySelector(selector)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function syncToolVisibility() {
  document.body.dataset.view = state.activeTool;
  elements.secondaryTools.forEach((section) => {
    const active = section.dataset.tool === state.activeTool;
    section.classList.toggle("active-tool", active);
  });
  elements.navLinks.forEach((link) => {
    const route = link.dataset.route;
    const href = link.getAttribute("href");
    const active = state.activeTool === "dashboard"
      ? route === "dashboard" && (href === location.hash || (href === "#on-deck" && (!location.hash || location.hash === "#dashboard")))
      : route === state.activeTool;
    link.classList.toggle("active", active);
  });
}

function buildPositionBoard(players) {
  const byPosition = new Map(WAR_ROOM_POSITIONS.map((position) => [position.key, {
    ...position,
    players: [],
    blockers: [],
    injuries: 0,
    need: 0,
    blockerCount: 0,
    servicePressure: "low",
  }]));

  for (const player of players) {
    const key = fieldPositionKey(player.position);
    const lane = byPosition.get(key) ?? byPosition.get("OF");
    lane.players.push(player);
    blockerNames(player).forEach((name) => {
      if (!lane.blockers.includes(name)) lane.blockers.push(name);
    });
    if (String(player.injury_opening).toLowerCase() === "true") lane.injuries += 1;
    lane.need = Math.max(lane.need, Number(player.mlb_team_need) || 0);
    lane.blockerCount = Math.max(lane.blockerCount, Number(player.mlb_blockers) || lane.blockers.length);
    lane.servicePressure = servicePressureRank(player.service_time_pressure) > servicePressureRank(lane.servicePressure)
      ? player.service_time_pressure
      : lane.servicePressure;
  }

  return WAR_ROOM_POSITIONS.map((position) => {
    const lane = byPosition.get(position.key);
    lane.players.sort((a, b) => b.callup_score - a.callup_score || Number(a.prospect_rank) - Number(b.prospect_rank));
    return lane;
  });
}

function positionWarRoomMarkup(board, players, calledUp) {
  const fieldBoard = board.filter((lane) => lane.players.length && FIELD_POSITIONS.some((position) => position.key === lane.key));
  const pitchingBoard = board.filter((lane) => lane.players.length && PITCHING_POSITIONS.some((position) => position.key === lane.key));
  return `
    <div class="war-room-page">
      ${dugoutReadMarkup(players, calledUp, board)}
      ${fieldBoard.length ? `<div class="depth-chart-board" aria-label="Depth chart and next-move paths">
        <div class="depth-board-head">
          <h3>Depth Chart & Call-Up Paths</h3>
          <div class="lane-legend" aria-label="Path legend">
            <span><i class="clean"></i> Clean path</span>
            <span><i class="moderate"></i> Moderate</span>
            <span><i class="blocked"></i> Blocked</span>
          </div>
        </div>
        <div class="depth-lanes">
          ${fieldBoard.map((lane) => fieldPositionMarkup(lane)).join("")}
        </div>
      </div>` : ""}
      ${pitchingBoard.length ? `<section class="pitching-war-room bullpen-page" aria-label="Pitching bullpen">
        <div class="bullpen-heading">
          <div>
            <p class="eyebrow">The Bullpen</p>
            <h3>Next-Up Arms</h3>
          </div>
          <span>Rotation lanes / relief lanes</span>
        </div>
        <div class="pitching-lanes">
          ${pitchingBoard.map((lane) => pitchingLaneMarkup(lane)).join("")}
        </div>
      </section>` : ""}
    </div>
  `;
}

function dugoutReadMarkup(players, calledUp, board) {
  const active = board.filter((lane) => lane.players.length);
  const bestLane = active.slice().sort((a, b) => b.players[0].callup_score - a.players[0].callup_score)[0];
  const team = players[0]?.org ?? "This org";
  const calledUpText = calledUp.length ? `${calledUp.length} recent move${calledUp.length === 1 ? "" : "s"} already came off this board.` : "No completed moves are parked in this view.";
  return `
    <aside class="dugout-read">
      <div class="panel-heading compact">
        <h3>Team Path Read</h3>
        <span>${escapeHtml(team)}</span>
      </div>
      ${bestLane ? `<p><strong>${escapeHtml(bestLane.players[0].player_name)}</strong> is the clearest name to track because the current depth lane creates the next decision point. ${escapeHtml(calledUpText)}</p>` : `<p>No active prospect path is loaded for ${escapeHtml(team)} right now.</p>`}
    </aside>
  `;
}

function pitchingLaneMarkup(lane) {
  const top = lane.players[0];
  const blockers = lane.blockers.slice(0, 3);
  return `
    <article class="pitching-lane ${top ? "has-prospect" : "empty-position"}">
      <header>
        <span>${escapeHtml(lane.title)}</span>
        <strong>${escapeHtml(rosterPressure(lane))}</strong>
      </header>
      <div class="bullpen-visual">
        <div class="mound-stack">
          ${blockers.length ? blockers.slice(0, 2).map((name, index) => currentPlayerChip(name, index === 0 ? "Current arm" : `Depth ${index + 1}`)).join("") : `<span class="empty-chip">Pitching depth not loaded</span>`}
        </div>
        <div class="mound-stack prospect-mound">
          ${lane.players.length ? lane.players.slice(0, 3).map((player, index) => warProspectMarkup(player, index)).join("") : `<span class="empty-prospect">No prospect arm loaded</span>`}
        </div>
      </div>
    </article>
  `;
}

function fieldPositionMarkup(lane) {
  const top = lane.players[0];
  const blockers = lane.blockers.slice(0, 1);
  const starter = blockers[0];
  const pressure = rosterPressure(lane);
  return `
    <article class="field-position ${escapeHtml(pathClassName(pressure))} ${top ? "has-prospect" : "empty-position"}">
      <header>
        <strong>${escapeHtml(lane.label)}</strong>
        <strong>${escapeHtml(pressure)}</strong>
      </header>
      <div class="field-tile-stack">
        ${starter ? currentPlayerChip(starter, "Starter") : `<span class="empty-chip">Starter not loaded</span>`}
        ${lane.players.length ? lane.players.slice(0, 2).map((player, index) => warProspectMarkup(player, index)).join("") : `<span class="empty-prospect">No prospect path</span>`}
      </div>
      <p>${escapeHtml(laneNarrative(lane))}</p>
    </article>
  `;
}

function currentPlayerChip(name, role) {
  const flags = currentPlayerFlags(name);
  const content = `
      <span>
        <b>${escapeHtml(name)}</b>
        <em>${escapeHtml(role)}</em>
      </span>
  `;
  if (!flags.length) {
    return `<div class="current-player-chip">${content}</div>`;
  }
  return `
    <button class="current-player-chip ${flags.length ? "has-flag" : ""}" type="button" aria-expanded="false">
      ${content}
      ${flags.length ? `<i aria-label="Red flag"></i>` : ""}
        ${flags.length ? `<small>${flags.map((flag) => `<span><strong>${escapeHtml(flag.label)}:</strong> ${escapeHtml(flag.detail)}</span>`).join("")}</small>` : ""}
    </button>
  `;
}

function currentPlayerFlags(name) {
  const key = normalizeName(name);
  return state.mlbPlayerFlags
    .filter((row) => normalizeName(row.player_name) === key && row.flag_detail)
    .map((row) => ({
      label: row.flag_label || "Player note",
      detail: sourceLinkText(row),
    }));
}

function sourceLinkText(row) {
  const source = row.source_name || row.source || "";
  const date = row.updated || row.date || "";
  const suffix = [source, date].filter(Boolean).join(", ");
  return suffix ? `${row.flag_detail} (${suffix})` : row.flag_detail;
}

function normalizeName(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function warProspectMarkup(player, index = 0) {
  return `
    <button class="war-prospect" type="button" data-player-id="${escapeHtml(player.player_id)}">
      <i>${index + 1}</i>
      <span>
        <strong>#${escapeHtml(player.prospect_rank)} ${escapeHtml(player.player_name)}</strong>
        <em>${escapeHtml(player.level ?? "-")} · ${escapeHtml(player.position ?? "-")} · ETA ${escapeHtml(player.eta ?? "-")}</em>
      </span>
      <b>${escapeHtml(player.callup_score)}%</b>
      <small>${escapeHtml(isOnFortyMan(player) ? "40-man" : "needs 40-man")}</small>
    </button>
  `;
}

function pathClassName(pressure) {
  const value = normalizeName(pressure);
  if (value.includes("hot") || value.includes("need")) return "clean-path";
  if (value.includes("churn")) return "moderate-path";
  return "blocked-path";
}

function laneNarrative(lane) {
  const top = lane.players[0];
  if (!top) return "No active org prospect is mapped to this lane yet.";
  const blockerText = lane.blockers.length ? `${lane.blockers[0]} is the loaded MLB name ahead of him` : "Starter data still needs a named MLB blocker";
  const catalyst = onDeckCatalyst(top).toLowerCase();
  return `${blockerText}; ${top.player_name}'s next catalyst is ${catalyst}.`;
}

function pathRead(lane) {
  const blockerCount = lane.blockers.length || Number(lane.players[0]?.mlb_blockers) || 0;
  const needText = lane.need >= 7 ? "strong team need" : lane.need >= 4 ? "moderate team need" : "light team need";
  const injuryText = lane.injuries ? "an injury-related opening is flagged" : "no injury opening is flagged";
  return `${blockerCount} blocker${blockerCount === 1 ? "" : "s"} loaded, ${needText}, and ${injuryText}.`;
}

function rosterPressure(lane) {
  const top = lane.players[0];
  if (!top) return "No path";
  if (top.callup_score >= 60) return "Hot path";
  if (lane.injuries) return "Churn watch";
  if (lane.need >= 7) return "Need watch";
  return "Blocked";
}

function blockerNames(player) {
  const note = String(player.notes ?? "");
  const match = note.match(/MLB [^:]+:\s*([^.]*)\./i) || note.match(/pitching depth includes\s*([^.]*)\./i);
  if (!match) return [];
  return match[1].split(",").map((name) => name.trim()).filter(Boolean);
}

function depthChartGroup(position) {
  const value = String(position ?? "").toUpperCase();
  if (value.includes("P")) return "Pitching";
  if (value.includes("C")) return "Catcher";
  if (value.includes("OF")) return "Outfield";
  return "Infield";
}

function fieldPositionKey(position) {
  const value = String(position ?? "").toUpperCase();
  if (value.includes("RP") || value.includes("CP")) return "RP";
  if (value.includes("P")) return "SP";
  if (value.includes("C")) return "C";
  if (value.includes("1B")) return "1B";
  if (value.includes("2B")) return "2B";
  if (value.includes("3B")) return "3B";
  if (value.includes("SS")) return "SS";
  return "OF";
}

function positionClassName(key) {
  return {
    C: "pos-c",
    "1B": "pos-first",
    "2B": "pos-second",
    "3B": "pos-third",
    SS: "pos-short",
    OF: "pos-outfield",
  }[key] ?? "pos-outfield";
}

function servicePressureRank(value) {
  const key = String(value ?? "").toLowerCase();
  if (key === "high") return 3;
  if (key === "medium") return 2;
  if (key === "low") return 1;
  return 0;
}

function laneSort(role) {
  return { Pitching: 1, Catcher: 2, Infield: 3, Outfield: 4 }[role] ?? 9;
}

function renderMarketBoard() {
  if (!elements.marketBoard || !elements.marketCount) return;
  const tracked = onDeckPlayers().map(withLiveMarketData);
  if (!tracked.length) {
    const message = state.prospects.length ? "No On Deck players found" : "Loading board data...";
    elements.marketCount.textContent = message;
    elements.marketBoard.innerHTML = `<p class="muted">${escapeHtml(message)}</p>`;
    return;
  }
  elements.marketCount.textContent = `Top ${tracked.length}`;

  elements.marketBoard.innerHTML = `
    <div class="market-track">${summaryInsightCards(tracked).map((card) => summaryInsightCardMarkup(card)).join("")}</div>
  `;

  elements.marketBoard.querySelectorAll(".market-card[data-player-id], .bubble-card[data-player-id]").forEach((card) => {
    const activate = (event) => {
      activateMarketCard(card, event);
    };
    card.addEventListener("click", activate);
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        activate(event);
      }
    });
  });

}

function summaryInsightCards(players) {
  const priced = players
    .map((player) => ({
      player,
      price: boardCardPrice(player),
      investment: investmentScore(player),
      move: Number(boardMoveScore(player)),
      moonshot: moonshotRating(player),
      confidence: cardMarketConfidence(player),
    }))
    .filter((item) => Number.isFinite(item.price) && item.price > 0);
  const bestValue = priced
    .slice()
    .sort((a, b) => opportunityValueScore(b) - opportunityValueScore(a) || b.investment - a.investment)[0];
  const cheapest = priced
    .slice()
    .sort((a, b) => a.price - b.price || b.investment - a.investment)[0];
  const biggestMover = players
    .map((player) => ({ player, movement: investmentMovementValue(player), investment: investmentScore(player) }))
    .sort((a, b) => b.movement - a.movement || b.investment - a.investment)[0];
  const highestCeiling = players
    .slice()
    .sort((a, b) => ceilingScore(b) - ceilingScore(a))[0];
  const marketSleeping = priced
    .filter((item) => item.price <= 25)
    .sort((a, b) => b.investment - a.investment || b.moonshot - a.moonshot)[0];

  return [
    biggestMover && {
      label: "Biggest Mover",
      player: biggestMover.player,
      value: biggestMover.movement > 0 ? `+${Math.round(biggestMover.movement)}` : investmentScore(biggestMover.player),
      note: "Largest jump in Investment Score this week.",
    },
    bestValue && {
      label: "Best Value",
      player: bestValue.player,
      value: currency(bestValue.price),
      note: "Strongest Investment Score relative to card price.",
    },
    highestCeiling && {
      label: "Moonshot",
      player: highestCeiling,
      value: moonshotStars(highestCeiling),
      note: "Highest ceiling card profile on the board.",
    },
    marketSleeping && {
      label: "Market Sleeping",
      player: marketSleeping.player,
      value: currency(marketSleeping.price),
      note: "Strong score while card price remains low.",
    },
    cheapest && {
      label: "Cheapest Target",
      player: cheapest.player,
      value: currency(cheapest.price),
      note: "Lowest-priced card among qualified On Deck players.",
    },
  ].filter(Boolean);
}

function opportunityValueScore(item) {
  const priceEfficiency = item.price > 0 ? Math.min(35, item.investment / Math.sqrt(item.price)) : 0;
  return item.investment * 0.58 + priceEfficiency * 0.27 + item.confidence * 0.15;
}

function liquidityScore(player) {
  const sales30 = numericField(player, ["market_sales_count_30d", "sales_count_30d", "salesCount30d", "sales_30"]);
  const sales90 = numericField(player, ["market_sales_count_90d", "sales_count_90d", "salesCount90d", "sales_90"]);
  if (Number.isFinite(sales30) && sales30 >= 25) return 95;
  if (Number.isFinite(sales30) && sales30 >= 12) return 85;
  if (Number.isFinite(sales30) && sales30 >= 5) return 72;
  if (Number.isFinite(sales90) && sales90 >= 30) return 68;
  if (Number.isFinite(sales90) && sales90 >= 12) return 58;
  return 35;
}

function ceilingScore(player) {
  const score = Number(boardMoveScore(player));
  const age = Number(player.age);
  const level = String(player.level || "").toUpperCase();
  const rank = Number(fieldValue(player, ["prospect_rank", "rank"], ""));
  const movement = boardMovementValue(player);
  const levelBoost = level === "AAA" ? 12 : level === "AA" ? 14 : level === "A+" ? 10 : level === "A" ? 8 : 5;
  const ageBoost = Number.isFinite(age) ? Math.max(0, 24 - age) * 3 : 6;
  const rankBoost = Number.isFinite(rank) && rank > 0 ? Math.max(0, 105 - rank) / 4 : 8;
  const movementBoost = Math.max(0, movement) * 1.2;
  return (Number.isFinite(score) ? score : 0) + levelBoost + ageBoost + rankBoost + movementBoost;
}

function catalystScore(player) {
  const level = String(player.level || "").toUpperCase();
  const catalyst = onDeckCatalyst(player).toLowerCase();
  let score = 0;
  if (level === "AAA" || catalyst.includes("mlb")) score += 40;
  else if (level === "AA" || catalyst.includes("triple-a")) score += 30;
  else if (level === "A+" || level === "A") score += 18;
  if (boardMovementValue(player) > 0) score += 12;
  if (Number(player.callup_score) >= 65) score += 10;
  if (Number(player.opportunity_score) >= 85 || Number(player.move_score) >= 85) score += 8;
  return score;
}

function summaryInsightCardMarkup(card) {
  const player = card.player;
  return `
      <article class="market-card insight-card" role="button" tabindex="0" data-player-id="${escapeHtml(player.player_id)}" data-profile-type="${escapeHtml(profileTypeForSource(player))}">
        <span class="market-label">${escapeHtml(card.label)}</span>
        <h3>${escapeHtml(player.player_name)}</h3>
        <div class="market-price">
          <strong>${escapeHtml(card.value)}</strong>
          <span>${escapeHtml([player.org, player.level, player.position].filter(Boolean).join(" · "))}</span>
        </div>
        <p>${escapeHtml(card.note)}</p>
      </article>
    `;
}

function boardMovementValue(player) {
  const direct = Number(fieldValue(player, ["rank_movement", "movement", "trend"], ""));
  if (Number.isFinite(direct)) return direct;
  const movement = rankMovement(player);
  if (Number.isFinite(movement)) return movement;
  const score = Number(boardMoveScore(player));
  const previous = Number(fieldValue(player, ["previous_move_score", "previousMoveScore", "prior_move_score"], ""));
  if (Number.isFinite(score) && Number.isFinite(previous)) return score - previous;
  return 0;
}

function bubblePlayers() {
  const topIds = new Set(onDeckPlayers().map((player) => String(player.player_id)));
  return state.scored
    .filter((player) => !topIds.has(String(player.player_id)))
    .slice()
    .sort((a, b) => b.callup_score - a.callup_score || b.opportunity_score - a.opportunity_score || Number(a.prospect_rank) - Number(b.prospect_rank))
    .slice(0, 5);
}

function bubbleCardMarkup(player) {
  return `
    <button class="bubble-card" type="button" data-player-id="${escapeHtml(player.player_id)}">
      <span>${escapeHtml(player.callup_score)}%</span>
      <strong>${escapeHtml(player.player_name)}</strong>
      <em>${escapeHtml([player.org, player.level, player.position].filter(Boolean).join(" · "))}</em>
      <small>${escapeHtml(bubbleMissReason(player))}</small>
    </button>
  `;
}

function bubbleMissReason(player) {
  const topTenFloor = onDeckPlayers()[9]?.callup_score ?? 0;
  const gap = Math.max(0, topTenFloor - Number(player.callup_score));
  if (Number(player.opportunity_score) < 45) {
    return `Missed by ${gap} points: path is the drag.`;
  }
  if (Number(player.performance_score) < 60) {
    return `Missed by ${gap} points: needs more current form.`;
  }
  if (Number(player.readiness_score) < 60) {
    return `Missed by ${gap} points: timeline is less immediate.`;
  }
  return `Missed by ${gap} points: next move is close, not locked.`;
}

function activateMarketCard(card, event) {
  event?.preventDefault?.();
  event?.stopPropagation?.();
  if (!card?.dataset.playerId) return;
  clearListFilters();
  openPlayerProfile(card.dataset.playerId, { type: card.dataset.profileType || "on-deck" });
}

function scrollOnDeckBoard(direction) {
  if (!elements.marketBoard) return;
  const track = elements.marketBoard.querySelector(".market-track");
  if (!track) return;
  const firstCard = track.querySelector(".market-card");
  const distance = firstCard ? firstCard.getBoundingClientRect().width + 14 : 340;
  elements.marketBoard.scrollBy({ left: direction * distance, behavior: "smooth" });
}

function clearListFilters() {
  state.filters.search = "";
  state.filters.org = "all";
  state.filters.minScore = 0;
  if (elements.search) elements.search.value = "";
  if (elements.orgFilter) elements.orgFilter.value = "all";
  if (elements.scoreFilter) elements.scoreFilter.value = "0";
  if (elements.scoreFilterValue) elements.scoreFilterValue.textContent = "0";
}

function callupCardMarkup(player) {
  const rank = top10Rank(player);
  const moveScore = boardMoveScore(player);
  return `
      <article class="market-card" role="button" tabindex="0" data-player-id="${escapeHtml(player.player_id)}" data-profile-type="${escapeHtml(profileTypeForSource(player))}">
        <div>
          <span class="market-label">#${escapeHtml(rank)}</span>
          <h3>${escapeHtml(player.player_name)}</h3>
          <p>${escapeHtml([player.org, player.level, player.position].filter(Boolean).join(" · "))}</p>
        </div>
        <div class="market-price">
          <strong>${escapeHtml(moveScore)}</strong>
          <span>Move Score</span>
        </div>
        <dl>
          <div><dt>Card</dt><dd>${escapeHtml(cardBaselineLabel(player))}</dd></div>
          <div><dt>Entry</dt><dd>${escapeHtml(entryLabel(player))}</dd></div>
          <div><dt>Thesis</dt><dd>${escapeHtml(onDeckQuickThesis(player))}</dd></div>
        </dl>
      </article>
    `;
}

function boardMoveScore(player) {
  const value = fieldValue(player, ["move_score", "opportunity_score", "emerging_pre_score", "pre_score", "callup_score"], "");
  const numeric = Number(value);
  return Number.isFinite(numeric) ? String(Math.round(numeric)) : "-";
}

function investmentScore(player) {
  const direct = numericField(player, [
    "investment_score",
    "market_opportunity_score",
    "marketOpportunityScore",
    "on_deck_opportunity_score",
  ]);
  if (Number.isFinite(direct) && direct > 0) return Math.round(clampScore(direct));

  const move = Number(boardMoveScore(player));
  const moveSignal = Number.isFinite(move) ? move : 50;
  const market = cardMarketConfidence(player);
  const discipline = priceDisciplineScore(player);
  const catalyst = catalystScore(player);
  const ceiling = Math.min(100, ceilingScore(player) * 0.78);
  const performance = performanceTrendScore(player);
  return Math.round(clampScore(
    moveSignal * 0.28
    + market * 0.24
    + ceiling * 0.18
    + performance * 0.14
    + catalyst * 0.10
    + discipline * 0.06,
  ));
}

function onDeckInvestmentSort(a, b) {
  return investmentScore(b) - investmentScore(a)
    || moonshotRating(b) - moonshotRating(a)
    || Number(boardMoveScore(b)) - Number(boardMoveScore(a))
    || cardMarketConfidence(b) - cardMarketConfidence(a)
    || String(a.player_name || "").localeCompare(String(b.player_name || ""));
}

function moonshotRating(player) {
  const price = boardCardPrice(player);
  const upside = moonshotUpsideScore(player);
  if (!Number.isFinite(price) || price <= 0) {
    return upside >= 80 ? 3 : upside >= 58 ? 2 : 1;
  }
  if (price <= 20) {
    if (upside >= 72) return 5;
    if (upside >= 54) return 4;
    if (upside >= 36) return 3;
    if (upside >= 22) return 2;
    return 1;
  }
  if (price <= 60) {
    if (upside >= 90) return 5;
    if (upside >= 66) return 4;
    if (upside >= 44) return 3;
    if (upside >= 28) return 2;
    return 1;
  }
  if (price <= 150) {
    if (upside >= 84) return 4;
    if (upside >= 58) return 3;
    if (upside >= 36) return 2;
    return 1;
  }
  if (price <= 300) {
    return upside >= 76 ? 2 : 1;
  }
  return upside >= 90 ? 2 : 1;
}

function moonshotStars(player) {
  const rating = moonshotRating(player);
  return "★".repeat(rating);
}

function moonshotUpsideScore(player) {
  const price = boardCardPrice(player);
  const rawCeiling = ceilingScore(player);
  const ceiling = clampScore((rawCeiling - 82) * 1.8);
  const investment = investmentScore(player);
  const performance = performanceTrendScore(player);
  const catalyst = catalystScore(player);
  const trajectory = Math.max(0, boardMovementValue(player));
  const demand = hobbyDemandScore(player);
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
  return clampScore(
    ceiling * 0.34
    + investment * 0.20
    + performance * 0.14
    + catalyst * 0.10
    + demand * 0.14
    + Math.min(100, trajectory * 8) * 0.08
    + priceLeverage,
  );
}

function hobbyDemandScore(player) {
  const rank = Number(fieldValue(player, ["prospect_rank", "rank"], ""));
  const position = String(player.position || "").toUpperCase();
  const org = String(player.org || player.team || "");
  let score = 45;
  if (Number.isFinite(rank) && rank > 0) score += Math.max(0, 101 - rank) * 0.35;
  if (/(SS|OF|CF|3B)/.test(position)) score += 10;
  if (/(Yankees|Dodgers|Cubs|Mets|Red Sox|Phillies|Rangers|Mariners|Brewers)/i.test(org)) score += 8;
  if (boardMovementValue(player) > 0) score += Math.min(15, boardMovementValue(player) * 2);
  return clampScore(score);
}

function cardMarketConfidence(player) {
  const sales30 = numericField(player, ["market_sales_count_30d", "sales_count_30d", "salesCount30d", "sales_30"]);
  const sales90 = numericField(player, ["market_sales_count_90d", "sales_count_90d", "salesCount90d", "sales_90"]);
  const sellThrough30 = numericField(player, ["market_sell_through_30d", "sell_through_30d", "sellThrough30d", "sell_thru_rate_30d"]);
  const sellThrough90 = numericField(player, ["market_sell_through_90d", "sell_through_90d", "sellThrough90d", "sell_thru_rate_90d"]);
  const volume = Math.min(100, Math.max(
    Number.isFinite(sales30) ? sales30 * 4 : 0,
    Number.isFinite(sales90) ? sales90 * 1.3 : 0,
  ));
  const sellThrough = Math.max(
    Number.isFinite(sellThrough30) ? sellThrough30 : 0,
    Number.isFinite(sellThrough90) ? sellThrough90 : 0,
  );
  return Math.round(clampScore(liquidityScore(player) * 0.45 + volume * 0.35 + Math.min(100, sellThrough) * 0.20));
}

function priceDisciplineScore(player) {
  const current = currentCardPrice(player);
  const target = targetEntryPrice(player);
  const avg30 = positiveMoneyField(player, ["market_avg_price_30d", "avg_sold_price_30d", "avgSoldPrice30d", "avg_30", "thirty_day_avg"]);
  const avg90 = positiveMoneyField(player, ["market_avg_price_90d", "avg_sold_price_90d", "avgSoldPrice90d", "avg_90", "ninety_day_avg"]);
  if (!Number.isFinite(current)) return 35;
  let score = 68;
  if (Number.isFinite(avg30) && Number.isFinite(avg90) && avg90 > 0) {
    const trend = ((avg30 - avg90) / avg90) * 100;
    if (trend > 55) score -= 28;
    else if (trend > 25) score -= 12;
    else if (trend >= -10 && trend <= 18) score += 12;
    else if (trend < -25) score -= 8;
  }
  if (Number.isFinite(target) && target > 0) {
    const premium = ((current - target) / target) * 100;
    if (premium > 35) score -= 24;
    else if (premium > 12) score -= 10;
    else if (premium < -8) score += 10;
  }
  return clampScore(score);
}

function performanceTrendScore(player) {
  const ops = Number(player.last_14_ops || player.last_30_ops || player.recent_ops || player.hitter_ops || player.ops);
  const era = Number(player.last_30_era || player.recent_era || player.pitcher_era || player.era);
  const kMinusBb = Number(player.pitcher_k_minus_bb_pct || player.k_minus_bb_pct);
  if (Number.isFinite(ops)) return clampScore((ops - 0.62) * 185);
  if (Number.isFinite(era)) return clampScore(105 - era * 16);
  if (Number.isFinite(kMinusBb)) return clampScore(45 + kMinusBb * 1.8);
  return Number(boardMoveScore(player)) || 50;
}

function investmentMovementValue(player) {
  const direct = numericField(player, ["investment_score_delta", "market_opportunity_delta", "opportunity_score_delta"]);
  if (Number.isFinite(direct)) return direct;
  const current = investmentScore(player);
  const previous = numericField(player, ["previous_investment_score", "previous_market_opportunity_score", "previous_on_deck_opportunity_score"]);
  if (Number.isFinite(current) && Number.isFinite(previous)) return current - previous;
  return boardMovementValue(player);
}

function ebaySearchUrl(player) {
  const code = fieldValue(player, ["card_code", "benchmarkCardCode", "benchmark_card_code"], "");
  const query = [
    player.player_name,
    isValidCardCode(code) ? code : "",
    "Bowman Chrome 1st Auto",
    "-paper",
    "-digital",
    "-break",
    "-box",
    "-case",
    "-lot",
  ].filter(Boolean).join(" ");
  return `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(query)}`;
}

function clampScore(value) {
  return Math.max(0, Math.min(100, Number(value) || 0));
}

function profileTypeForSource(player) {
  const board = String(fieldValue(player, ["source_board", "sourceBoard", "board_type"], "")).toLowerCase();
  return board.includes("emerging") || board.includes("watch")
    ? "emerging"
    : "on-deck";
}

function boardMarketRead(player) {
  return usefulMarketRead(player);
}

function boardBuyZone(player) {
  const value = fieldValue(player, ["buy_zone", "final_action", "action", "recommendation"], "");
  if (value) return simplifyBuyZone(value);
  const fallback = buyZone(player);
  return fallback && fallback !== "-" ? fallback : "Research";
}

function simplifyMarketRead(value) {
  const text = String(value || "").toLowerCase();
  if (text.includes("avoid")) return "Avoid Chase";
  if (text.includes("no liquidity")) return "No Liquidity";
  if (text.includes("need")) return "Needs Market";
  if (text.includes("thin")) return "Thin";
  if (text.includes("liquid")) return "Liquid";
  if (text.includes("confirmed")) return "Confirmed";
  if (text.includes("buy") || text.includes("watch")) return value || "Watch";
  return value || "Needs Market";
}

function usefulMarketRead(player) {
  const loaded = fieldValue(player, ["market_read", "market_status", "market_signal"], "");
  if (loaded && loaded.includes(" · ")) return loaded;
  if (loaded && !/confirmed market|cached market data|market pending|needs market/i.test(loaded)) return simplifyMarketRead(loaded);

  const sales30 = numericField(player, ["market_sales_count_30d", "sales_count_30d", "salesCount30d", "sales_30"]);
  const sales90 = numericField(player, ["market_sales_count_90d", "sales_count_90d", "salesCount90d", "sales_90"]);
  const avg30 = numericField(player, ["market_avg_price_30d", "avg_sold_price_30d", "avgSoldPrice30d", "avg_30"]);
  const avg90 = numericField(player, ["market_avg_price_90d", "avg_sold_price_90d", "avgSoldPrice90d", "avg_90"]);
  if ((!Number.isFinite(sales30) || sales30 <= 0) && (!Number.isFinite(sales90) || sales90 <= 0)) {
    return loaded ? simplifyMarketRead(loaded) : simplifyMarketRead(marketStatus(player));
  }

  let volume = "Confirmed";
  if (Number.isFinite(sales90) && sales90 > 0 && sales90 < 4) volume = "Thin";
  else if ((Number.isFinite(sales30) && sales30 >= 12) || (Number.isFinite(sales90) && sales90 >= 20)) volume = "Liquid";

  let trend = fieldValue(player, ["market_trend", "price_trend"], "");
  if (!trend && Number.isFinite(avg30) && Number.isFinite(avg90) && avg90 > 0) {
    const movement = ((avg30 - avg90) / avg90) * 100;
    if (movement >= 12) trend = "Up";
    else if (movement <= -12) trend = "Down";
    else trend = "Stable";
  }
  if (!trend) trend = Number.isFinite(sales30) && Number.isFinite(sales90) && sales30 >= Math.max(3, sales90 * 0.4) ? "Active" : "Watch";
  return `${volume} · ${trend}`;
}

function numericField(player, fields) {
  for (const field of fields) {
    const raw = player[field];
    if (raw === "" || raw == null) continue;
    const value = Number(String(raw).replaceAll(/[$,%]/g, ""));
    if (Number.isFinite(value)) return value;
  }
  return NaN;
}

function positiveMoneyField(player, fields) {
  for (const field of fields) {
    const raw = player[field];
    if (raw === "" || raw == null) continue;
    const value = numericMoney(raw);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return NaN;
}

function marketToneClass(value) {
  const text = String(value || "").toLowerCase();
  if (text.includes("no liquidity") || text.includes("avoid") || text.includes("down") || text.includes("priced")) return "negative";
  if (text.includes("up") || text.includes("heating") || text.includes("strong")) return "positive";
  if (text.includes("stable") || text.includes("thin") || text.includes("need") || text.includes("pending") || text.includes("watch")) return "caution";
  return "neutral";
}

function simplifyBuyZone(value) {
  const text = String(value || "").toLowerCase();
  if (text.includes("strong")) return "Strong Buy";
  if (text.includes("avoid")) return "Avoid Chase";
  if (text.includes("no liquidity")) return "No Liquidity";
  if (text.includes("need")) return "Needs Market";
  if (text.includes("buy")) return "Buy Zone";
  if (text.includes("watch")) return "Watch";
  if (text.includes("research")) return "Research";
  return value || "Research";
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
  if (!elements.rows) return;
  if (!rows.length) {
    elements.rows.innerHTML = `<tr><td colspan="6" class="muted">No approved On Deck players found.</td></tr>`;
    return;
  }

  elements.rows.innerHTML = rows
    .map((rowPlayer, index) => {
      const player = withLiveMarketData(rowPlayer);
      const selected = String(player.player_id) === String(state.selectedId) ? "selected" : "";
      return `
        <tr class="${selected}" data-player-id="${escapeHtml(player.player_id)}">
          <td>
            <span class="player-name">
              <strong>${escapeHtml(player.player_name)}</strong>
              <span>${escapeHtml([player.org, player.level, player.position, player.age ? `Age ${player.age}` : ""].filter(Boolean).join(" · "))}</span>
            </span>
          </td>
          <td><span class="score-pill ${scoreClass(boardMoveScore(player))}">${escapeHtml(boardMoveScore(player))}</span></td>
          <td><span class="score-pill ${scoreClass(investmentScore(player))}">${escapeHtml(investmentScore(player))}</span></td>
          <td><span class="moonshot-stars" aria-label="${escapeHtml(moonshotRating(player))} out of 5 moonshot rating">${escapeHtml(moonshotStars(player))}</span></td>
          <td>${escapeHtml(cardBaselineLabel(player))}</td>
          <td>
            <a class="button ebay-button" href="${escapeHtml(ebaySearchUrl(player))}" target="_blank" rel="noreferrer" aria-label="Search eBay for ${escapeHtml(player.player_name)} Bowman Chrome 1st Auto">eBay</a>
          </td>
        </tr>
      `;
    })
    .join("");

  elements.rows.querySelectorAll("tr[data-player-id]").forEach((row) => {
    row.addEventListener("click", (event) => {
      event.stopPropagation();
      if (event.target.closest("a")) return;
      const player = rows.find((candidate) => String(candidate.player_id) === String(row.dataset.playerId));
      openPlayerProfile(row.dataset.playerId, { type: profileTypeForSource(player || {}) });
    });
  });
}

function renderTop100Rows() {
  if (!elements.top100Rows) return;
  const rows = getTop100Rows();
  if (elements.top100RowCount) {
    elements.top100RowCount.textContent = `${rows.length} ${rows.length === 1 ? "player" : "players"}`;
  }

  if (!rows.length) {
    elements.top100Rows.innerHTML = `<tr><td colspan="6" class="muted">No active MLB Top 100 players match the current filters.</td></tr>`;
    return;
  }

  elements.top100Rows.innerHTML = rows.map((rowPlayer) => {
    const player = withLiveMarketData(rowPlayer);
    const selected = String(player.player_id) === String(state.selectedId) ? "selected" : "";
    return `
      <tr class="${selected}" data-player-id="${escapeHtml(player.player_id)}">
        <td>
          <span class="player-name">
            <strong>${escapeHtml(player.player_name)}</strong>
            <span>#${escapeHtml(player.prospect_rank ?? "-")} · ${escapeHtml(playerTypeBadge(player))} · Age ${escapeHtml(player.age ?? "-")}</span>
          </span>
        </td>
        <td>${escapeHtml(player.org ?? "-")}</td>
        <td>${rankTrend(player) || "—"}</td>
        <td><span class="score-pill ${scoreClass(boardMoveScore(player))}">${escapeHtml(boardMoveScore(player))}</span></td>
        <td><span class="market-status ${marketToneClass(boardMarketRead(player))}">${escapeHtml(boardMarketRead(player))}</span></td>
        <td>${escapeHtml(boardBuyZone(player))}</td>
      </tr>
    `;
  }).join("");

  elements.top100Rows.querySelectorAll("tr[data-player-id]").forEach((row) => {
    row.addEventListener("click", (event) => {
      event.stopPropagation();
      openPlayerProfile(row.dataset.playerId, { type: "top100" });
    });
  });
}

function top100BenchmarkLabel(player) {
  const card = cardDescription(player);
  return card === "Bowman Chrome Prospect Auto" && !hasMarketData(player) ? "Pending" : card;
}

function countOrPending(value) {
  if (value === "" || value == null) return "Pending";
  const numeric = Number(value);
  return Number.isFinite(numeric) ? String(Math.round(numeric)) : String(value);
}

function currencyOrPending(value) {
  const formatted = currency(value);
  return formatted === "-" ? "Pending" : formatted;
}

function sellThroughOrPending(player, days) {
  const value = sellThroughValue(player, days);
  return Number.isFinite(value) ? `${value.toFixed(1)}%` : "Pending";
}

function dateOrPending(value) {
  return formatShortDate(value) || "Pending";
}

function top100ComparisonReason(player) {
  if (isCalledUp(player)) return "Already reached MLB; reference only.";
  if (isOnDeckBoardPlayer(player)) return `On Deck Board: ${onDeckCatalyst(player)}.`;
  const bubble = bubblePlayers().find((candidate) => String(candidate.player_id) === String(player.player_id));
  if (bubble) return bubbleMissReason(player);
  if (Number(player.opportunity_score) < 45) return "Path needs to open.";
  if (Number(player.performance_score) < 55) return "Current form needs to improve.";
  if (Number(player.readiness_score) < 55) return "Timeline is less immediate.";
  return "Behind the current On Deck score cutoff.";
}

function renderScorebook() {
  if (!elements.scorebookBoard) return;
  const officialHits = state.scorebook.filter((entry) => normalizeName(entry.verdict) === "hit");
  const historical = state.scorebook.filter((entry) => normalizeName(entry.verdict) === "historical");
  const missed = state.scorebook.filter((entry) => normalizeName(entry.verdict) === "missed");
  const purchases = state.scorebook.filter((entry) => normalizeName(entry.verdict) === "purchase ledger");
  const pending = onDeckPlayers().map((rowPlayer, index) => {
    const player = withLiveMarketData(rowPlayer);
    return {
      player_id: player.player_id,
      player_name: player.player_name,
      team: player.org,
      date_added: player.date_added || player.last_updated || "Manual baseline needed",
      current_rank: index + 1,
      ondeck_score: player.callup_score,
      card_baseline: cardBaselineLabel(player),
      latest_value: latestCardValue(player),
      market_status: marketStatus(player),
    };
  });

  elements.scorebookBoard.innerHTML = `
    <div class="scorebook-summary">
      ${scorebookMetric("Open bids", purchases.filter((entry) => normalizeName(entry.position_status || "open") !== "closed").length)}
      ${scorebookMetric("Capital at bat", totalPurchaseCost(purchases))}
      ${scorebookMetric("Realized P&L", realizedPnlLabel(purchases))}
      ${scorebookMetric("Call-up wins", purchases.filter((entry) => pnlClass(entry) === "pnl-positive").length)}
    </div>
    ${scorebookTable("Trade Ledger", purchases, purchaseLedgerColumns())}
    ${scorebookTable("Call-Up Results", officialHits, officialHitColumns())}
    ${pendingTable(pending)}
    ${scorebookTable("Historical Market Moves", historical, historicalColumns())}
  `;
  elements.scorebookBoard.querySelectorAll("tr[data-player-id]").forEach((row) => {
    row.addEventListener("click", (event) => {
      event.stopPropagation();
      openPlayerProfile(row.dataset.playerId);
      state.activeTool = "dashboard";
      history.pushState(null, "", "#on-deck");
      syncToolVisibility();
    });
  });
}

function renderGraduated() {
  if (!elements.graduatedBoard) return;
  const rows = state.graduated
    .map(withLiveMarketData)
    .sort((a, b) => String(b.graduatedDate || b.graduated_date || "").localeCompare(String(a.graduatedDate || a.graduated_date || "")) || a.player_name.localeCompare(b.player_name));

  if (!rows.length) {
    elements.graduatedBoard.innerHTML = `
      <section class="graduated-empty">
        <h3>No MLB graduates yet</h3>
        <p class="muted">When a tracked player reaches MLB status and falls off the current Top 100, he will move here automatically without losing profile or market history.</p>
      </section>
    `;
    return;
  }

  elements.graduatedBoard.innerHTML = `
    <div class="graduated-summary">
      ${scorebookMetric("MLB graduates", rows.length)}
      ${scorebookMetric("With market pulse", rows.filter((player) => player.market_signal || player.avg_30 || player.last_sale).length)}
      ${scorebookMetric("OnDeck alumni", rows.filter((player) => player.on_deck_board === "true" || player.onDeckBoard === true || player.date_added).length)}
    </div>
    <div class="graduated-grid">
      ${rows.map((player) => graduatedCardMarkup(player)).join("")}
    </div>
  `;

  elements.graduatedBoard.querySelectorAll(".graduate-card[data-player-id]").forEach((card) => {
    const openGraduate = (event) => {
      event.stopPropagation();
      state.activeTool = "dashboard";
      history.pushState(null, "", "#on-deck");
      syncToolVisibility();
      openPlayerProfile(card.dataset.playerId);
    };
    card.addEventListener("click", openGraduate);
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openGraduate(event);
      }
    });
  });
}

function graduatedCardMarkup(player) {
  const thesis = player.thesis_outcome || player.result_note || player.market_note || graduationTimelineMessage();
  return `
    <article class="graduate-card" role="button" tabindex="0" data-player-id="${escapeHtml(player.player_id)}">
      <div class="graduate-card-title">
        <div>
          <span class="graduate-badge">MLB Graduate</span>
          <h3>${escapeHtml(player.player_name)}</h3>
          <p>${escapeHtml([player.org, player.position].filter(Boolean).join(" · "))}</p>
        </div>
        <strong>${escapeHtml(formatShortDate(player.graduatedDate || player.graduated_date) || "-")}</strong>
      </div>
      <dl>
        <div><dt>Original rating</dt><dd>${escapeHtml(originalInvestmentRating(player))}</dd></div>
        <div><dt>Market pulse</dt><dd>${escapeHtml(lastKnownMarketPulse(player))}</dd></div>
        <div><dt>Thesis outcome</dt><dd>${escapeHtml(thesis)}</dd></div>
      </dl>
      <span class="profile-link">Open full player profile</span>
    </article>
  `;
}

function originalInvestmentRating(player) {
  return player.original_investment_rating || player.investment_rating || player.market_signal || `${player.callup_score ?? "-"}% move score`;
}

function lastKnownMarketPulse(player) {
  const latest = latestCardValue(player);
  const status = marketStatus(player);
  if (latest && latest !== "Awaiting API" && latest !== "API pending") return `${status}: ${latest}`;
  return status || "Market data retained";
}

function scorebookMetric(label, value) {
  return `<article><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></article>`;
}

function totalPurchaseCost(rows) {
  const total = rows.reduce((sum, row) => {
    const purchase = numericMoney(row.purchase_price);
    return Number.isFinite(purchase) ? sum + purchase : sum;
  }, 0);
  return total > 0 ? currency(total) : "$0.00";
}

function realizedPnlLabel(rows) {
  const closedRows = rows.filter((row) => Number.isFinite(numericMoney(row.sell_price)));
  if (!closedRows.length) return "Open";
  const pnl = closedRows.reduce((sum, row) => {
    const purchase = numericMoney(row.purchase_price);
    const sell = numericMoney(row.sell_price);
    return Number.isFinite(purchase) && Number.isFinite(sell) ? sum + (sell - purchase) : sum;
  }, 0);
  return pnl >= 0 ? `+${currency(pnl)}` : `-${currency(Math.abs(pnl))}`;
}

function pendingTable(rows) {
  if (!rows.length) {
    return `<section class="scorebook-section"><h3>On Deck Now</h3><p class="muted">No approved On Deck players found.</p></section>`;
  }
  return `
    <section class="scorebook-section">
      <h3>On Deck Now</h3>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Player</th>
              <th>Team</th>
              <th>Date Added</th>
              <th>Current Rank</th>
              <th>Move Score</th>
              <th>Card Baseline</th>
              <th>Latest Card</th>
              <th>Market Read</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map((row) => `
              <tr data-player-id="${escapeHtml(row.player_id)}">
                <td><strong>${escapeHtml(row.player_name)}</strong></td>
                <td>${escapeHtml(row.team ?? "-")}</td>
                <td>${escapeHtml(formatShortDate(row.date_added) || row.date_added || "-")}</td>
                <td>${escapeHtml(row.current_rank)}</td>
                <td><span class="score-pill ${scoreClass(row.ondeck_score)}">${escapeHtml(row.ondeck_score)}%</span></td>
                <td>${escapeHtml(row.card_baseline)}</td>
                <td>${escapeHtml(row.latest_value)}</td>
                <td><span class="market-status">${escapeHtml(row.market_status)}</span></td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function scorebookTable(title, rows, columns) {
  if (!rows.length) {
    return `<section class="scorebook-section"><h3>${escapeHtml(title)}</h3><p class="muted">No entries yet.</p></section>`;
  }
  return `
    <section class="scorebook-section">
      <h3>${escapeHtml(title)}</h3>
      <div class="table-wrap">
        <table>
          <thead><tr>${columns.map((column) => `<th>${escapeHtml(column.label)}</th>`).join("")}</tr></thead>
          <tbody>
            ${rows.map((row) => `<tr>${columns.map((column) => `<td>${column.render(row)}</td>`).join("")}</tr>`).join("")}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function purchaseLedgerColumns() {
  return [
    { label: "Player", render: (row) => `<strong>${escapeHtml(scorebookPlayerName(row))}</strong>` },
    { label: "Card", render: (row) => escapeHtml(row.card_name || "Bowman Chrome Auto") },
    { label: "Purchase Date", render: (row) => escapeHtml(formatShortDate(row.purchase_date || row.mlb_debut_date) || row.purchase_date || "-") },
    { label: "Buy Price", render: (row) => escapeHtml(currency(row.purchase_price)) },
    { label: "Sell Date", render: (row) => escapeHtml(formatShortDate(row.sell_date) || row.sell_date || "-") },
    { label: "Sell Price", render: (row) => escapeHtml(currency(row.sell_price)) },
    { label: "P&L", render: (row) => `<span class="${escapeHtml(pnlClass(row))}">${escapeHtml(pnlLabel(row))}</span>` },
    { label: "Status", render: (row) => `<span class="scorebook-result ${escapeHtml(scorebookStatusClass(row))}">${escapeHtml(row.position_status || "Open")}</span>` },
    { label: "Notes", render: (row) => escapeHtml(row.result_note || "-") },
  ];
}

function pnlLabel(row) {
  const purchase = numericMoney(row.purchase_price);
  const sell = numericMoney(row.sell_price);
  if (!Number.isFinite(purchase) || !Number.isFinite(sell)) return "Open";
  const change = sell - purchase;
  const pct = purchase > 0 ? ` (${Math.round((change / purchase) * 100)}%)` : "";
  return `${change >= 0 ? "+" : "-"}${currency(Math.abs(change))}${pct}`;
}

function pnlClass(row) {
  const purchase = numericMoney(row.purchase_price);
  const sell = numericMoney(row.sell_price);
  if (!Number.isFinite(purchase) || !Number.isFinite(sell)) return "pnl-open";
  return sell >= purchase ? "pnl-positive" : "pnl-negative";
}

function scorebookStatusClass(row) {
  const status = normalizeName(row.position_status || "open");
  if (status === "closed" || status === "sold") return "hit";
  if (status === "open") return "open";
  return "historical";
}

function officialHitColumns() {
  return [
    { label: "Player", render: (row) => `<strong>${escapeHtml(scorebookPlayerName(row))}</strong>` },
    { label: "Team", render: (row) => escapeHtml(row.team || row.org || "-") },
    { label: "Date Added", render: (row) => escapeHtml(formatShortDate(row.added_to_top10_date) || row.added_to_top10_date || "-") },
    { label: "Debut Date", render: (row) => escapeHtml(formatShortDate(row.mlb_debut_date) || row.mlb_debut_date || "-") },
    { label: "Lead Time", render: (row) => escapeHtml(leadTimeLabel(row)) },
    { label: "Score", render: (row) => escapeHtml(row.pre_callup_score || "-") },
    { label: "Market Move", render: (row) => escapeHtml(marketMoveLabel(row)) },
    { label: "Result", render: (row) => `<span class="scorebook-result hit">Hit</span>` },
  ];
}

function historicalColumns() {
  return [
    { label: "Player", render: (row) => `<strong>${escapeHtml(scorebookPlayerName(row))}</strong>` },
    { label: "Team", render: (row) => escapeHtml(row.team || row.org || "-") },
    { label: "Debut Date", render: (row) => escapeHtml(formatShortDate(row.mlb_debut_date) || row.mlb_debut_date || "-") },
    { label: "Card Before", render: (row) => escapeHtml(currency(row.card_before)) },
    { label: "Card After", render: (row) => escapeHtml(currency(row.card_after)) },
    { label: "Market Move", render: (row) => escapeHtml(marketMoveLabel(row)) },
    { label: "Result", render: () => `<span class="scorebook-result historical">Historical</span>` },
  ];
}

function scorebookPlayerName(row) {
  const player = state.scored.find((candidate) => String(candidate.player_id) === String(row.player_id))
    || state.calledUp.find((candidate) => String(candidate.player_id) === String(row.player_id));
  return row.player_name || player?.player_name || row.player_id || "-";
}

function leadTimeLabel(row) {
  if (row.lead_time_days) return `${row.lead_time_days} days`;
  const added = new Date(`${row.added_to_top10_date}T00:00:00`);
  const debut = new Date(`${row.mlb_debut_date}T00:00:00`);
  if (Number.isNaN(added.getTime()) || Number.isNaN(debut.getTime())) return "-";
  return `${Math.max(0, Math.round((debut - added) / 86400000))} days`;
}

function marketMoveLabel(row) {
  if (row.price_change_pct) return `${row.price_change_pct}%`;
  const before = numericMoney(row.card_before);
  const after = numericMoney(row.card_after);
  if (!Number.isFinite(before) || !Number.isFinite(after) || before <= 0) return row.result_note || "-";
  return `${Math.round(((after - before) / before) * 100)}%`;
}

function renderCard(player) {
  if (!elements.contentGrid || !elements.cardPanel || !elements.playerCard) return;
  if (!player) {
    elements.contentGrid.classList.remove("profile-open");
    elements.cardPanel.hidden = true;
    elements.playerCard.className = "player-card empty";
    elements.playerCard.innerHTML = "<p>Select a player to open the On Deck Briefing.</p>";
    return;
  }

  const normalizedInput = normalizeBriefingPlayer(player);
  const profilePlayer = normalizeBriefingPlayer(withLiveMarketData(normalizedInput));
  elements.contentGrid.classList.add("profile-open");
  elements.cardPanel.hidden = false;
  elements.playerCard.className = "player-card";
  elements.playerCard.innerHTML = `
    ${briefingHeaderSnapshot(profilePlayer)}
    ${briefingNarrativePanel(profilePlayer)}
    ${movementCasePanel(profilePlayer)}
    ${briefingMarketPulse(profilePlayer)}
    ${minorLeagueRecordPanel(profilePlayer)}
    ${decisionRiskPanel(profilePlayer)}
    ${isGraduated(profilePlayer) ? graduationTimelinePanel(profilePlayer) : ""}
  `;

  attachProfileActions(profilePlayer);
}

function normalizeBriefingPlayer(player) {
  if (!player) return player;
  return {
    ...player,
    player_id: player.player_id ?? player.playerId ?? "",
    player_name: player.player_name ?? player.playerName ?? "Player",
    org: player.org ?? player.team ?? player.organization ?? player.current_org ?? "",
    position: player.position ?? player.pos ?? "",
    level: player.level ?? player.current_level ?? "",
    age: player.age ?? "",
    eta: player.eta ?? "",
    prospect_rank: player.prospect_rank ?? player.rank ?? "",
    move_score: player.move_score ?? player.moveScore ?? player.on_deck_opportunity_score ?? "",
    on_deck_grade: player.on_deck_grade ?? player.onDeckGrade ?? player.grade ?? "",
    market_read: player.market_read ?? player.marketRead ?? player.market_status ?? "",
    benchmark_card_code: player.benchmark_card_code ?? player.benchmarkCardCode ?? player.card_code ?? "",
    card_code: player.card_code ?? player.benchmarkCardCode ?? player.benchmark_card_code ?? "",
    canonical_query: player.canonical_query ?? player.canonicalQuery ?? player.card_query ?? "",
    card_query: player.card_query ?? player.canonicalQuery ?? player.canonical_query ?? "",
    avg_30: player.avg_30 ?? player.avgSoldPrice30d ?? player.thirty_day_avg ?? "",
    avg_90: player.avg_90 ?? player.avgSoldPrice90d ?? "",
    sales_30: player.sales_30 ?? player.salesCount30d ?? "",
    sales_90: player.sales_90 ?? player.salesCount90d ?? "",
    sell_through_30: player.sell_through_30 ?? player.sellThruRate30d ?? player.sell_through_30d ?? "",
    sell_through_90: player.sell_through_90 ?? player.sellThruRate90d ?? player.sell_through_90d ?? "",
    last_sale: player.last_sale ?? player.lastSoldPrice ?? "",
    last_sale_date: player.last_sale_date ?? player.lastSoldAt ?? "",
    card_year: player.card_year ?? player.cardYear ?? "",
    source: player.source ?? player.data_source ?? "",
  };
}

function briefingHeaderSnapshot(player) {
  const grade = briefingGrade(player);
  const moveScore = briefingMoveScore(player);
  const marketRead = briefingMarketRead(player);
  const physical = [player.bats ? `Bats ${player.bats}` : "", player.throws ? `Throws ${player.throws}` : "", player.height_weight || ""].filter(Boolean);
  return `
    <section class="briefing-header">
      <div>
        <p class="card-kicker">Player Header Snapshot</p>
        <h3>${escapeHtml(player.player_name)}</h3>
        <p class="briefing-meta">${escapeHtml(fieldValue(player, ["org", "organization", "current_org", "team"]))} · ${escapeHtml(fieldValue(player, ["position"]))} · ${escapeHtml(fieldValue(player, ["level", "stat_level", "current_level"]))}</p>
        <p class="muted">${escapeHtml(briefingHeaderLine(player))}</p>
        ${physical.length ? `<p class="briefing-physical">${escapeHtml(physical.join(" · "))}</p>` : ""}
      </div>
      <div class="briefing-grade-block">
        ${isGraduated(player) ? `<span class="graduate-badge">MLB Graduate</span>` : ""}
        <span>On Deck Grade</span>
        <strong class="grade-pill ${marketGradeClass(player)}">${escapeHtml(grade)}</strong>
        <small class="${marketStatusClass(player)}">${escapeHtml(marketRead)}</small>
      </div>
    </section>
    <div class="briefing-snapshot-grid">
      ${briefingFact("Move Score", moveScore)}
      ${briefingFact("Market Read", marketRead)}
      ${briefingFact("Pipeline Rank", player.prospect_rank ? `#${player.prospect_rank}` : "Pending")}
      ${briefingFact("ETA", fieldValue(player, ["eta"]))}
      ${briefingFact("Age", fieldValue(player, ["age"]))}
      ${briefingFact("Level", fieldValue(player, ["level", "stat_level", "current_level"]))}
    </div>
  `;
}

function briefingHeaderLine(player) {
  const parts = [
    player.age ? `Age ${player.age}` : "",
    player.eta ? `ETA ${player.eta}` : "",
    player.prospect_rank ? `MLB Pipeline #${player.prospect_rank}` : "",
    top10Rank(player) !== "-" ? `On Deck #${top10Rank(player)}` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "Snapshot pending latest player data.";
}

function briefingNarrativePanel(player) {
  return `
    <section class="briefing-section">
      <div class="panel-heading compact">
        <h3>On Deck Briefing</h3>
        <span>${escapeHtml(briefingStatus(player))}</span>
      </div>
      <div class="briefing-mini-grid">
        ${briefingMini("Resume", briefingResume(player))}
        ${briefingMini("Movement Case", briefingMovementCase(player))}
        ${briefingMini("Card Setup", briefingCardSetup(player))}
        ${briefingMini("Risk", briefingRiskNote(player))}
      </div>
    </section>
  `;
}

function movementCasePanel(player) {
  return `
    <section class="briefing-section movement-case-panel">
      <div class="panel-heading compact">
        <h3>Movement Case</h3>
        <span>${escapeHtml(primaryCatalystLabel(player))}</span>
      </div>
      <div class="briefing-score-grid">
        ${briefingMetric("Move Score", briefingMoveScore(player))}
        ${briefingMetric("Primary Catalyst", primaryCatalystLabel(player))}
        ${briefingMetric("Next Move", nextMoveLabel(player))}
        ${briefingMetric("Confidence", confidenceLabel(player))}
      </div>
    </section>
  `;
}

function briefingMarketPulse(player) {
  if (!hasMarketData(player)) {
    return `
      <section class="briefing-section market-pulse-briefing">
        <div class="panel-heading compact">
          <h3>Card Market Pulse</h3>
          <span>Pending</span>
        </div>
        <p class="muted">Market pulse pending card-data refresh.</p>
      </section>
    `;
  }

  const facts = [
    { label: "Benchmark Card", value: cardDescription(player) },
    { label: "30D Avg", value: currencyOrPending(player.avg_30) },
    { label: "Sell-Through", value: sellThroughOrPending(player, 30) },
    { label: "Liquidity", value: liquidityLabel(player) },
    { label: "Market Read", value: briefingMarketRead(player) },
    { label: "Buy Zone", value: briefingBuyZone(player) },
  ];
  if (numericMoney(player.avg_90) > 0) {
    facts.splice(2, 0, { label: "90D Avg", value: currencyOrPending(player.avg_90) });
  }

  return `
    <section class="briefing-section market-pulse-briefing">
      <div class="panel-heading compact">
        <h3>Card Market Pulse</h3>
        <span class="grade-pill ${marketGradeClass(player)}">${escapeHtml(briefingGrade(player))}</span>
      </div>
      <div class="briefing-market-grid">
        ${facts.map((fact) => briefingFact(fact.label, fact.value)).join("")}
      </div>
      <p>${escapeHtml(marketPulseTakeaway(player))}</p>
      <div class="briefing-actions">
        <button class="button ghost history-link" type="button" data-market-history>Historical Data</button>
      </div>
      ${marketHistoryPanel(player)}
    </section>
  `;
}

function minorLeagueRecordPanel(player) {
  const rows = minorLeagueRecordRows(player);
  return `
    <section class="briefing-section minor-record-panel">
      <div class="panel-heading compact">
        <h3>2026 Minor League Record</h3>
        <span>${escapeHtml(fieldValue(player, ["stat_team", "level", "stat_level"], "Current stats"))}</span>
      </div>
      ${rows.length ? `
        <div class="briefing-record-wrap">
          <table class="briefing-record-table">
            <thead>
              <tr>${rows.map((cell) => `<th>${escapeHtml(cell.label)}</th>`).join("")}</tr>
            </thead>
            <tbody>
              <tr>${rows.map((cell) => `<td>${escapeHtml(cell.value)}</td>`).join("")}</tr>
            </tbody>
          </table>
        </div>
        <p>${escapeHtml(profileTrendSentence(player))}</p>
      ` : `<p class="muted">2026 stat line pending.</p>`}
    </section>
  `;
}

function decisionRiskPanel(player) {
  const recommendation = decisionRecommendation(player);
  return `
    <section class="briefing-section decision-risk-panel">
      <div class="panel-heading compact">
        <h3>Decision / Risk</h3>
        <span>${escapeHtml(recommendation)}</span>
      </div>
      <div class="decision-grid">
        ${briefingFact("Grade", briefingGrade(player))}
        ${briefingFact("Status", briefingStatus(player))}
        ${briefingFact("Recommendation", recommendation)}
        ${briefingFact("Buy Zone", briefingBuyZone(player))}
      </div>
      <div class="decision-notes">
        <div>
          <span>Main Reason</span>
          <p>${escapeHtml(mainReason(player))}</p>
        </div>
        <div>
          <span>Main Risk</span>
          <p>${escapeHtml(briefingRiskNote(player))}</p>
        </div>
      </div>
    </section>
  `;
}

function briefingMini(label, value) {
  return `
    <article>
      <span>${escapeHtml(label)}</span>
      <p>${escapeHtml(value)}</p>
    </article>
  `;
}

function briefingMetric(label, value) {
  return `
    <div>
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `;
}

function briefingFact(label, value) {
  return `
    <div>
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value || "Pending")}</strong>
    </div>
  `;
}

function fieldValue(player, fields, fallback = "-") {
  for (const field of fields) {
    const value = player[field];
    if (value !== "" && value != null) return String(value);
  }
  return fallback;
}

function briefingGrade(player) {
  return fieldValue(player, ["grade", "on_deck_grade", "recommendation_grade"], marketGrade(player));
}

function briefingMoveScore(player) {
  const value = fieldValue(player, ["move_score", "on_deck_opportunity_score", "callup_score"], "");
  const numeric = Number(value);
  return Number.isFinite(numeric) ? `${Math.round(numeric)}` : "Pending";
}

function briefingMarketRead(player) {
  const loaded = fieldValue(player, ["market_read", "market_status"], "");
  return loaded || derivedMarketRead(player);
}

function briefingStatus(player) {
  if (isGraduated(player)) return "Graduated";
  if (isOnDeckBoardPlayer(player)) return "On Deck";
  if (hasMarketData(player)) return "Watch";
  return "Needs Market";
}

function briefingResume(player) {
  const loaded = fieldValue(player, ["resume_summary"], "");
  if (loaded) return loaded;
  const rank = player.prospect_rank ? `MLB Pipeline #${player.prospect_rank}` : "ranking pending";
  const level = fieldValue(player, ["level", "stat_level"], "current level pending");
  const age = player.age ? `Age ${player.age}` : "Age pending";
  const stat = compactStatSummary(player);
  if (stat) {
    return `${age} ${fieldValue(player, ["org"], "organization pending")} ${fieldValue(player, ["position"], "position pending")} at ${level}; ${rank}. ${stat}`;
  }
  return `${age} ${fieldValue(player, ["org"], "organization pending")} ${fieldValue(player, ["position"], "position pending")} at ${level}; ${rank}. Briefing pending latest recommendation run.`;
}

function briefingMovementCase(player) {
  const loaded = fieldValue(player, ["movement_case"], "");
  if (loaded) return loaded;
  const movement = rankTrendText(player);
  const score = briefingMoveScore(player);
  const catalyst = nextMoveLabel(player);
  const trend = movement === "Untracked" ? "rank trend is not established" : `rank trend is ${movement.toLowerCase()}`;
  if (score !== "Pending") return `${catalyst} is the next attention trigger, with a ${score} move score and ${trend}.`;
  return "Movement case pending.";
}

function briefingCardSetup(player) {
  const loaded = fieldValue(player, ["card_setup_summary"], "");
  if (loaded) return loaded;
  if (!hasMarketData(player)) return "Card setup pending market refresh.";
  const average = currencyOrPending(player.avg_30);
  const sellThrough = sellThroughOrPending(player, 30);
  return `${cardDescription(player)} is the benchmark. The 30-day average is ${average}, sell-through is ${sellThrough}, liquidity is ${liquidityLabel(player)}, and the current buy zone is ${briefingBuyZone(player)}.`;
}

function briefingRiskNote(player) {
  const loaded = fieldValue(player, ["risk_notes"], "");
  if (loaded) return loaded;
  const status = marketStatus(player);
  const movement = rankMovement(player);
  if (!hasMarketData(player)) return "Risk note pending card-market refresh.";
  if (String(status).toLowerCase().includes("cooling")) return "Short-window prices are cooling, so the move case needs current performance to keep improving.";
  if (String(status).toLowerCase().includes("priced") || String(status).toLowerCase().includes("spiked")) return "Market may already be reacting; avoid chasing above the buy zone.";
  if (movement != null && movement < 0) return "Top 100 trend is negative, which can slow demand even if the next assignment is still in play.";
  if (Number(player.performance_score) < 55) return "Current form needs to firm up before the catalyst becomes urgent.";
  return "Primary risk is timing: the baseball catalyst may be real but slower than the market expects.";
}

function primaryCatalystLabel(player) {
  const loaded = fieldValue(player, ["primary_catalyst"], "");
  const allowed = new Set(["Promotion Watch", "Rank Riser", "Performance Breakout", "MLB Proximity", "Card-Market Lag", "Watch Only", "Needs Data"]);
  if (allowed.has(loaded)) return loaded;
  if (!player.callup_score && !player.move_score) return "Needs Data";
  if (String(player.level ?? "").toUpperCase() === "AAA" || isOnFortyMan(player)) return "MLB Proximity";
  if (rankMovement(player) != null && rankMovement(player) > 0) return "Rank Riser";
  if (Number(player.performance_score) >= 70 || strongRecentForm(player)) return "Performance Breakout";
  if (hasMarketData(player) && ["Early Entry", "Liquidity Watch"].includes(marketStatus(player))) return "Card-Market Lag";
  if (Number(player.callup_score) >= 55 || Number(player.move_score) >= 55) return "Promotion Watch";
  return "Watch Only";
}

function nextMoveLabel(player) {
  return fieldValue(player, ["next_move"], onDeckCatalyst(player));
}

function confidenceLabel(player) {
  const loaded = fieldValue(player, ["confidence_label"], "");
  if (loaded) return loaded;
  const score = Number(player.move_score || player.callup_score);
  if (!Number.isFinite(score)) return "Needs Data";
  if (score >= 75) return "High";
  if (score >= 55) return "Medium";
  return "Low";
}

function liquidityLabel(player) {
  const loaded = fieldValue(player, ["liquidity_label"], "");
  if (loaded) return loaded;
  const sales90 = Number(player.sales_90);
  if (Number.isFinite(sales90)) {
    if (sales90 >= 10) return "Good";
    if (sales90 >= 4) return "Moderate";
    if (sales90 >= 1) return "Thin";
    return "No Liquidity";
  }
  const grade = liquidityGrade(player);
  if (grade === "A") return "Strong";
  if (grade === "B") return "Good";
  if (grade === "C") return "Average";
  if (grade === "D" || grade === "F") return "Thin";
  return "Pending";
}

function compactStatSummary(player) {
  if (isPitcherPosition(player.position)) {
    const era = statValue(player.pitcher_era || player.era);
    const whip = statValue(player.pitcher_whip || player.whip);
    if (era !== "-" || whip !== "-") return `Current record: ${era} ERA and ${whip} WHIP.`;
    return "";
  }
  const avg = statValue(player.hitter_avg || player.avg);
  const ops = statValue(player.hitter_ops || player.ops);
  if (avg !== "-" || ops !== "-") return `Current record: ${avg} AVG and ${ops} OPS.`;
  return "";
}

function strongRecentForm(player) {
  if (isPitcherPosition(player.position)) {
    const recent = firstAvailableWindow(player, [["last_14_era", 14], ["last_30_era", 30]]);
    const season = Number(player.era);
    return recent && Number.isFinite(season) && recent.value <= season - 0.35;
  }
  const recent = firstAvailableWindow(player, [["last_14_ops", 14], ["last_30_ops", 30]]);
  const season = Number(player.ops);
  return recent && Number.isFinite(season) && recent.value >= season + 0.05;
}

function marketPulseTakeaway(player) {
  return `${marketStatusInsight(player)} ${liquidityInsight(player)}`;
}

function derivedMarketRead(player) {
  if (!hasMarketData(player)) return "Pending";
  const sales90 = Number(player.sales_90);
  if (Number.isFinite(sales90) && sales90 <= 0) return "No Liquidity";
  const avg30 = numericMoney(player.avg_30);
  const avg90 = numericMoney(player.avg_90);
  const sales30 = Number(player.sales_30);
  if (Number.isFinite(avg30) && Number.isFinite(avg90) && avg90 > 0) {
    if (avg30 > avg90 * 1.4) return "Priced In";
    if (avg30 > avg90 * 1.2 && Number.isFinite(sales30) && sales30 >= 5) return "Heating";
  }
  return "Early / Stable";
}

function briefingBuyZone(player) {
  if (player.buy_low || player.buy_high) {
    return [player.buy_low, player.buy_high].filter(Boolean).map(currency).join(" - ");
  }
  const avg30 = numericMoney(player.avg_30);
  if (!Number.isFinite(avg30)) return "Pending";
  const read = briefingMarketRead(player).toLowerCase();
  const lowFactor = read.includes("heating") ? 0.75 : 0.8;
  const highFactor = read.includes("heating") ? 0.88 : 0.92;
  return `${currency(Math.round(avg30 * lowFactor))} - ${currency(Math.round(avg30 * highFactor))}`;
}

function minorLeagueRecordRows(player) {
  if (isPitcherPosition(player.position)) {
    const kCell = pitcherRateCell(player, ["pitcher_k_pct", "k_pct", "k_rate"], "k_per_9", "K%", "K/9");
    const bbCell = pitcherRateCell(player, ["pitcher_bb_pct", "bb_pct", "bb_rate"], "bb_per_9", "BB%", "BB/9");
    const rows = [
      { label: "Level", value: fieldValue(player, ["stat_level", "level"]) },
      { label: "IP", value: statValue(player.pitcher_ip || player.ip) },
      { label: "ERA", value: statValue(player.pitcher_era || player.era) },
      { label: "WHIP", value: statValue(player.pitcher_whip || player.whip) },
      kCell,
      bbCell,
      { label: "K-BB%", value: percentStatValue(player.pitcher_k_minus_bb_pct || player.k_minus_bb_pct) },
    ];
    return rows.some((row) => row.label !== "Level" && row.value !== "-") ? rows : [];
  }

  const rows = [
    { label: "Level", value: fieldValue(player, ["stat_level", "level"]) },
    { label: "PA", value: countValue(player.hitter_pa || player.pa) },
    { label: "AVG", value: statValue(player.hitter_avg || player.avg) },
    { label: "OBP", value: statValue(player.hitter_obp || player.obp) },
    { label: "SLG", value: statValue(player.hitter_slg || player.slg) },
    { label: "OPS", value: statValue(player.hitter_ops || player.ops) },
    { label: "HR", value: countValue(player.hitter_hr || player.hr) },
    { label: "SB", value: countValue(player.hitter_sb || player.sb) },
    { label: "BB%", value: percentStatValue(player.hitter_bb_pct || player.bb_pct || player.bb_rate) },
    { label: "K%", value: percentStatValue(player.hitter_k_pct || player.k_pct || player.k_rate) },
  ];
  return rows.some((row) => row.label !== "Level" && row.value !== "-") ? rows : [];
}

function pitcherRateCell(player, percentFields, rateField, percentLabel, rateLabel) {
  for (const field of percentFields) {
    if (player[field] !== "" && player[field] != null) {
      return { label: percentLabel, value: percentStatValue(player[field]) };
    }
  }
  return { label: rateLabel, value: statValue(player[rateField]) };
}

function percentStatValue(value) {
  if (value === "" || value == null) return "-";
  const numeric = Number(String(value).replaceAll("%", ""));
  if (!Number.isFinite(numeric)) return String(value);
  return `${numeric.toFixed(numeric % 1 === 0 ? 0 : 1)}%`;
}

function decisionRecommendation(player) {
  const loaded = fieldValue(player, ["recommendation", "decision_summary"], "");
  if (loaded) return loaded;
  if (!hasMarketData(player)) return "Recommendation pending market refresh";
  const status = marketStatus(player);
  const zone = buyZone(player);
  if (["Early Entry", "Liquidity Watch"].includes(status) && zone !== "-") return "Watch buy zone";
  if (status === "Moving Up") return "Buy only on disciplined comps";
  if (status === "Cooling") return "Wait for baseball confirmation";
  if (status === "Priced In" || status === "Spiked") return "Avoid chasing the spike";
  return "Recommendation pending latest scoring run";
}

function mainReason(player) {
  const loaded = fieldValue(player, ["decision_summary"], "");
  if (loaded) return loaded;
  if (!hasMarketData(player)) return "Move case is visible, but the card market still needs a refreshed benchmark read.";
  if (Number(player.callup_score) >= 65 && liquidityGrade(player) !== "N/A") {
    return "Strong move score with tradable benchmark-card liquidity.";
  }
  if (rankMovement(player) != null && rankMovement(player) > 0) {
    return "Positive Top 100 movement is adding prospect attention to the next-move case.";
  }
  if (strongRecentForm(player)) {
    return "Recent performance is strengthening the case for the next assignment.";
  }
  return "The current case combines player path, recent form, and available card-market data.";
}

function withLiveMarketData(player) {
  const snapshot = state.marketSnapshots.get(String(player.player_id));
  const live = state.liveMarketData.get(String(player.player_id));
  return { ...player, ...(snapshot ?? {}), ...(live ?? {}) };
}

function attachProfileActions(player) {
  elements.playerCard.querySelector("[data-market-history]")?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    requestMarketHistory(player);
  });
}

async function requestMarketHistory(player) {
  const playerId = String(player.player_id);
  if (state.marketHistoryRequests.has(playerId)) return;
  if (state.marketHistoryData.has(playerId)) {
    renderCard(state.allScored.find((candidate) => String(candidate.player_id) === playerId));
    return;
  }

  state.marketHistoryRequests.add(playerId);
  state.marketHistoryErrors.delete(playerId);
  renderCard(state.allScored.find((candidate) => String(candidate.player_id) === playerId));

  const params = new URLSearchParams({ player: player.player_name || "", days: "365" });

  try {
    const response = await fetch(`/api/market-history?${params.toString()}`, { headers: { Accept: "application/json" } });
    if (!response.ok) {
      state.marketHistoryErrors.set(playerId, `History unavailable (${response.status})`);
    } else {
      state.marketHistoryData.set(playerId, await response.json());
    }
  } catch {
    state.marketHistoryErrors.set(playerId, "History is unavailable in this local/static run.");
  } finally {
    state.marketHistoryRequests.delete(playerId);
    if (String(state.selectedId) === playerId) {
      renderCard(state.allScored.find((candidate) => String(candidate.player_id) === playerId));
    }
  }
}

function normalizeMarketSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return {};
  const playerId = snapshot.playerId ?? snapshot.player_id ?? "";
  const sellThrough30 = snapshotSellThroughPercent(snapshot.sellThruRate30d ?? snapshot.sell_thru_rate_30d);
  const sellThrough90 = snapshotSellThroughPercent(snapshot.sellThruRate90d ?? snapshot.sell_thru_rate_90d);
  const hasSnapshot = [
    snapshot.salesCount30d,
    snapshot.salesCount90d,
    snapshot.avgSoldPrice30d,
    snapshot.avgSoldPrice90d,
    snapshot.lastSoldPrice,
    snapshot.activeListingCount,
  ].some((value) => value !== "" && value != null);

  return compactMarketRow({
    player_id: playerId,
    card_code: snapshot.benchmarkCardCode ?? snapshot.benchmark_card_code ?? "",
    benchmark_card_code: snapshot.benchmarkCardCode ?? snapshot.benchmark_card_code ?? "",
    card_name: "Bowman Chrome Auto",
    card_query: snapshot.canonicalQuery ?? snapshot.canonical_query ?? "",
    canonical_query: snapshot.canonicalQuery ?? snapshot.canonical_query ?? "",
    data_source: snapshot.source ?? "D1 market snapshot",
    last_sale: snapshot.lastSoldPrice ?? snapshot.last_sold_price ?? "",
    last_sale_date: snapshot.lastSoldAt ?? snapshot.last_sold_at ?? "",
    avg_30: snapshot.avgSoldPrice30d ?? snapshot.avg_sold_price_30d ?? "",
    avg_90: snapshot.avgSoldPrice90d ?? snapshot.avg_sold_price_90d ?? "",
    median_30: snapshot.medianSoldPrice30d ?? snapshot.median_sold_price_30d ?? "",
    median_90: snapshot.medianSoldPrice90d ?? snapshot.median_sold_price_90d ?? "",
    low_30: snapshot.lowSoldPrice30d ?? snapshot.low_sold_price_30d ?? "",
    high_30: snapshot.highSoldPrice30d ?? snapshot.high_sold_price_30d ?? "",
    low_90: snapshot.lowSoldPrice90d ?? snapshot.low_sold_price_90d ?? "",
    high_90: snapshot.highSoldPrice90d ?? snapshot.high_sold_price_90d ?? "",
    sales_30: snapshot.salesCount30d ?? snapshot.sales_count_30d ?? "",
    sales_90: snapshot.salesCount90d ?? snapshot.sales_count_90d ?? "",
    active_listings: snapshot.activeListingCount ?? snapshot.active_listing_count ?? "",
    active_lowest_ask: snapshot.activeLowestAsk ?? snapshot.active_lowest_ask ?? "",
    active_median_ask: snapshot.activeMedianAsk ?? snapshot.active_median_ask ?? "",
    active_highest_ask: snapshot.activeHighestAsk ?? snapshot.active_highest_ask ?? "",
    active_auction_count: snapshot.activeAuctionCount ?? snapshot.active_auction_count ?? "",
    active_buy_it_now_count: snapshot.activeBuyItNowCount ?? snapshot.active_buy_it_now_count ?? "",
    sell_through_30: Number.isFinite(sellThrough30) ? sellThrough30 : "",
    sell_through_90: Number.isFinite(sellThrough90) ? sellThrough90 : "",
    card_year: snapshot.cardYear ?? snapshot.card_year ?? "",
    target_only: snapshot.targetOnly ?? snapshot.target_only ?? "",
    sold_refreshed_at: snapshot.soldRefreshedAt ?? snapshot.sold_refreshed_at ?? "",
    active_data_updated_at: snapshot.activeDataUpdatedAt ?? snapshot.active_data_updated_at ?? "",
    checked_at: snapshot.checkedAt ?? snapshot.checked_at ?? "",
    last_updated: snapshot.checkedAt ?? snapshot.checked_at ?? "",
    market_signal: hasSnapshot ? "Cached Market Data" : "",
  });
}

function snapshotSellThroughPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return NaN;
  return numeric <= 1 ? numeric * 100 : numeric;
}

function compactMarketRow(row) {
  return Object.fromEntries(Object.entries(row).filter(([, value]) => value !== "" && value != null));
}

function profileStatsPanel(player) {
  return `
    <section class="profile-stats-panel">
      <div class="panel-heading compact">
        <h3>Current Stats & Trend</h3>
        <span>${escapeHtml(player.stat_team || player.level || "Current form")}</span>
      </div>
      <div class="profile-stat-grid">
        ${profileStatCells(player).map((cell) => `
          <div>
            <span>${escapeHtml(cell.label)}</span>
            <strong>${escapeHtml(cell.value)}</strong>
          </div>
        `).join("")}
      </div>
      <p>${escapeHtml(profileTrendSentence(player))}</p>
    </section>
  `;
}

function profileStatCells(player) {
  if (isPitcherPosition(player.position)) {
    return [
      { label: "Level", value: player.stat_level || player.level || "-" },
      { label: "ERA", value: statValue(player.era) },
      { label: "WHIP", value: statValue(player.whip) },
      { label: "K/9", value: statValue(player.k_per_9) },
      { label: "BB/9", value: statValue(player.bb_per_9) },
      { label: "Recent", value: pitcherTrendValue(player) },
    ];
  }
  return [
    { label: "Level", value: player.stat_level || player.level || "-" },
    { label: "AVG", value: statValue(player.avg) },
    { label: "OBP", value: statValue(player.obp) },
    { label: "SLG", value: statValue(player.slg) },
    { label: "OPS", value: statValue(player.ops) },
    { label: "14/30 Trend", value: hitterTrendValue(player) },
  ];
}

function hitterTrendValue(player) {
  const recent = player.last_14_ops || player.last_30_ops || player.last_60_ops;
  if (!recent) return "-";
  const label = player.last_14_ops ? "14D" : player.last_30_ops ? "30D" : "60D";
  return `${label} ${formatStatDecimal(recent)}`;
}

function pitcherTrendValue(player) {
  const recent = player.last_14_era || player.last_30_era || player.last_60_era;
  if (!recent) return "-";
  const label = player.last_14_era ? "14D" : player.last_30_era ? "30D" : "60D";
  return `${label} ${formatEraValue(recent)}`;
}

function profileTrendSentence(player) {
  if (isPitcherPosition(player.position)) {
    const recent = firstAvailableWindow(player, [["last_14_era", 14], ["last_30_era", 30], ["last_60_era", 60]]);
    const seasonEra = Number(player.era);
    if (!recent) {
      return player.era ? `Recent ERA splits are not loaded yet; season baseline is ${formatEraValue(player.era)} ERA.` : "Current pitching trend data is not loaded yet.";
    }
    if (Number.isFinite(seasonEra)) {
      if (recent.value <= seasonEra - 0.35) return `${formatEraValue(recent.value)} ERA over the last ${recent.days} days is better than the season ${formatEraValue(player.era)} ERA. Run prevention is trending up.`;
      if (recent.value >= seasonEra + 0.35) return `${formatEraValue(recent.value)} ERA over the last ${recent.days} days is worse than the season ${formatEraValue(player.era)} ERA. Run prevention is trending down.`;
      return `${formatEraValue(recent.value)} ERA over the last ${recent.days} days is close to the season ${formatEraValue(player.era)} ERA.`;
    }
    return `${formatEraValue(recent.value)} ERA over the last ${recent.days} days is the current trend marker.`;
  }

  const recent = firstAvailableWindow(player, [["last_14_ops", 14], ["last_30_ops", 30], ["last_60_ops", 60]]);
  const seasonOps = Number(player.ops);
  if (!recent) {
    return player.ops ? `Recent OPS splits are not loaded yet; season baseline is ${formatStatDecimal(player.ops)} OPS.` : "Current hitting trend data is not loaded yet.";
  }
  if (Number.isFinite(seasonOps)) {
    if (recent.value >= seasonOps + 0.05) return `${formatStatDecimal(recent.value)} OPS over the last ${recent.days} days is above the season ${formatStatDecimal(player.ops)} OPS. Bat is trending up.`;
    if (recent.value <= seasonOps - 0.05) return `${formatStatDecimal(recent.value)} OPS over the last ${recent.days} days is below the season ${formatStatDecimal(player.ops)} OPS. Bat is trending down.`;
    return `${formatStatDecimal(recent.value)} OPS over the last ${recent.days} days is close to the season ${formatStatDecimal(player.ops)} OPS.`;
  }
  return `${formatStatDecimal(recent.value)} OPS over the last ${recent.days} days is the current trend marker.`;
}

function firstAvailableWindow(player, fields) {
  for (const [field, days] of fields) {
    const value = Number(player[field]);
    if (player[field] !== "" && player[field] != null && Number.isFinite(value)) {
      return { value, days };
    }
  }
  return null;
}

function statValue(value) {
  if (value === "" || value == null) return "-";
  const numeric = Number(value);
  if (Number.isFinite(numeric) && Math.abs(numeric) < 2) return formatStatDecimal(numeric);
  return String(value);
}

function formatStatDecimal(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric.toFixed(3).replace(/^0/, "") : String(value ?? "-");
}

function formatEraValue(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric.toFixed(2) : String(value ?? "-");
}

function isPitcherPosition(position) {
  return String(position ?? "").toUpperCase().includes("P");
}

function teamPathPanel(player) {
  const role = depthChartGroup(player.position);
  const blockers = blockerNames(player).slice(0, 4);
  const blockerText = blockers.length ? blockers.join(", ") : "No named blockers loaded";
  const lane = {
    role,
    players: [player],
    blockers,
    injuries: String(player.injury_opening).toLowerCase() === "true" ? 1 : 0,
    need: Number(player.mlb_team_need) || 0,
  };
  return `
    <section class="profile-war-room">
      <div class="panel-heading compact">
        <h3>Org Path</h3>
        <span>${escapeHtml(role)}</span>
      </div>
      <p>${escapeHtml(playerPathRead(player, lane))}</p>
      <p class="muted">Names ahead: ${escapeHtml(blockerText)}</p>
    </section>
  `;
}

function top10Rank(player) {
  const index = onDeckPlayers().findIndex((candidate) => String(candidate.player_id) === String(player.player_id));
  return index >= 0 ? index + 1 : "-";
}

function playerTypeBadge(player) {
  if (player.player_type_badge) return player.player_type_badge;
  const level = String(player.level ?? "").toUpperCase();
  const position = String(player.position ?? "").toUpperCase();
  if (level === "AAA" && Number(player.performance_score) >= 65) return position.includes("P") ? "AAA Heat Check" : "AAA Heat Check";
  if (String(player.injury_opening).toLowerCase() === "true") return "Injury Replacement";
  if (Number(player.opportunity_score) >= 70) return "Path Play";
  if (isOnFortyMan(player)) return "40-Man Candidate";
  if (player.market_signal && player.market_signal !== "Cached Market Data") return "Card Sleeper";
  if (isTop100Prospect(player)) return "Top 100 Watch";
  return "Path Play";
}

function cardBaselineLabel(player) {
  const playerId = String(player.player_id ?? "");
  if (state.liveMarketRequests.has(playerId)) return "Loading...";
  if (state.liveMarketErrors.has(playerId)) return "Market data unavailable";
  const current = boardCardPrice(player);
  if (Number.isFinite(current)) return currency(current);
  const baseline = positiveMoneyField(player, ["baseline_value", "latest_value"]);
  if (Number.isFinite(baseline)) return currency(baseline);
  const code = fieldValue(player, ["card_code", "benchmarkCardCode", "benchmark_card_code"], "");
  if (code) return code;
  return player.market_signal ? "Market pending" : "Pending";
}

function entryLabel(player) {
  const target = targetEntryPrice(player);
  return Number.isFinite(target) ? currency(target) : "-";
}

function actionableEntryLabel(player) {
  const current = currentCardPrice(player);
  if (!Number.isFinite(current)) return "Need comps";
  if (lowPriceConfidence(player)) return "Watch only";
  const target = targetEntryPrice(player);
  if (!Number.isFinite(target)) return "Need comps";
  if (current > target) return `Wait <${currency(target)}`;
  return `${entryActionVerb(player)} <${currency(target)}`;
}

function currentCardPrice(player) {
  return positiveMoneyField(player, [
    "market_last_sold_price",
    "last_sold_price",
    "lastSoldPrice",
    "last_sale",
    "market_avg_price_30d",
    "avg_sold_price_30d",
    "avgSoldPrice30d",
    "avg_30",
    "thirty_day_avg",
    "market_avg_price_90d",
    "avg_sold_price_90d",
    "avgSoldPrice90d",
    "avg_90",
    "ninety_day_avg",
  ]);
}

function boardCardPrice(player) {
  const avg30 = positiveMoneyField(player, [
    "market_avg_price_30d",
    "avg_sold_price_30d",
    "avgSoldPrice30d",
    "avg_30",
    "thirty_day_avg",
  ]);
  if (Number.isFinite(avg30)) return avg30;
  return currentCardPrice(player);
}

function targetEntryPrice(player) {
  const directHigh = positiveMoneyField(player, ["buy_high", "entry_high", "target_high"]);
  if (Number.isFinite(directHigh)) return directHigh;
  const avg30 = positiveMoneyField(player, ["market_avg_price_30d", "avg_sold_price_30d", "avgSoldPrice30d", "avg_30", "thirty_day_avg"]);
  const avg90 = positiveMoneyField(player, ["market_avg_price_90d", "avg_sold_price_90d", "avgSoldPrice90d", "avg_90", "ninety_day_avg"]);
  const current = currentCardPrice(player);
  if (!Number.isFinite(current)) return NaN;
  const market = boardMarketRead(player).toLowerCase();
  const action = boardBuyZone(player).toLowerCase();
  if (market.includes("down") || market.includes("cooling") || action.includes("avoid")) return Math.min(current * 0.86, Number.isFinite(avg90) ? avg90 * 0.92 : current * 0.86);
  if (action.includes("strong") || market.includes("up")) return (Number.isFinite(avg30) ? avg30 : current) * 1.03;
  if (Number.isFinite(avg30) && Number.isFinite(avg90)) return Math.min(avg30 * 0.97, avg90 * 1.02);
  if (Number.isFinite(avg30)) return avg30 * 0.97;
  return current * 0.94;
}

function entryActionVerb(player) {
  const score = Number(boardMoveScore(player));
  const price = currentCardPrice(player);
  const market = boardMarketRead(player).toLowerCase();
  const action = boardBuyZone(player).toLowerCase();
  const movement = boardMovementValue(player);
  if (Number.isFinite(price) && price < 20) return "Auction Target";
  if (action.includes("strong") || score >= 90) return "Buy";
  if (movement > 0 || market.includes("up")) return "Accumulate";
  if (market.includes("stable")) return "Target";
  return "Buy Dips";
}

function lowPriceConfidence(player) {
  const market = boardMarketRead(player).toLowerCase();
  if (market.includes("thin") || market.includes("no liquidity")) return true;
  const sales30 = numericField(player, ["market_sales_count_30d", "sales_count_30d", "salesCount30d", "sales_30"]);
  const sales90 = numericField(player, ["market_sales_count_90d", "sales_count_90d", "salesCount90d", "sales_90"]);
  const sellThrough30 = numericField(player, ["market_sell_through_30d", "sell_through_30d", "sellThrough30d", "sell_thru_rate_30d"]);
  const sellThrough90 = numericField(player, ["market_sell_through_90d", "sell_through_90d", "sellThrough90d", "sell_thru_rate_90d"]);
  if (Number.isFinite(sellThrough30) && sellThrough30 > 0 && sellThrough30 < 15) return true;
  if (Number.isFinite(sellThrough90) && sellThrough90 > 0 && sellThrough90 < 20) return true;
  if (Number.isFinite(sales30) && sales30 >= 3) return false;
  if (Number.isFinite(sales90) && sales90 >= 8) return false;
  if (Number.isFinite(sellThrough30) && sellThrough30 >= 30) return false;
  if (Number.isFinite(sellThrough90) && sellThrough90 >= 35) return false;
  return true;
}

function hasValidBowmanAutoMarket(player) {
  const code = fieldValue(player, ["card_code", "benchmarkCardCode", "benchmark_card_code"], "");
  const cardName = fieldValue(player, ["card_name", "canonicalQuery", "card_query"], "");
  const hasCard = isValidCardCode(code) || /bowman|chrome|auto/i.test(cardName);
  return Boolean(hasCard) && Number.isFinite(currentCardPrice(player));
}

function isValidCardCode(value) {
  const text = String(value || "").trim().toLowerCase();
  return Boolean(text) && !["no card", "n/a", "na", "none", "pending"].includes(text);
}

function hasPositiveBaseballSignal(player) {
  const score = Number(boardMoveScore(player));
  const movement = boardMovementValue(player);
  const ops = Number(player.hitter_ops || player.ops);
  const recentOps = Number(player.last_14_ops || player.last_30_ops || player.recent_ops);
  const era = Number(player.pitcher_era || player.era);
  const kMinusBb = Number(player.pitcher_k_minus_bb_pct || player.k_minus_bb_pct);
  const level = String(player.level || "").toUpperCase();
  if (Number.isFinite(score) && score >= 82) return true;
  if (movement > 0) return true;
  if (Number.isFinite(ops) && ops >= 0.82) return true;
  if (Number.isFinite(recentOps) && recentOps >= 0.86) return true;
  if (Number.isFinite(era) && era <= 3.75) return true;
  if (Number.isFinite(kMinusBb) && kMinusBb >= 18) return true;
  return level === "AAA" && Number(player.callup_score) >= 65;
}

function isActionableOnDeckTarget(player) {
  if (!hasValidBowmanAutoMarket(player)) return false;
  if (lowPriceConfidence(player)) return false;
  if (!hasPositiveBaseballSignal(player)) return false;
  const score = Number(boardMoveScore(player));
  if (!Number.isFinite(score) || score < 80) return false;
  if (investmentScore(player) < 72) return false;
  if (moonshotRating(player) < 3) return false;
  const market = boardMarketRead(player).toLowerCase();
  const current = currentCardPrice(player);
  const target = targetEntryPrice(player);
  if (market.includes("no liquidity") || market.includes("avoid")) return false;
  if (market.includes("cooling") && Number.isFinite(target) && Number.isFinite(current) && current > target * 1.18) return false;
  return true;
}

function latestCardValue(player) {
  const last = numericMoney(player.last_sale);
  if (Number.isFinite(last)) return currency(last);
  const latest = numericMoney(player.latest_value);
  if (Number.isFinite(latest)) return currency(latest);
  return cardBaselineLabel(player);
}

function marketStatus(player) {
  const playerId = String(player.player_id ?? "");
  if (state.liveMarketRequests.has(playerId)) return "Loading";
  if (state.liveMarketErrors.has(playerId)) return "Market data unavailable";
  const signal = String(player.market_status || player.market_signal || "").toLowerCase();
  const shortTrend = shortWindowMarketMove(player);
  if (signal.includes("spiked")) return "Spiked";
  if (shortTrend >= 8 || signal.includes("strong") || signal.includes("buy")) return "Moving Up";
  if (shortTrend <= -8) return "Cooling";
  if (signal.includes("watch")) return "Early Entry";
  if (signal.includes("flat")) return "Stable";
  if (signal.includes("priced")) return "Priced In";
  if (signal.includes("illiquid")) return "Illiquid";
  if (Number.isFinite(sellThroughValue(player, 30)) || player.card_code) return "Liquidity Watch";
  return player.card_name || player.avg_30 ? "Early Entry" : "Market Pending";
}

function marketStatusClass(player) {
  const status = marketStatus(player).toLowerCase();
  if (status.includes("moving") || status.includes("early")) return "positive";
  if (status.includes("cooling") || status.includes("priced")) return "caution";
  if (status.includes("liquidity")) return "neutral";
  if (status.includes("illiquid") || status.includes("pending")) return "negative";
  return "neutral";
}

function shortWindowMarketMove(player) {
  const avg7 = numericMoney(player.avg_7);
  const avg30 = numericMoney(player.avg_30);
  if (Number.isFinite(avg7) && Number.isFinite(avg30) && avg30 > 0) {
    return ((avg7 - avg30) / avg30) * 100;
  }
  const avg14 = numericMoney(player.avg_14);
  if (Number.isFinite(avg14) && Number.isFinite(avg30) && avg30 > 0) {
    return ((avg14 - avg30) / avg30) * 100;
  }
  return 0;
}

function cardMarketScore(player) {
  return Math.max(0, Math.min(100, Math.round(marketScore(player))));
}

function playerPathRead(player, lane) {
  const blockers = blockerNames(player).slice(0, 3);
  if (blockers.length) {
    return `${player.player_name} is tracking behind ${blockers.join(", ")} with a ${player.callup_score}% move score.`;
  }
  return `${player.player_name} has a ${player.callup_score}% move score; named blockers still need more depth-chart data.`;
}

function marketPanel(player) {
  if (!hasMarketData(player)) {
    return `
      <section class="card-market-panel">
        <div class="panel-heading compact">
          <h3>Market Pulse</h3>
          <span>Market Data: Pending</span>
        </div>
        <p class="muted">No cached market snapshot is available for ${escapeHtml(player.player_name)} yet. Run Refresh Top 100 Market Data to collect sold comps, active listings, and calculated sell-thru rates.</p>
      </section>
    `;
  }

  return `
    <section class="card-market-panel">
      <div class="panel-heading compact">
        <h3>Market Pulse</h3>
        <span class="grade-pill ${marketGradeClass(player)}">${escapeHtml(marketGrade(player))}</span>
      </div>
      <div class="card-market-grid">
        ${marketMetricCells(player).map((cell) => `
          <div>
            <span>${escapeHtml(cell.label)}</span>
            <strong>${escapeHtml(cell.value)}</strong>
          </div>
        `).join("")}
      </div>
      <div class="market-source">
        <span>${escapeHtml(cardDescription(player))}</span>
        <button class="button ghost history-link" type="button" data-market-history>Historical Data</button>
      </div>
      ${canonicalSearchLabel(player) ? `<p class="market-query">Search: ${escapeHtml(canonicalSearchLabel(player))}</p>` : ""}
      <div class="market-readout ${marketStatusClass(player)}">
        <strong>${escapeHtml(marketStatus(player))}</strong>
        <span>${escapeHtml(marketStatusInsight(player))}</span>
        <span>${escapeHtml(liquidityInsight(player))}</span>
      </div>
      ${marketHistoryPanel(player)}
      ${player.market_note ? `<p>${escapeHtml(player.market_note)}</p>` : ""}
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

function marketMetricCells(player) {
  return [
    { label: "Last Sale", value: currencyOrPending(player.last_sale) },
    { label: "30D Sales", value: countOrPending(player.sales_30) },
    { label: "90D Sales", value: countOrPending(player.sales_90) },
    { label: "30D Avg", value: currencyOrPending(player.avg_30) },
    { label: "90D Avg", value: currencyOrPending(player.avg_90) },
    { label: "30D Median", value: currencyOrPending(player.median_30) },
    { label: "90D Median", value: currencyOrPending(player.median_90) },
    { label: "30D Range", value: marketRange(player.low_30, player.high_30) },
    { label: "90D Range", value: marketRange(player.low_90, player.high_90) },
    { label: "Active Listings", value: countOrPending(player.active_listings) },
    { label: "Active Low Ask", value: currencyOrPending(player.active_lowest_ask) },
    { label: "Active Median Ask", value: currencyOrPending(player.active_median_ask) },
    { label: "Active High Ask", value: currencyOrPending(player.active_highest_ask) },
    { label: "Active Auctions", value: countOrPending(player.active_auction_count) },
    { label: "Active BIN", value: countOrPending(player.active_buy_it_now_count) },
    { label: "OnDeck 30D Sell-Thru", value: sellThroughOrPending(player, 30) },
    { label: "OnDeck 90D Sell-Thru", value: sellThroughOrPending(player, 90) },
    { label: "30D Sellers", value: countOrPending(player.sellers_30) },
    { label: "90D Sellers", value: countOrPending(player.sellers_90) },
    { label: "Card Year", value: player.card_year || "Pending" },
    { label: "Sold Refresh", value: dateOrPending(player.sold_refreshed_at) },
    { label: "Active Refresh", value: dateOrPending(player.active_data_updated_at) },
    { label: "Card Grade", value: marketGrade(player) },
    { label: "Liquidity", value: liquidityGrade(player) },
    { label: "Market Read", value: marketStatus(player) },
    { label: "Buy Zone", value: buyZone(player) === "-" ? "Pending" : buyZone(player) },
  ];
}

function hasMarketData(player) {
  return [
    player.last_sale,
    player.avg_30,
    player.avg_90,
    player.sales_30,
    player.sales_90,
    player.active_listings,
    player.checked_at,
    player.card_code,
    player.card_query,
    player.sell_through_30,
    player.sell_through_90,
    player.sellers_30,
    player.sellers_90,
    player.card_year,
  ].some((value) => value !== "" && value != null);
}

function canonicalSearchLabel(player) {
  return player.canonical_query || player.card_query || "";
}

function marketRange(low, high) {
  const lowLabel = currency(low);
  const highLabel = currency(high);
  if (lowLabel === "-" && highLabel === "-") return "Pending";
  return `${lowLabel === "-" ? "?" : lowLabel} - ${highLabel === "-" ? "?" : highLabel}`;
}

function marketHistoryPanel(player) {
  const playerId = String(player.player_id);
  if (state.marketHistoryRequests.has(playerId)) {
    return `<div class="market-history-panel"><p class="muted">Loading historical sales...</p></div>`;
  }
  const error = state.marketHistoryErrors.get(playerId);
  if (error) {
    return `<div class="market-history-panel"><p class="muted">${escapeHtml(error)}</p></div>`;
  }
  const history = state.marketHistoryData.get(playerId);
  if (!history) return "";
  const points = Array.isArray(history.points) ? history.points : [];
  if (!points.length) {
    return `<div class="market-history-panel"><p class="muted">No historical sales rows are loaded for this player yet.</p></div>`;
  }
  return `
    <div class="market-history-panel">
      <div class="panel-heading compact">
        <h3>Price History</h3>
        <span>${escapeHtml(points.length)} sale dates</span>
      </div>
      ${marketHistoryChart(points)}
      <div class="market-history-summary">
        <span>Avg ${currency(history.summary?.avg_price)}</span>
        <span>Sales ${countValue(history.summary?.sales_count)}</span>
        <span>${escapeHtml(formatShortDate(history.summary?.first_sale_date))} - ${escapeHtml(formatShortDate(history.summary?.last_sale_date))}</span>
      </div>
    </div>
  `;
}

function marketHistoryChart(points) {
  const prices = points.map((point) => numericMoney(point.avg_price)).filter(Number.isFinite);
  const counts = points.map((point) => Number(point.sales_count)).filter(Number.isFinite);
  if (prices.length < 2) {
    return `<p class="muted">At least two historical dates are needed for a chart.</p>`;
  }
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  const maxSales = Math.max(1, ...counts);
  const width = 640;
  const height = 230;
  const pad = { top: 16, right: 18, bottom: 30, left: 48 };
  const chartWidth = width - pad.left - pad.right;
  const chartHeight = height - pad.top - pad.bottom;
  const priceRange = maxPrice - minPrice || 1;
  const plotted = points.map((point, index) => {
    const x = pad.left + (index / Math.max(1, points.length - 1)) * chartWidth;
    const price = numericMoney(point.avg_price);
    const sales = Number(point.sales_count) || 0;
    const y = pad.top + (1 - ((price - minPrice) / priceRange)) * chartHeight;
    const barHeight = (sales / maxSales) * chartHeight;
    return {
      x,
      y,
      sales,
      barHeight,
      date: point.sale_date,
      price,
    };
  });
  const line = plotted.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
  const barWidth = Math.max(3, Math.min(16, chartWidth / points.length - 2));
  const bars = plotted.map((point) => `
    <rect x="${(point.x - barWidth / 2).toFixed(1)}" y="${(pad.top + chartHeight - point.barHeight).toFixed(1)}" width="${barWidth.toFixed(1)}" height="${point.barHeight.toFixed(1)}">
      <title>${escapeHtml(point.date)} · ${escapeHtml(currency(point.price))} · ${escapeHtml(point.sales)} sales</title>
    </rect>
  `).join("");
  const circles = plotted.map((point) => `
    <circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="3.5">
      <title>${escapeHtml(point.date)} · ${escapeHtml(currency(point.price))}</title>
    </circle>
  `).join("");

  return `
    <svg class="history-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Historical card price and sales chart">
      <line class="axis" x1="${pad.left}" y1="${pad.top + chartHeight}" x2="${width - pad.right}" y2="${pad.top + chartHeight}" />
      <line class="axis" x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${pad.top + chartHeight}" />
      <text x="${pad.left}" y="${height - 8}">${escapeHtml(formatShortDate(points[0].sale_date))}</text>
      <text x="${width - pad.right}" y="${height - 8}" text-anchor="end">${escapeHtml(formatShortDate(points.at(-1).sale_date))}</text>
      <text x="8" y="${pad.top + 6}">${escapeHtml(currency(maxPrice))}</text>
      <text x="8" y="${pad.top + chartHeight}">${escapeHtml(currency(minPrice))}</text>
      <g class="history-bars">${bars}</g>
      <polyline class="history-line" points="${line}" />
      <g class="history-points">${circles}</g>
    </svg>
  `;
}

function recommendationLabel(player) {
  return marketGrade(player);
}

function marketGrade(player) {
  const score = cardMarketScore(player) + liquidityScoreAdjustment(player);
  if (score >= 70) return "A";
  if (score >= 55) return "B";
  if (score >= 40) return "C";
  if (score >= 25) return "D";
  return "F";
}

function marketGradeClass(player) {
  const grade = marketGrade(player);
  if (grade === "A" || grade === "B") return "grade-strong";
  if (grade === "C") return "grade-watch";
  return "grade-risk";
}

function liquidityGrade(player) {
  const value = sellThroughValue(player, 30);
  if (!Number.isFinite(value)) return "N/A";
  if (value >= 70) return "A";
  if (value >= 50) return "B";
  if (value >= 30) return "C";
  if (value >= 15) return "D";
  return "F";
}

function liquidityScoreAdjustment(player) {
  const value = sellThroughValue(player, 30);
  if (!Number.isFinite(value)) return 0;
  if (value >= 70) return 10;
  if (value >= 50) return 5;
  if (value >= 30) return 0;
  if (value >= 15) return -7;
  return -14;
}

function sellThroughValue(player, days = 30) {
  const field = days === 90 ? player.sell_through_90 : player.sell_through_30;
  const explicit = percentNumber(field);
  if (Number.isFinite(explicit)) return explicit;
  if (days === 30) {
    const fallback = percentNumber(player.sell_through);
    if (Number.isFinite(fallback)) return fallback;
  }
  return NaN;
}

function percentNumber(value) {
  if (value === "" || value == null) return NaN;
  const numeric = Number(String(value).replaceAll(/[^0-9.-]/g, ""));
  return Number.isFinite(numeric) ? numeric : NaN;
}

function marketStatusInsight(player) {
  const status = marketStatus(player);
  if (status === "Early Entry") {
    return "The market has comps, but the move has not fully shown up in short-window pricing yet.";
  }
  if (status === "Moving Up") {
    return "Recent sales are running above the 30-day baseline, so demand is already lifting.";
  }
  if (status === "Cooling") {
    return "Recent sales are below the 30-day baseline, so patience matters unless the baseball catalyst strengthens.";
  }
  if (status === "Priced In") {
    return "The card has already reacted; upside now needs a bigger baseball catalyst.";
  }
  if (status === "Stable") {
    return "Pricing is steady. The grade depends more on path, volume, and current player momentum.";
  }
  if (status === "Spiked") {
    return "The card has already jumped. Treat the grade as a heat check, not a hidden entry.";
  }
  if (status === "Illiquid") {
    return "Sales volume is thin, so one comp can distort the read.";
  }
  if (status === "Liquidity Watch") {
    return "The benchmark card is loaded and liquidity is available; sold-price comps will sharpen the grade on the next refresh.";
  }
  if (status === "Market Pending") {
    return "No cached market snapshot is available yet. Run the Top 100 market refresh to fill this profile.";
  }
  return "Current sales data is incomplete.";
}

function liquidityInsight(player) {
  const value30 = sellThroughValue(player, 30);
  const value90 = sellThroughValue(player, 90);
  if (!Number.isFinite(value30)) return "Liquidity data is not loaded yet.";
  if (Number.isFinite(value90) && value30 >= value90 + 10) {
    return `Liquidity is heating up: 30-day sell-through is ${value30.toFixed(1)}% versus ${value90.toFixed(1)}% over 90 days.`;
  }
  if (Number.isFinite(value90) && value30 <= value90 - 10) {
    return `Liquidity is cooling: 30-day sell-through is ${value30.toFixed(1)}% versus ${value90.toFixed(1)}% over 90 days.`;
  }
  if (value30 >= 70) return `Liquidity is strong at ${value30.toFixed(1)}%; similar listings are clearing quickly.`;
  if (value30 >= 50) return `Liquidity is healthy at ${value30.toFixed(1)}%; buyers are still absorbing supply.`;
  if (value30 >= 30) return `Liquidity is average at ${value30.toFixed(1)}%; entry price matters.`;
  return `Liquidity is weak at ${value30.toFixed(1)}%; the risk is getting stuck with inventory.`;
}

function cardDescription(player) {
  const name = player.card_name || player.card_query || "Bowman Chrome Auto";
  return [player.card_year, name, player.card_code].filter(Boolean).join(" · ") || "Bowman Chrome Prospect Auto";
}

function formatShortDate(value) {
  if (!value) return "";
  const text = String(value);
  const date = new Date(text.includes("T") ? text : `${text}T00:00:00`);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "2-digit" });
}

function marketReasonBullets(player) {
  const reasons = [];
  const last = numericMoney(player.last_sale);
  const avg30 = numericMoney(player.avg_30);
  const avg14 = numericMoney(player.avg_14);
  const avg7 = numericMoney(player.avg_7);
  const movement = rankMovement(player);

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

  if (Number.isFinite(avg7) && Number.isFinite(avg30) && avg30 > 0) {
    const shortMove = ((avg7 - avg30) / avg30) * 100;
    if (shortMove >= 8) {
      reasons.push(`The 7-day average is ${Math.round(shortMove)}% above the 30-day average, showing short-window demand is heating up.`);
    } else if (shortMove <= -8) {
      reasons.push(`The 7-day average is ${Math.abs(Math.round(shortMove))}% below the 30-day average, so short-window pricing is cooling.`);
    } else {
      reasons.push("The 7-day average is close to the 30-day average, so the market is not separating sharply in either direction.");
    }
  }

  if (Number.isFinite(avg14) && Number.isFinite(avg30) && avg30 > 0 && !Number.isFinite(avg7)) {
    const midMove = ((avg14 - avg30) / avg30) * 100;
    reasons.push(`The 14-day average is ${Math.round(midMove)}% ${midMove >= 0 ? "above" : "below"} the 30-day average.`);
  }

  const sales30 = Number(player.sales_30);
  if (Number.isFinite(sales30)) {
    if (sales30 >= 30) {
      reasons.push(`${Math.round(sales30)} sales over 30 days gives the comp base enough volume to trust the range.`);
    } else if (sales30 > 0) {
      reasons.push(`${Math.round(sales30)} sales over 30 days is a thinner market, so one sale can move the read quickly.`);
    }
  }

  const liquidity = liquidityGrade(player);
  if (liquidity !== "N/A") {
    reasons.push(`Liquidity grade is ${liquidity}. ${liquidityInsight(player)}`);
  }

  if (movement != null) {
    if (movement < 0) {
      reasons.push(`Top 100 rank is down ${Math.abs(movement)} spots, so the buy case needs the current stats and discount to outweigh ranking pressure.`);
    } else if (movement > 0) {
      reasons.push(`Top 100 rank is up ${movement} spots, adding prospect-hype momentum to the card signal.`);
    } else {
      reasons.push("Top 100 rank is flat, so the card signal leans more on price, stats, and organizational path.");
    }
  }

  reasons.push(`${player.callup_score}% move score keeps the card grade tied to a baseball event, not just raw card comps.`);
  reasons.push(`Card grade: ${marketGrade(player)}. ${marketStatusInsight(player)}`);
  return reasons;
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

function onDeckCatalyst(player) {
  if (String(player.level ?? "").toUpperCase() === "MLB") return "MLB Debut Follow-Up";
  const level = String(player.level ?? "").toUpperCase();
  if (level === "AA") return "Triple-A Promotion";
  if (level === "AAA") return "MLB Debut";
  if (level === "A+" || level === "A") return "Double-A Promotion";
  const movement = rankMovement(player);
  if (movement != null && movement > 0) return "Top 100 Momentum";
  return "Breakout Watch";
}

function onDeckThesis(player) {
  const catalyst = onDeckCatalyst(player);
  const market = onDeckMarketMemo(player);
  const stat = onDeckStatMemo(player);
  const level = fieldValue(player, ["level", "stat_level"], "");
  const position = fieldValue(player, ["position"], "");
  const source = String(fieldValue(player, ["source_board", "sourceBoard", "board_type"], "")).toLowerCase();
  const movement = rankMovement(player);
  const role = isPitcherPosition(position) ? "arm" : "bat";
  const levelLabel = level ? `${level} ${role}` : role;

  if (source.includes("emerging") || source.includes("watch")) {
    const pieces = [stat, market].filter(Boolean);
    if (pieces.length) return `${player.player_name} is an ${levelLabel} with ${pieces.join("; ")}. ${catalyst} is the next proof point.`;
    return `${player.player_name} is on the feeder board because the move score is separating before the wider prospect market has a full read.`;
  }

  if (catalyst === "MLB Debut") {
    return `${player.player_name} is close enough to force a major-league roster decision${stat ? ` while carrying ${stat}` : ""}${market ? `; ${market}` : ""}.`;
  }
  if (market || stat) {
    return `${player.player_name}'s ${catalyst.toLowerCase()} case is built on ${[stat, market].filter(Boolean).join(" and ")}.`;
  }
  if (movement != null && movement > 0) {
    return `${player.player_name} has moved up ${movement} spots in the rankings, keeping the next baseball catalyst on the board.`;
  }
  return `${player.player_name}'s current profile still needs either a cleaner market read or a sharper performance signal before the case gets louder.`;
}

function onDeckQuickThesis(player) {
  const label = marketSetupLabel(player);
  const facts = marketFactParts(player);
  const factText = facts.length ? facts.join("; ") : "market data supports a current actionable read";
  if (label === "Undervalued") return `${factText}; price has room versus recent comps.`;
  if (label === "Breakout Watch") return `${factText}; baseball signal is improving before the next attention spike.`;
  if (label === "Early Sleeper") return `${factText}; good opportunity to accumulate before a wider breakout.`;
  if (label === "Market Chasing") return `${factText}; demand is already moving, keep buys disciplined.`;
  if (label === "Fair Value") return `${factText}; price looks aligned with current demand.`;
  return `${factText}.`;
}

function marketSetupLabel(player) {
  const market = boardMarketRead(player).toLowerCase();
  const action = boardBuyZone(player).toLowerCase();
  const source = String(fieldValue(player, ["source_board", "sourceBoard", "board_type"], "")).toLowerCase();
  const score = Number(boardMoveScore(player));
  const current = currentCardPrice(player);
  const avg30 = positiveMoneyField(player, ["market_avg_price_30d", "avg_sold_price_30d", "avgSoldPrice30d", "avg_30", "thirty_day_avg"]);
  const avg90 = positiveMoneyField(player, ["market_avg_price_90d", "avg_sold_price_90d", "avgSoldPrice90d", "avg_90", "ninety_day_avg"]);
  const sales30 = numericField(player, ["market_sales_count_30d", "sales_count_30d", "salesCount30d", "sales_30"]);
  const ops = Number(player.hitter_ops || player.ops);
  const era = Number(player.pitcher_era || player.era);
  const movement = rankMovement(player);

  if (!Number.isFinite(current)) return "No Comps";
  if (lowPriceConfidence(player)) return "Illiquid Risk";
  if (market.includes("down") || market.includes("cooling") || action.includes("avoid")) return "Cooling";
  if (Number.isFinite(avg30) && Number.isFinite(avg90) && avg90 > 0 && avg30 > avg90 * 1.12) return "Market Chasing";
  if (Number.isFinite(avg30) && Number.isFinite(avg90) && avg90 > 0 && avg30 < avg90 * 0.92) return "Undervalued";
  if (market.includes("no liquidity")) return "Illiquid Risk";
  if (source.includes("emerging") || source.includes("watch")) {
    if ((Number.isFinite(ops) && ops >= 0.9) || (Number.isFinite(era) && era <= 3.25)) return "Breakout Watch";
    if (Number.isFinite(sales30) && sales30 >= 10 && Number.isFinite(score) && score >= 84) return "Early Sleeper";
    return "Early Sleeper";
  }
  if (Number.isFinite(movement) && movement > 0) return "Breakout Watch";
  if (Number.isFinite(score) && score >= 88 && Number.isFinite(sales30) && sales30 >= 8) return "Undervalued";
  return "Fair Value";
}

function marketFactParts(player) {
  const parts = [];
  const current = currentCardPrice(player);
  const avg30 = positiveMoneyField(player, ["market_avg_price_30d", "avg_sold_price_30d", "avgSoldPrice30d", "avg_30", "thirty_day_avg"]);
  const avg90 = positiveMoneyField(player, ["market_avg_price_90d", "avg_sold_price_90d", "avgSoldPrice90d", "avg_90", "ninety_day_avg"]);
  const sales30 = numericField(player, ["market_sales_count_30d", "sales_count_30d", "salesCount30d", "sales_30"]);
  const sales90 = numericField(player, ["market_sales_count_90d", "sales_count_90d", "salesCount90d", "sales_90"]);
  const movement = boardMovementValue(player);
  const ops = Number(player.hitter_ops || player.ops);
  const era = Number(player.pitcher_era || player.era);

  if (Number.isFinite(current)) parts.push(`${currency(current)} current comp`);
  if (Number.isFinite(sales30) && sales30 > 0) parts.push(`${Math.round(sales30)} sales in 30D`);
  else if (Number.isFinite(sales90) && sales90 > 0) parts.push(`${Math.round(sales90)} sales in 90D`);

  if (Number.isFinite(avg30) && Number.isFinite(avg90) && avg90 > 0) {
    const priceMove = ((avg30 - avg90) / avg90) * 100;
    if (priceMove >= 8) parts.push(`price up ${Math.round(priceMove)}% vs 90D`);
    else if (priceMove <= -8) parts.push(`price down ${Math.abs(Math.round(priceMove))}% vs 90D`);
    else parts.push("price steady vs 90D");
  }

  if (movement > 0) parts.push(`movement signal +${Math.round(movement)}`);
  if (Number.isFinite(ops) && ops >= 0.9) parts.push(`${formatStatDecimal(ops)} OPS`);
  if (Number.isFinite(era) && era <= 3.25) parts.push(`${formatEraValue(era)} ERA`);
  return parts.slice(0, 3);
}

function onDeckStatMemo(player) {
  if (isPitcherPosition(player.position)) {
    const era = statValue(player.pitcher_era || player.era);
    const whip = statValue(player.pitcher_whip || player.whip);
    const strikeouts = countValue(player.pitcher_so || player.so || player.k);
    if (era !== "-" && whip !== "-") return `${era} ERA and ${whip} WHIP`;
    if (era !== "-") return `${era} ERA`;
    if (strikeouts !== "-") return `${strikeouts} strikeouts`;
    return "";
  }

  const avg = statValue(player.hitter_avg || player.avg);
  const ops = statValue(player.hitter_ops || player.ops);
  const hr = countValue(player.hitter_hr || player.hr);
  if (ops !== "-" && avg !== "-") return `${avg} AVG / ${ops} OPS`;
  if (ops !== "-") return `${ops} OPS`;
  if (avg !== "-") return `${avg} AVG`;
  if (hr !== "-") return `${hr} HR power signal`;
  return "";
}

function onDeckMarketMemo(player) {
  const sales30 = numericField(player, ["market_sales_count_30d", "sales_count_30d", "salesCount30d", "sales_30"]);
  const avg30 = positiveMoneyField(player, ["market_avg_price_30d", "avg_sold_price_30d", "avgSoldPrice30d", "avg_30", "thirty_day_avg"]);
  const avg90 = positiveMoneyField(player, ["market_avg_price_90d", "avg_sold_price_90d", "avgSoldPrice90d", "avg_90", "ninety_day_avg"]);
  const marketRead = boardMarketRead(player);

  const volume = Number.isFinite(sales30) && sales30 > 0 ? `${Math.round(sales30)} clean 30D sales` : "";
  const price = Number.isFinite(avg30) ? `${currency(avg30)} 30D avg` : "";
  const trend = Number.isFinite(avg30) && Number.isFinite(avg90) && avg90 > 0
    ? ((avg30 - avg90) / avg90) * 100
    : NaN;

  if (Number.isFinite(trend) && Math.abs(trend) >= 8) {
    const direction = trend > 0 ? "up" : "down";
    return [volume, price, `market ${direction} ${Math.abs(trend).toFixed(0)}% vs 90D`].filter(Boolean).join(", ");
  }
  if (volume || price) return [volume, price, marketRead && !/need|pending/i.test(marketRead) ? marketRead.toLowerCase() : ""].filter(Boolean).join(", ");
  return "";
}

function watchThesis(player) {
  const trend = rankTrendText(player);
  const trendText = trend === "Untracked" ? "rank movement is not established yet" : `rank movement is ${trend.toLowerCase()}`;
  return `${player.player_name} is working at ${player.level || "an unlisted level"} with ${onDeckCatalyst(player).toLowerCase()} as the next move. ${trendText}, and the current path/readiness/performance blend supports a ${player.callup_score}% move score.`;
}

function whyItMatters(player) {
  const role = depthChartGroup(player.position).toLowerCase();
  return `${player.org} has to decide how aggressively to move this ${role} profile. ${player.player_name}'s next jump depends on current production, level fit, and the MLB names directly ahead of him.`;
}

function riskFactors(player) {
  const risks = [];
  const blockers = blockerNames(player).slice(0, 3);
  if (blockers.length) risks.push(`Depth chart pressure from ${blockers.join(", ")}.`);
  if (Number(player.readiness_score) < 55) risks.push("Readiness score suggests the organization may want more development time.");
  if (Number(player.performance_score) < 55) risks.push("Current statistical form needs to strengthen before the catalyst becomes urgent.");
  if (rankMovement(player) != null && rankMovement(player) < 0) risks.push("Recent Top 100 trend is negative, which can cool public and hobby momentum.");
  if (!risks.length) risks.push("Primary risk is timing: the catalyst may be real but slower than the market wants.");
  return risks;
}

function analystVerdict(player) {
  return `${player.player_name}'s current case centers on ${catalystSentenceText(player)}. If the production holds and the organizational lane opens, the next move can happen quickly; if the assignment stalls, the timeline likely pushes back.`;
}

function catalystSentenceText(player) {
  return onDeckCatalyst(player).replace("MLB", "MLB").toLowerCase().replace("mlb", "MLB");
}

function toolSummary(player) {
  const position = String(player.position ?? "").toUpperCase();
  if (position.includes("P")) return "Arsenal, command, role fit";
  if (position.includes("C")) return "Power, defense, patience";
  if (position.includes("SS") || position.includes("2B") || position.includes("3B")) return "Athleticism, contact, defensive value";
  return "Power, approach, athleticism";
}

function scoutingStrengths(player) {
  const position = String(player.position ?? "").toUpperCase();
  const trend = rankTrendText(player);
  if (position.includes("P")) return "The profile is driven by run-prevention upside, miss-bat potential, and how quickly the arsenal can translate against upper-level hitters.";
  if (trend.startsWith("Up")) return "Ranking movement is positive, suggesting evaluators are already reacting to growth in performance, tools, or role confidence.";
  return "The carrying strength is the combination of prospect pedigree, current assignment, and a visible organizational runway.";
}

function developmentFocus(player) {
  const position = String(player.position ?? "").toUpperCase();
  if (position.includes("P")) return "Command consistency, workload management, and proving the arsenal holds up through a starter's turn remain the key checkpoints.";
  if (Number(player.performance_score) < 55) return "The next step is converting tools into steadier game production so the catalyst is backed by performance, not projection alone.";
  return "The focus is sustaining current form long enough for the organization to justify the next assignment.";
}

function profileResearchReport(player) {
  return `
    <section class="analyst-report">
      <h3>Why He Is OnDeck</h3>
      <p>${escapeHtml(watchThesis(player))}</p>
      <div class="report-catalyst">
        <span>Next move</span>
        <strong>${escapeHtml(onDeckCatalyst(player))}</strong>
      </div>
      <ul>${whyOnDeckBullets(player).map((bullet) => `<li>${escapeHtml(bullet)}</li>`).join("")}</ul>
      <h3>Risk Factors</h3>
      <ul>${riskFactors(player).map((risk) => `<li>${escapeHtml(risk)}</li>`).join("")}</ul>
      <h3>Analyst Verdict</h3>
      <p>${escapeHtml(analystVerdict(player))}</p>
    </section>
  `;
}

function graduationTimelinePanel(player) {
  const date = formatShortDate(player.graduatedDate || player.graduated_date) || "Graduated";
  return `
    <section class="graduation-timeline">
      <h3>Timeline</h3>
      <div>
        <span>${escapeHtml(date)}</span>
        <p>${escapeHtml(player.timeline_event_graduated || graduationTimelineMessage())}</p>
      </div>
    </section>
  `;
}

function whyOnDeckBullets(player) {
  const bullets = [];
  if (Number(player.opportunity_score) >= 65) bullets.push("Organizational path is stronger than the average prospect on this board.");
  if (Number(player.readiness_score) >= 65) bullets.push(`${player.level || "Current level"} assignment and age point to near-term readiness.`);
  if (Number(player.performance_score) >= 65) bullets.push(recentFormRead(player));
  const blockers = blockerNames(player).slice(0, 2);
  if (blockers.length) bullets.push(`The current MLB lane runs through ${blockers.join(" and ")}.`);
  if (rankMovement(player) > 0) bullets.push(`Top 100 ranking momentum is positive: ${rankTrendText(player)}.`);
  if (player.market_signal) bullets.push(`Primary tracked card shows a ${marketStatus(player).toLowerCase()} market read.`);
  if (!bullets.length) bullets.push(`${player.player_name}'s board case is built around ${onDeckCatalyst(player).toLowerCase()} and organizational fit.`);
  return bullets;
}

function recentFormRead(player) {
  if (String(player.position ?? "").toUpperCase().includes("P")) {
    const era = player.last_30_era || player.era;
    return era ? `Recent run prevention is supporting the case, with a ${era} ERA marker in the loaded stat window.` : "Recent pitching form is supporting the next-move case.";
  }
  const ops = player.last_14_ops || player.last_30_ops || player.ops;
  return ops ? `Recent offensive form is supporting the case, with a ${ops} OPS marker in the loaded stat window.` : "Recent offensive form is supporting the next-move case.";
}

function scoutingSnapshotPanel(player) {
  const source = player.news_source || "Generated snapshot";
  const url = player.news_url || mlbProfileUrl(player) || player.source_url || "";
  const meta = [source, player.news_date].filter(Boolean).join(" · ");
  return `
    <section class="news-panel">
      <h3>MLB Snapshot</h3>
      <article>
        ${meta ? `<p class="news-meta">${escapeHtml(meta)}</p>` : ""}
        <div class="snapshot-grid">
          <div><span>Current Level</span><strong>${escapeHtml(player.level ?? "-")}</strong></div>
          <div><span>ETA</span><strong>${escapeHtml(player.eta ?? "-")}</strong></div>
          <div><span>Organization</span><strong>${escapeHtml(player.org ?? "-")}</strong></div>
          <div><span>Tools</span><strong>${escapeHtml(toolSummary(player))}</strong></div>
        </div>
        <h4>Scouting Strengths</h4>
        <p>${escapeHtml(scoutingStrengths(player))}</p>
        <h4>Development Focus</h4>
        <p>${escapeHtml(developmentFocus(player))}</p>
        <h4>Concise Report</h4>
        <p>${escapeHtml(player.news_note || fallbackProfileNote(player))}</p>
        ${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">Open source</a>` : ""}
      </article>
    </section>
  `;
}

function fallbackProfileNote(player) {
  const trend = rankTrendText(player);
  const trendText = trend === "Untracked" ? "rank movement is not tracked yet" : `rank trend is ${trend.toLowerCase()}`;
  const path = player.notes ? cleanShortNote(player.notes) : "the MLB path still needs more depth-chart context";
  return `${player.player_name} is a ${player.org} ${player.position} at ${player.level}; ${trendText}, and ${path}.`;
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
  const signal = String(player.market_signal).toLowerCase();
  const hasTrackedCard = Boolean(
    player.card_code
      || player.card_query
      || player.sell_through_30
      || player.sell_through_90
      || player.sellers_30
      || player.sellers_90,
  );
  if (!signal && !hasTrackedCard) return 0;
  const signalScore = signal
    ? signal.includes("strong")
      ? 35
      : signal.includes("buy")
        ? 25
        : signal.includes("watch")
          ? 12
          : 5
    : 10;
  const last = numericMoney(player.last_sale);
  const avg30 = numericMoney(player.avg_30);
  const discount = Number.isFinite(last) && Number.isFinite(avg30) && avg30 > 0 ? Math.max(-15, Math.min(25, ((avg30 - last) / avg30) * 100)) : 0;
  const liquidity = sellThroughValue(player, 30);
  const liquidityPoints = Number.isFinite(liquidity) ? liquidity * 0.45 : 0;
  return signalScore + liquidityPoints + discount + Number(player.callup_score || 0) * 0.15;
}

function buyZone(player) {
  if (player.buy_low || player.buy_high) {
    return [player.buy_low, player.buy_high].filter(Boolean).map(currency).join(" - ");
  }
  const avg30 = numericMoney(player.avg_30);
  if (!Number.isFinite(avg30)) return "-";
  return `${currency(avg30 * 0.92)} - ${currency(avg30 * 1.03)}`;
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

function countValue(value) {
  if (value === "" || value == null) return "-";
  const numeric = Number(value);
  return Number.isFinite(numeric) ? String(Math.round(numeric)) : escapeHtml(value);
}

function numericMoney(value) {
  const numeric = Number(String(value ?? "").replaceAll(/[^0-9.-]/g, ""));
  return Number.isFinite(numeric) ? numeric : NaN;
}

function sparkline(player) {
  const values = [player.avg_90, player.avg_30, player.avg_14, player.avg_7, player.last_sale].map(numericMoney).filter(Number.isFinite);
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
  const calledUp = String(player.called_up ?? "").toLowerCase();
  return hasMlbStatus(player) || calledUp === "true" || Boolean(player.mlb_debut_date);
}

function hasMlbStatus(player) {
  return String(player.level ?? player.current_level ?? "").toUpperCase() === "MLB";
}

function isGraduated(player) {
  return String(player.lifecycleStatus ?? player.lifecycle_status ?? "").toLowerCase() === "graduated"
    || String(player.graduated ?? "").toLowerCase() === "true";
}

function isOnFortyMan(player) {
  return String(player.on_40man ?? "").toLowerCase() === "true";
}

function isTop100Prospect(player) {
  if (isGraduated(player) || player.onTop100 === false || String(player.on_top100 ?? "").toLowerCase() === "false") return false;
  return String(player.prospect_source ?? "").toLowerCase().includes("top 100") || String(player.player_id ?? "").startsWith("mlb-top100-");
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
