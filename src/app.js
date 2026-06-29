import { parseCsv, toCsv } from "./lib/csv.js";
import { mergeProspectData } from "./lib/scoring.js?v=20260626-6";

const state = {
  prospects: [],
  stats: [],
  depthCharts: [],
  cardMarket: [],
  mlbPlayerFlags: [],
  scored: [],
  calledUp: [],
  selectedId: null,
  selectedOrg: null,
  activeTool: "dashboard",
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
  cardPanel: document.querySelector(".card-panel"),
  playerCard: document.querySelector("#player-card"),
  rowCount: document.querySelector("#row-count"),
  teamBoard: document.querySelector("#team-board"),
  teamBoardCount: document.querySelector("#team-board-count"),
  warRoom: document.querySelector("#war-room"),
  warRoomLogo: document.querySelector("#war-room-logo"),
  warRoomTitle: document.querySelector("#war-room-title"),
  warRoomSubtitle: document.querySelector("#war-room-subtitle"),
  warRoomSummary: document.querySelector("#war-room-summary"),
  warRoomBoard: document.querySelector("#war-room-board"),
  marketBoard: document.querySelector("#market-board"),
  marketCount: document.querySelector("#market-count"),
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

window.addEventListener("hashchange", () => {
  syncRouteFromHash();
});

window.addEventListener("popstate", () => {
  syncRouteFromHash();
});

document.addEventListener("click", (event) => {
  if (!state.selectedId) return;
  if (event.target.closest("#player-card, #prospect-rows tr[data-player-id], .market-card[data-player-id], .war-prospect[data-player-id], [data-open-war-room]")) {
    return;
  }
  state.selectedId = null;
  render();
});

refreshScoredData();

loadTop100Prospects();
syncRouteFromHash();

async function loadTop100Prospects() {
  const response = await fetch("./data/mlb-top100-2026.csv");
  if (!response.ok) {
    throw new Error(`Could not load MLB Top 100 seed data: ${response.status}`);
  }
  state.prospects = parseCsv(await response.text());
  const [stats, savantStats, depthCharts, enrichment, news, rankHistory, cardMarket, mlbPlayerFlags] = await Promise.all([
    loadOptionalCsv("./data/current-stats.csv?v=20260626-2"),
    loadOptionalCsv("./data/savant-stats.csv?v=20260626-1"),
    loadOptionalCsv("./data/depth-chart-current.csv"),
    loadOptionalCsv("./data/player-enrichment.csv"),
    loadOptionalCsv("./data/player-news.csv"),
    loadOptionalCsv("./data/rank-history.csv?v=20260626-full-ranks"),
    loadOptionalCsv("./data/card-market.csv?v=20260626-3"),
    loadOptionalCsv("./data/mlb-player-flags.csv?v=20260629-1"),
  ]);
  state.prospects = applyProspectEnrichment(state.prospects, mergeRowsByPlayerId(enrichment, rankHistory));
  state.stats = mergeRowsByPlayerId(stats, savantStats);
  state.depthCharts = mergeRowsByPlayerId(depthCharts, news);
  state.cardMarket = cardMarket;
  state.mlbPlayerFlags = mlbPlayerFlags;
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
  if (state.selectedId && !state.scored.some((player) => String(player.player_id) === String(state.selectedId))) {
    state.selectedId = null;
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
  renderTeamBoard();
  renderWarRoom();
  renderMarketBoard(rows);
  renderRows(rows);
  elements.rowCount.textContent = `${rows.length} ${rows.length === 1 ? "player" : "players"}`;
  const selected = state.selectedId ? rows.find((player) => String(player.player_id) === String(state.selectedId)) : null;
  renderCard(selected);
  syncToolVisibility();
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
    card.addEventListener("click", (event) => {
      event.stopPropagation();
      openTeamWarRoom(card.dataset.org);
      render();
      openTool("war", "#war-room");
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
    elements.warRoomSubtitle.textContent = "Click a team on the Break Value Board to map the depth chart, MLB blockers, and prospect call-up paths.";
    elements.warRoomSummary.innerHTML = "";
    elements.warRoomBoard.innerHTML = `<p class="muted">Pick a team above to open its depth-chart board.</p>`;
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
    ? `${topTarget.player_name} is the next board target at ${topTarget.callup_score}% call-up chance.`
    : "No active pre-call-up Top 100 prospects remain on this board.";
  elements.warRoomSummary.innerHTML = warRoomSummaryMarkup(players, calledUp);

  if (!players.length) {
    elements.warRoomBoard.innerHTML = `<p class="muted">No pre-call-up Top 100 prospects are active for ${escapeHtml(org)} right now.</p>`;
    return;
  }

  const board = buildPositionBoard(players);
  elements.warRoomBoard.innerHTML = positionWarRoomMarkup(board, players, calledUp);
  elements.warRoomBoard.querySelectorAll(".war-prospect[data-player-id]").forEach((card) => {
    card.addEventListener("click", (event) => {
      event.stopPropagation();
      clearListFilters();
      state.selectedId = card.dataset.playerId;
      render();
      document.querySelector("#prospects")?.scrollIntoView({ behavior: "smooth", block: "start" });
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
  } else if (location.hash === "#war-room") {
    openTool("war", "#war-room", false);
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
  elements.secondaryTools.forEach((section) => {
    const active = section.dataset.tool === state.activeTool;
    section.classList.toggle("active-tool", active);
  });
  elements.navLinks.forEach((link) => {
    const route = link.dataset.route;
    const href = link.getAttribute("href");
    const active = state.activeTool === "dashboard"
      ? route === "dashboard" && (href === location.hash || (href === "#dashboard" && !location.hash))
      : route === state.activeTool;
    link.classList.toggle("active", active);
  });
}

function warRoomSummaryMarkup(players, calledUp) {
  const onForty = players.filter(isOnFortyMan).length;
  const green = players.filter((player) => player.callup_score >= 60).length;
  const bestPath = players.slice().sort((a, b) => b.opportunity_score - a.opportunity_score || b.callup_score - a.callup_score)[0];
  return `
    <div><span>Active Top 100</span><strong>${players.length}</strong></div>
    <div><span>60%+ paths</span><strong>${green}</strong></div>
    <div><span>On 40-man</span><strong>${onForty}</strong></div>
    <div><span>Already up</span><strong>${calledUp.length}</strong></div>
    <div><span>Cleanest lane</span><strong>${escapeHtml(bestPath ? depthChartGroup(bestPath.position) : "-")}</strong></div>
  `;
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
  const fieldBoard = board.filter((lane) => FIELD_POSITIONS.some((position) => position.key === lane.key));
  const pitchingBoard = board.filter((lane) => PITCHING_POSITIONS.some((position) => position.key === lane.key));
  return `
    <div class="field-war-room">
      ${orgHighlightMarkup(players, calledUp, board)}
      <div class="field-diamond" aria-label="Baseball field depth chart">
        ${fieldBoard.map((lane) => fieldPositionMarkup(lane)).join("")}
        <div class="field-grass" aria-hidden="true"></div>
        <div class="field-infield" aria-hidden="true"></div>
      </div>
      <section class="pitching-war-room" aria-label="Pitching war room">
        <div class="panel-heading compact">
          <h3>Pitching War Room</h3>
          <span>SP / Bullpen</span>
        </div>
        <div class="pitching-lanes">
          ${pitchingBoard.map((lane) => pitchingLaneMarkup(lane)).join("")}
        </div>
      </section>
    </div>
  `;
}

function orgHighlightMarkup(players, calledUp, board) {
  const active = board.filter((lane) => lane.players.length);
  const bestLane = active.slice().sort((a, b) => b.players[0].callup_score - a.players[0].callup_score)[0];
  const hot = players.filter((player) => player.callup_score >= 60);
  return `
    <aside class="org-highlights">
      <div class="panel-heading compact">
        <h3>Org Highlights</h3>
        <span>${escapeHtml(players[0]?.org ?? "Team")}</span>
      </div>
      <div class="org-highlight-grid">
        <div><span>Active Top 100</span><strong>${players.length}</strong></div>
        <div><span>60%+ call-up</span><strong>${hot.length}</strong></div>
        <div><span>Already up</span><strong>${calledUp.length}</strong></div>
      </div>
      ${bestLane ? `<p><strong>${escapeHtml(bestLane.players[0].player_name)}</strong> is the strongest active lane at ${escapeHtml(bestLane.players[0].callup_score)}%.</p>` : "<p>No active Top 100 path is loaded for this org.</p>"}
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
      <div class="current-stack">
        ${blockers.length ? blockers.map((name, index) => currentPlayerChip(name, index === 0 ? "Current lead" : `Depth ${index + 1}`)).join("") : `<span class="empty-chip">Pitching depth not loaded</span>`}
      </div>
      <div class="prospect-bubbles">
        ${lane.players.length ? lane.players.slice(0, 3).map((player, index) => warProspectMarkup(player, index)).join("") : `<span class="empty-prospect">No Top 100 pitching path</span>`}
      </div>
    </article>
  `;
}

function fieldPositionMarkup(lane) {
  const top = lane.players[0];
  const blockers = lane.blockers.slice(0, 2);
  const starter = blockers[0];
  const backup = blockers[1];
  const pressure = rosterPressure(lane);
  return `
    <article class="field-position ${escapeHtml(positionClassName(lane.key))} ${top ? "has-prospect" : "empty-position"}">
      <header>
        <span>${escapeHtml(lane.label)}</span>
        <strong>${escapeHtml(pressure)}</strong>
      </header>
      <div class="current-stack">
        ${starter ? currentPlayerChip(starter, "Starter") : `<span class="empty-chip">Starter not loaded</span>`}
        ${backup ? currentPlayerChip(backup, "Backup") : `<span class="empty-chip">Backup not loaded</span>`}
      </div>
      <div class="prospect-bubbles">
        ${lane.players.length ? lane.players.slice(0, 2).map((player, index) => warProspectMarkup(player, index)).join("") : `<span class="empty-prospect">No Top 100 path</span>`}
      </div>
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
      ${flags.length ? `<small>${flags.map((flag) => `<span><strong>${escapeHtml(flag.label)}</strong>${escapeHtml(flag.detail)}</span>`).join("")}</small>` : ""}
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
    const activate = (event) => {
      event?.stopPropagation();
      clearListFilters();
      state.selectedId = card.dataset.playerId;
      render();
      document.querySelector("#prospects")?.scrollIntoView({ behavior: "smooth", block: "start" });
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

function clearListFilters() {
  state.filters.search = "";
  state.filters.org = "all";
  state.filters.minScore = 0;
  elements.search.value = "";
  elements.orgFilter.value = "all";
  elements.scoreFilter.value = "0";
  elements.scoreFilterValue.textContent = "0";
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
    row.addEventListener("click", (event) => {
      event.stopPropagation();
      state.selectedId = row.dataset.playerId;
      render();
    });
  });
}

function renderCard(player) {
  if (!player) {
    elements.contentGrid.classList.remove("profile-open");
    elements.cardPanel.hidden = true;
    elements.playerCard.className = "player-card empty";
    elements.playerCard.innerHTML = "<p>Select a player to review their call-up case.</p>";
    return;
  }

  elements.contentGrid.classList.add("profile-open");
  elements.cardPanel.hidden = false;
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
    ${teamPathPanel(player)}
    ${newsPanel(player)}
    ${marketPanel(player)}
  `;

  elements.playerCard.querySelector("[data-open-war-room]")?.addEventListener("click", (event) => {
    event.stopPropagation();
    openTeamWarRoom(player.org);
    render();
    openTool("war", "#war-room");
  });
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
        <h3>Team War Room</h3>
        <span>${escapeHtml(role)}</span>
      </div>
      <p>${escapeHtml(pathRead(lane))}</p>
      <p class="muted">MLB blockers: ${escapeHtml(blockerText)}</p>
      <button class="button ghost profile-war-action" type="button" data-open-war-room="${escapeHtml(player.org ?? "")}">
        Open ${escapeHtml(player.org ?? "team")} war room
      </button>
    </section>
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
        <p class="muted">No CPA Chrome Prospect Auto sold-comps row is loaded yet for ${escapeHtml(player.player_name)}. Run scripts/update-ebay-comps.mjs with eBay API access, or CARD_COMP_SOURCE=web for best-effort public scrape comps, to activate buy-zone analysis.</p>
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

function isOnFortyMan(player) {
  return String(player.on_40man ?? "").toLowerCase() === "true";
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
