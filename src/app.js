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
    loadOptionalCsv("./data/card-targets.csv?v=20260702-2"),
    loadOptionalCsv("./data/mlb-player-flags.csv?v=20260629-2"),
    loadOptionalCsv("./data/archive/scorebook/scorebook.csv?v=20260630-1"),
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
  renderTeamBoard();
  renderWarRoom();
  renderMarketBoard();
  renderRows(rows);
  renderTop100Rows();
  renderScorebook();
  renderGraduated();
  elements.rowCount.textContent = rows.length ? `Top ${rows.length}` : "No active Top 10 data loaded";
  const selected = state.selectedId ? state.allScored.find((player) => String(player.player_id) === String(state.selectedId)) : null;
  renderCard(selected);
  syncToolVisibility();
}

function getTop100Rows() {
  const topIds = new Set(onDeckPlayers().map((player) => String(player.player_id)));
  const bubbleIds = new Set(bubblePlayers().map((player) => String(player.player_id)));
  return state.allScored
    .filter(isTop100Prospect)
    .filter((player) => !isGraduated(player))
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

function onDeckPlayers() {
  return state.scored
    .slice()
    .sort((a, b) => b.callup_score - a.callup_score || b.opportunity_score - a.opportunity_score || Number(a.prospect_rank) - Number(b.prospect_rank))
    .slice(0, 10);
}

function isOnDeckBoardPlayer(player) {
  if (!player?.player_id) return false;
  const id = String(player.player_id);
  return onDeckPlayers().some((candidate) => String(candidate.player_id) === id);
}

function openPlayerProfile(playerId, options = {}) {
  if (!playerId) return;
  state.selectedId = String(playerId);
  render();
  if (options.scroll !== false) {
    document.querySelector("#prospects")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function getFilteredRows() {
  return onDeckPlayers().filter((player) => {
    const searchBlob = normalizeName(`${player.player_name ?? ""} ${player.org ?? ""} ${player.position ?? ""}`);
    const matchesSearch = state.filters.search === "" || searchBlob.includes(state.filters.search);
    const matchesOrg = state.filters.org === "all" || player.org === state.filters.org;
    const matchesScore = Number(player.callup_score) >= state.filters.minScore;
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
    };
  });
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
  const org = state.selectedOrg ?? bestBreakExposureOrg()?.name;
  if (!org) {
    elements.warRoomTitle.textContent = "Select a team";
    elements.warRoomSubtitle.textContent = "Click a team on the Break Value Board to map depth chart blockers and prospect paths.";
    elements.warRoomBoard.innerHTML = `<p class="muted">Pick a team above to open its Dugout board.</p>`;
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
  if (location.hash === "#break-board") {
    openTool("break", "#break-board", false);
  } else if (location.hash === "#dugout" || location.hash === "#war-room") {
    openTool("war", "#dugout", false);
    if (location.hash === "#war-room") {
      history.replaceState(null, "", "#dugout");
    }
  } else if (location.hash === "#scorebook") {
    openTool("scorebook", "#scorebook", false);
  } else if (location.hash === "#graduated") {
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
      ? route === "dashboard" && (href === location.hash || (href === "#top-10" && (!location.hash || location.hash === "#dashboard")))
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
        <h3>Dugout Read</h3>
        <span>${escapeHtml(team)}</span>
      </div>
      ${bestLane ? `<p><strong>${escapeHtml(bestLane.players[0].player_name)}</strong> is the clearest name to track in this Dugout because the current depth lane creates the next decision point. ${escapeHtml(calledUpText)}</p>` : `<p>No active prospect path is loaded for ${escapeHtml(team)} right now.</p>`}
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
  const tracked = onDeckPlayers().map(withLiveMarketData);
  const bubble = bubblePlayers();
  elements.marketCount.textContent = `Top ${tracked.length}`;
  if (!tracked.length) {
    elements.marketBoard.innerHTML = `<p class="muted">Load prospects to view the On Deck board.</p>`;
    return;
  }

  elements.marketBoard.innerHTML = `
    <div class="market-track">${tracked.map((player) => callupCardMarkup(player)).join("")}</div>
    <section class="bubble-board" aria-label="On the bubble">
      <div class="bubble-heading">
        <h3>On The Bubble</h3>
        <p>The next five names outside the Top 10, with the reason they missed.</p>
      </div>
      <div class="bubble-grid">
        ${bubble.map((player) => bubbleCardMarkup(player)).join("")}
      </div>
    </section>
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
  openPlayerProfile(card.dataset.playerId);
}

function scrollOnDeckBoard(direction) {
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
  const catalyst = onDeckCatalyst(player);
  const rank = top10Rank(player);
  return `
      <article class="market-card" role="button" tabindex="0" data-player-id="${escapeHtml(player.player_id)}">
        <div>
          <span class="market-label">#${escapeHtml(rank)} · ${escapeHtml(playerTypeBadge(player))}</span>
          <h3>${escapeHtml(player.player_name)}</h3>
          <p>${escapeHtml([player.org, player.level, player.position].filter(Boolean).join(" · "))} · MLB ETA ${escapeHtml(player.eta ?? "-")}</p>
        </div>
        <div class="market-price">
          <strong>${escapeHtml(player.callup_score)}%</strong>
          <span>Move Score</span>
        </div>
        <dl>
          <div><dt>Next Move</dt><dd>${escapeHtml(catalyst)}</dd></div>
          <div><dt>Card</dt><dd>${escapeHtml(cardBaselineLabel(player))}</dd></div>
          <div><dt>Market</dt><dd>${escapeHtml(marketStatus(player))}</dd></div>
        </dl>
        <p class="market-thesis">${escapeHtml(onDeckThesis(player))}</p>
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
    elements.rows.innerHTML = `<tr><td colspan="10" class="muted">No active Top 10 data loaded yet. Add players in the admin panel to publish the board.</td></tr>`;
    return;
  }

  elements.rows.innerHTML = rows
    .map((rowPlayer, index) => {
      const player = withLiveMarketData(rowPlayer);
      const selected = String(player.player_id) === String(state.selectedId) ? "selected" : "";
      return `
        <tr class="${selected}" data-player-id="${escapeHtml(player.player_id)}">
          <td><strong>${index + 1}</strong></td>
          <td>
            <span class="player-name">
              <strong>${escapeHtml(player.player_name)}</strong>
              <span>${escapeHtml(playerTypeBadge(player))} · Age ${escapeHtml(player.age ?? "-")}</span>
            </span>
          </td>
          <td>${escapeHtml(player.org ?? "-")}</td>
          <td>${escapeHtml(player.position ?? "-")}</td>
          <td>${escapeHtml(player.level ?? "-")}</td>
          <td><span class="score-pill ${scoreClass(player.callup_score)}">${player.callup_score}%</span></td>
          <td>${escapeHtml(onDeckCatalyst(player))}</td>
          <td>${escapeHtml(cardBaselineLabel(player))}</td>
          <td><span class="market-status ${marketStatusClass(player)}">${escapeHtml(marketStatus(player))}</span></td>
          <td><button class="button ghost row-profile-button" type="button">View</button></td>
        </tr>
      `;
    })
    .join("");

  elements.rows.querySelectorAll("tr[data-player-id]").forEach((row) => {
    row.addEventListener("click", (event) => {
      event.stopPropagation();
      openPlayerProfile(row.dataset.playerId, { scroll: false });
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
    elements.top100Rows.innerHTML = `<tr><td colspan="14" class="muted">No active MLB Top 100 players match the current filters.</td></tr>`;
    return;
  }

  elements.top100Rows.innerHTML = rows.map((rowPlayer) => {
    const player = withLiveMarketData(rowPlayer);
    const selected = String(player.player_id) === String(state.selectedId) ? "selected" : "";
    return `
      <tr class="${selected}" data-player-id="${escapeHtml(player.player_id)}">
        <td><strong>${escapeHtml(player.prospect_rank ?? "-")}</strong></td>
        <td>
          <span class="player-name">
            <strong>${escapeHtml(player.player_name)}</strong>
            <span>${escapeHtml(playerTypeBadge(player))} · Age ${escapeHtml(player.age ?? "-")}</span>
          </span>
        </td>
        <td>${escapeHtml(player.org ?? "-")}</td>
        <td>${escapeHtml(top100BenchmarkLabel(player))}</td>
        <td>${escapeHtml(countOrPending(player.sales_30))}</td>
        <td>${escapeHtml(countOrPending(player.sales_90))}</td>
        <td>${escapeHtml(currencyOrPending(player.avg_30))}</td>
        <td>${escapeHtml(currencyOrPending(player.avg_90))}</td>
        <td>${escapeHtml(countOrPending(player.active_listings))}</td>
        <td>${escapeHtml(sellThroughOrPending(player, 30))}</td>
        <td>${escapeHtml(sellThroughOrPending(player, 90))}</td>
        <td>${escapeHtml(dateOrPending(player.checked_at || player.last_updated))}</td>
        <td>${rankTrend(player)}</td>
        <td>${escapeHtml(top100ComparisonReason(player))}</td>
      </tr>
    `;
  }).join("");

  elements.top100Rows.querySelectorAll("tr[data-player-id]").forEach((row) => {
    row.addEventListener("click", (event) => {
      event.stopPropagation();
      openPlayerProfile(row.dataset.playerId, { scroll: false });
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
  if (isOnDeckBoardPlayer(player)) return `On Deck Top 10: ${onDeckCatalyst(player)}.`;
  const bubble = bubblePlayers().find((candidate) => String(candidate.player_id) === String(player.player_id));
  if (bubble) return bubbleMissReason(player);
  if (Number(player.opportunity_score) < 45) return "Path needs to open.";
  if (Number(player.performance_score) < 55) return "Current form needs to improve.";
  if (Number(player.readiness_score) < 55) return "Timeline is less immediate.";
  return "Behind the current Top 10 score cutoff.";
}

function renderScorebook() {
  if (!elements.scorebookBoard) return;
  const officialHits = state.scorebook.filter((entry) => normalizeName(entry.verdict) === "hit");
  const historical = state.scorebook.filter((entry) => normalizeName(entry.verdict) === "historical");
  const missed = state.scorebook.filter((entry) => normalizeName(entry.verdict) === "missed");
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
      ${scorebookMetric("Official hits", officialHits.length)}
      ${scorebookMetric("Pending Top 10", pending.length)}
      ${scorebookMetric("Historical examples", historical.length)}
      ${scorebookMetric("Missed", missed.length)}
    </div>
    ${scorebookTable("Official OnDeck Hits", officialHits, officialHitColumns())}
    ${pendingTable(pending)}
    ${scorebookTable("Historical Market Examples", historical, historicalColumns())}
  `;
  elements.scorebookBoard.querySelectorAll("tr[data-player-id]").forEach((row) => {
    row.addEventListener("click", (event) => {
      event.stopPropagation();
      openPlayerProfile(row.dataset.playerId);
      state.activeTool = "dashboard";
      history.pushState(null, "", "#top-10");
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
      history.pushState(null, "", "#top-10");
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

function pendingTable(rows) {
  if (!rows.length) {
    return `<section class="scorebook-section"><h3>Pending Top 10</h3><p class="muted">No active Top 10 data loaded yet.</p></section>`;
  }
  return `
    <section class="scorebook-section">
      <h3>Pending Top 10</h3>
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
  if (!player) {
    elements.contentGrid.classList.remove("profile-open");
    elements.cardPanel.hidden = true;
    elements.playerCard.className = "player-card empty";
    elements.playerCard.innerHTML = "<p>Select a player to review why he is on deck.</p>";
    return;
  }

  const profilePlayer = withLiveMarketData(player);
  elements.contentGrid.classList.add("profile-open");
  elements.cardPanel.hidden = false;
  elements.playerCard.className = "player-card";
  elements.playerCard.innerHTML = `
    <div class="card-title">
      <div>
        <p class="card-kicker">${escapeHtml(profilePlayer.org ?? "-")} · ${escapeHtml(profilePlayer.level ?? "-")} · ${escapeHtml(profilePlayer.position ?? "-")}</p>
        <h3>${escapeHtml(profilePlayer.player_name)}</h3>
        <p class="muted">Top 10 rank ${escapeHtml(top10Rank(profilePlayer))} · Prospect rank ${escapeHtml(profilePlayer.prospect_rank ?? "-")} · Age ${escapeHtml(profilePlayer.age ?? "-")} · ETA ${escapeHtml(profilePlayer.eta ?? "-")}</p>
      </div>
      <div class="profile-badges">
        ${isGraduated(profilePlayer) ? `<span class="graduate-badge">MLB Graduate</span>` : ""}
        <span class="score-pill ${scoreClass(profilePlayer.callup_score)}">${profilePlayer.callup_score}% move score</span>
      </div>
    </div>

    <div class="breakdown">
      ${bar("Path", profilePlayer.opportunity_score)}
      ${bar("Readiness", profilePlayer.readiness_score)}
      ${bar("Performance", profilePlayer.performance_score)}
      ${bar("Card Grade", cardMarketScore(profilePlayer))}
    </div>

    ${profileResearchReport(profilePlayer)}
    ${isGraduated(profilePlayer) ? graduationTimelinePanel(profilePlayer) : ""}
    ${profileStatsPanel(profilePlayer)}
    ${teamPathPanel(profilePlayer)}
    ${scoutingSnapshotPanel(profilePlayer)}
    ${isTop100Prospect(profilePlayer) || isOnDeckBoardPlayer(profilePlayer) || isGraduated(profilePlayer) || hasMarketData(profilePlayer) ? marketPanel(profilePlayer) : ""}
  `;

  attachProfileActions(profilePlayer);
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
    data_source: "D1 market snapshot",
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
  if (state.liveMarketErrors.has(playerId)) return "Market pending";
  const avg30 = numericMoney(player.avg_30);
  if (Number.isFinite(avg30)) return currency(avg30);
  const baseline = numericMoney(player.baseline_value);
  if (Number.isFinite(baseline)) return currency(baseline);
  return player.market_signal ? "Market pending" : "Pending";
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
  if (state.liveMarketErrors.has(playerId)) return "Market Pending";
  const signal = String(player.market_status || player.market_signal || "").toLowerCase();
  const shortTrend = shortWindowMarketMove(player);
  if (signal.includes("spiked")) return "Spiked";
  if (shortTrend >= 8 || signal.includes("strong") || signal.includes("buy")) return "Moving Up";
  if (shortTrend <= -8) return "Cooling";
  if (signal.includes("watch")) return "Early Entry";
  if (signal.includes("flat")) return "Stable";
  if (signal.includes("priced")) return "Priced In";
  if (signal.includes("illiquid")) return "Illiquid";
  return player.card_name || player.avg_30 ? "Early Entry" : "Market Pending";
}

function marketStatusClass(player) {
  const status = marketStatus(player).toLowerCase();
  if (status.includes("moving") || status.includes("early")) return "positive";
  if (status.includes("cooling") || status.includes("priced")) return "caution";
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
  return [player.card_name || player.card_query, player.card_code].filter(Boolean).join(" · ") || "Bowman Chrome Prospect Auto";
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
  const trend = rankTrendText(player);
  if (catalyst === "MLB Debut") {
    return `${player.player_name} is close enough to force a major-league roster decision if current form and organizational need keep aligning.`;
  }
  if (catalyst.includes("Promotion")) {
    return `${player.player_name}'s next assignment is the catalyst that could reset the market's view of the timeline.`;
  }
  if (trend.startsWith("Up")) {
    return `${player.player_name} already has ranking momentum; the next performance spike could pull more attention forward.`;
  }
  return `${player.player_name}'s next meaningful baseball event is the reason to monitor the profile this week.`;
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
  if (!player.market_signal) return 0;
  const signal = String(player.market_signal).toLowerCase();
  const signalScore = signal.includes("strong") ? 35 : signal.includes("buy") ? 25 : signal.includes("watch") ? 12 : 5;
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
