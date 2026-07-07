const groupsElement = document.querySelector("#emerging-groups");
const countElement = document.querySelector("#emerging-row-count");
const summaryElement = document.querySelector("#emerging-summary");
const detailElement = document.querySelector("#emerging-detail");
const filters = {
  search: document.querySelector("#emerging-search"),
  tier: document.querySelector("#emerging-tier"),
  year: document.querySelector("#emerging-year"),
  product: document.querySelector("#emerging-product"),
  role: document.querySelector("#emerging-role"),
};

const state = { prospects: [], selectedId: "", details: new Map() };
const groups = [
  ["card_api_candidate", "Card Candidates"],
  ["emerging_a", "Emerging A"],
  ["emerging_bplus", "Emerging B+"],
  ["emerging_b", "Emerging B"],
];

loadEmergingProspects();
Object.values(filters).forEach((element) => {
  element?.addEventListener("input", render);
  element?.addEventListener("change", render);
});

async function loadEmergingProspects() {
  try {
    const [summaryResponse, prospectsResponse] = await Promise.all([
      fetch("/api/emerging/summary", { headers: { Accept: "application/json" } }),
      fetch("/api/emerging?limit=150", { headers: { Accept: "application/json" } }),
    ]);
    if (!summaryResponse.ok || !prospectsResponse.ok) {
      throw new Error(`Emerging API unavailable (${summaryResponse.status}/${prospectsResponse.status})`);
    }
    const summary = await summaryResponse.json();
    const prospects = await prospectsResponse.json();
    state.prospects = Array.isArray(prospects.prospects) ? prospects.prospects : [];
    renderSummary(summary.summary || {});
    hydrateFilters();
    render();
  } catch (error) {
    console.error(error);
    countElement.textContent = "Error loading emerging data";
    groupsElement.innerHTML = `<p class="muted">Emerging prospects are unavailable right now. Confirm the D1 migration and import have run.</p>`;
  }
}

function renderSummary(summary) {
  const computed = computedSummary();
  const cells = [
    ["Active", computed.active || summary.active_emerging],
    ["Card Candidates", computed.cardCandidates || summary.card_api_candidates],
    ["Emerging A", computed.emergingA || summary.emerging_a],
    ["Emerging B+", computed.emergingBPlus || summary.emerging_bplus],
    ["Emerging B", computed.emergingB || summary.emerging_b],
  ];
  summaryElement.innerHTML = cells.map(([label, value]) => `<article><span>${escapeHtml(label)}</span><strong>${count(value)}</strong></article>`).join("");
}

function computedSummary() {
  return {
    active: state.prospects.length,
    cardCandidates: state.prospects.filter((row) => row.priority_tier === "card_api_candidate").length,
    emergingA: state.prospects.filter((row) => normalizeTier(row.pre_tier) === "emerging_a").length,
    emergingBPlus: state.prospects.filter((row) => normalizeTier(row.pre_tier) === "emerging_bplus").length,
    emergingB: state.prospects.filter((row) => normalizeTier(row.pre_tier) === "emerging_b").length,
  };
}

function hydrateFilters() {
  setOptions(filters.year, unique(state.prospects.map((row) => row.year).filter(Boolean)).sort((a, b) => Number(b) - Number(a)), "All years");
  setOptions(filters.product, unique(state.prospects.map((row) => row.product).filter(Boolean)).sort(), "All products");
}

function setOptions(select, values, firstLabel) {
  if (!select) return;
  select.innerHTML = [`<option value="all">${escapeHtml(firstLabel)}</option>`, ...values.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`)].join("");
}

function render() {
  const rows = filteredRows();
  countElement.textContent = `${rows.length} ${rows.length === 1 ? "prospect" : "prospects"}`;
  groupsElement.innerHTML = groups.map(([key, label], index) => {
    const groupRows = key === "card_api_candidate"
      ? rows.filter((row) => row.priority_tier === key)
      : rows.filter((row) => normalizeTier(row.pre_tier) === key);
    return `
      <details class="emerging-section" ${index === 0 ? "open" : ""}>
        <summary><span>${escapeHtml(label)}</span><strong>${groupRows.length}</strong></summary>
        ${groupRows.length ? renderTable(groupRows) : `<p class="muted">No players in this section after filters.</p>`}
      </details>
    `;
  }).join("");
  groupsElement.querySelectorAll("[data-player-id]").forEach((row) => {
    row.addEventListener("click", () => selectPlayer(row.dataset.playerId));
  });
}

function renderTable(rows) {
  return `
    <div class="table-wrap">
      <table class="emerging-table">
        <thead>
          <tr>
            <th>Player</th><th>Year</th><th>Product</th><th>Auto Code</th><th>Role</th><th>Level</th>
            <th>Team</th><th>Age</th><th>Pre-Score</th><th>Key Stat</th><th>Card Query Seed</th><th>Status</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((row) => `
            <tr data-player-id="${escapeHtml(row.player_id)}" class="${String(row.player_id) === state.selectedId ? "selected" : ""}">
              <td><strong>${escapeHtml(row.player_name)}</strong><span>${escapeHtml(row.team_on_card || row.current_org || "Org pending")}</span></td>
              <td>${escapeHtml(row.year || "-")}</td>
              <td>${escapeHtml(row.product || "-")}</td>
              <td>${escapeHtml(row.auto_code || "-")}</td>
              <td>${escapeHtml(row.stats_role || "-")}</td>
              <td>${escapeHtml(row.level || "-")}</td>
              <td>${escapeHtml(row.team || "-")}</td>
              <td>${escapeHtml(row.age || "-")}</td>
              <td><span class="score-pill ${scoreClass(row.emerging_pre_score)}">${score(row.emerging_pre_score)}</span></td>
              <td>${escapeHtml(keyStat(row))}</td>
              <td class="query-cell">${escapeHtml(row.card_query_seed || "-")}</td>
              <td>${escapeHtml(row.tier_label || row.status || "-")}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function filteredRows() {
  const search = normalize(filters.search?.value || "");
  return state.prospects.filter((row) => {
    const blob = normalize(`${row.player_name} ${row.team_on_card} ${row.team} ${row.product} ${row.auto_code}`);
    return (!search || blob.includes(search))
      && ((filters.tier?.value || "all") === "all" || row.priority_tier === filters.tier.value)
      && ((filters.year?.value || "all") === "all" || String(row.year) === filters.year.value)
      && ((filters.product?.value || "all") === "all" || row.product === filters.product.value)
      && ((filters.role?.value || "all") === "all" || row.stats_role === filters.role.value);
  });
}

async function selectPlayer(playerId) {
  state.selectedId = String(playerId);
  const row = state.prospects.find((candidate) => String(candidate.player_id) === state.selectedId);
  renderDetail(row);
  render();
  if (!state.details.has(state.selectedId)) {
    const response = await fetch(`/api/emerging/${encodeURIComponent(state.selectedId)}`, { headers: { Accept: "application/json" } }).catch(() => null);
    if (response?.ok) state.details.set(state.selectedId, await response.json());
  }
  renderDetail(state.details.get(state.selectedId)?.prospect || row);
}

function renderDetail(row) {
  if (!row) {
    detailElement.innerHTML = `
      <div class="panel-heading compact">
        <h2>Prospect Profile</h2>
        <span>Click a row</span>
      </div>
      <p class="muted">Select an Emerging prospect to open the On Deck Briefing.</p>
    `;
    return;
  }
  const player = normalizeEmergingProfile(row);
  detailElement.innerHTML = `
    <article class="emerging-card-back" aria-label="Emerging On Deck Briefing for ${escapeHtml(player.name)}">
      ${emergingHeader(player)}
      ${emergingBriefing(player)}
      ${emergingMovementCase(player)}
      ${emergingMarketPulse(player)}
      ${emergingMinorRecord(player)}
      ${emergingDecisionRisk(player)}
    </article>
  `;
}

function normalizeEmergingProfile(row) {
  const market = row.latest_market_snapshot || {};
  const recommendation = row.latest_recommendation || {};
  return {
    ...row,
    market,
    recommendation,
    name: row.player_name || "Emerging prospect",
    org: row.current_org || row.team_on_card || row.team || "Org pending",
    team: row.team || row.current_team || row.current_org || row.team_on_card || "Team pending",
    position: row.position || row.stats_role || "Position pending",
    level: row.level || "Level pending",
    age: row.age || "Age pending",
    tier: row.tier_label || row.pre_tier || row.priority_tier || "Emerging",
    grade: recommendation.grade || row.recommendation_grade || tierGrade(row),
    recommendationText: recommendation.recommendation || row.recommendation || "Recommendation pending latest scoring run.",
    riskNotes: recommendation.risk_notes || row.recommendation_risk_notes || emergingRiskText(row),
    thesis: recommendation.thesis || row.recommendation_thesis || row.pre_score_notes || emergingResume(row),
    benchmark: cardTargetLabel(row),
    query: row.card_query_seed || "Card query pending",
    marketRead: market.market_signal || row.market_signal || derivedEmergingMarketRead(row),
    liquidity: emergingLiquidity(row),
    buyZone: emergingBuyZone(row),
  };
}

function emergingHeader(player) {
  return `
    <header class="emerging-card-header">
      <div class="emerging-card-nameplate">
        <p>Emerging On Deck Briefing</p>
        <h2>${escapeHtml(player.name)}</h2>
        <strong>${escapeHtml(player.org)} - ${escapeHtml(player.position)}</strong>
      </div>
      <div class="emerging-card-code">
        <span>${escapeHtml(player.auto_code || player.card_number || "ODP")}</span>
        <strong>${escapeHtml(player.grade)}</strong>
      </div>
    </header>
    <div class="emerging-card-bio">
      <span>Age: <strong>${escapeHtml(player.age)}</strong></span>
      <span>Level: <strong>${escapeHtml(player.level)}</strong></span>
      <span>Team: <strong>${escapeHtml(player.team)}</strong></span>
      <span>Pre-Score: <strong>${escapeHtml(score(player.emerging_pre_score))}</strong></span>
    </div>
  `;
}

function emergingBriefing(player) {
  return `
    <section class="emerging-briefing-block">
      <h3>On Deck Briefing</h3>
      <p><strong>Resume:</strong> ${escapeHtml(emergingResume(player))}</p>
      <p><strong>Skills:</strong> ${escapeHtml(emergingSkills(player))}</p>
      <p><strong>Up Close:</strong> ${escapeHtml(player.thesis || "Briefing pending latest recommendation run.")}</p>
    </section>
  `;
}

function emergingMovementCase(player) {
  return `
    <section class="briefing-section emerging-card-section">
      <div class="panel-heading compact">
        <h3>Movement Case</h3>
        <span>${escapeHtml(emergingCatalyst(player))}</span>
      </div>
      <div class="briefing-score-grid">
        ${briefingFact("Move Score", score(player.emerging_pre_score))}
        ${briefingFact("Primary Catalyst", emergingCatalyst(player))}
        ${briefingFact("Next Move", emergingNextMove(player))}
        ${briefingFact("Confidence", emergingConfidence(player))}
      </div>
    </section>
  `;
}

function emergingMarketPulse(player) {
  return `
    <section class="briefing-section emerging-card-section market-pulse-briefing">
      <div class="panel-heading compact">
        <h3>Card Market Pulse</h3>
        <span>${escapeHtml(player.marketRead)}</span>
      </div>
      <div class="briefing-market-grid">
        ${briefingFact("Benchmark Card", player.benchmark)}
        ${briefingFact("30D Avg", currency(player.market.avg_price_30d))}
        ${briefingFact("Sell-Through", pct(player.market.sell_through_30d))}
        ${briefingFact("Liquidity", player.liquidity)}
        ${briefingFact("Market Read", player.marketRead)}
        ${briefingFact("Buy Zone", player.buyZone)}
      </div>
      <p>${escapeHtml(emergingMarketTakeaway(player))}</p>
    </section>
  `;
}

function emergingMinorRecord(player) {
  const cells = emergingRecordCells(player);
  return `
    <section class="briefing-section emerging-card-section minor-record-panel">
      <div class="panel-heading compact">
        <h3>2026 Minor League Record</h3>
        <span>${escapeHtml(player.stats_role || "Stats")}</span>
      </div>
      ${cells.length ? `
        <div class="briefing-record-wrap">
          <table class="briefing-record-table emerging-record-table">
            <thead><tr>${cells.map((cell) => `<th>${escapeHtml(cell.label)}</th>`).join("")}</tr></thead>
            <tbody><tr>${cells.map((cell) => `<td>${escapeHtml(cell.value)}</td>`).join("")}</tr></tbody>
          </table>
        </div>
      ` : `<p class="muted">2026 stat line pending latest stats refresh.</p>`}
    </section>
  `;
}

function emergingDecisionRisk(player) {
  return `
    <section class="briefing-section emerging-card-section decision-risk-panel">
      <div class="panel-heading compact">
        <h3>Decision / Risk</h3>
        <span>${escapeHtml(player.recommendationText)}</span>
      </div>
      <div class="decision-grid">
        ${briefingFact("Grade", player.grade)}
        ${briefingFact("Status", player.tier)}
        ${briefingFact("Recommendation", player.recommendationText)}
        ${briefingFact("Buy Zone", player.buyZone)}
      </div>
      <div class="decision-notes">
        <div><span>Main Reason</span><p>${escapeHtml(emergingMainReason(player))}</p></div>
        <div><span>Main Risk</span><p>${escapeHtml(player.riskNotes)}</p></div>
      </div>
    </section>
  `;
}

function briefingFact(label, value) {
  return `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value || "Pending")}</strong></div>`;
}

function cardTargetLabel(row) {
  return [row.year, row.product, row.auto_set, row.auto_code || row.card_number].filter(Boolean).join(" · ") || "Benchmark card pending";
}

function tierGrade(row) {
  const tier = normalizeTier(row.pre_tier || row.priority_tier);
  if (tier === "card_api_candidate" || tier === "emerging_a") return "A";
  if (tier === "emerging_bplus") return "B+";
  if (tier === "emerging_b") return "B";
  return "Watch";
}

function emergingResume(row) {
  const rankText = row.priority_tier === "card_api_candidate" ? "card-market candidate" : "emerging research target";
  return `${row.name || row.player_name} is a ${row.age || "age-pending"} ${row.position || row.stats_role || "prospect"} in ${row.org || row.current_org || row.team_on_card || "an org-pending system"} at ${row.level || "level pending"}, currently filed as a ${rankText}.`;
}

function emergingSkills(row) {
  if (String(row.stats_role || "").toLowerCase().includes("pitch")) {
    return `${stat(row.pitcher_ip)} IP, ${era(row.pitcher_era)} ERA, ${stat(row.pitcher_whip)} WHIP, and ${pct(row.pitcher_k_minus_bb_pct)} K-BB give the current pitching read.`;
  }
  return `${avg(row.hitter_ops)} OPS over ${count(row.hitter_pa)} PA with ${count(row.hitter_hr)} HR and ${count(row.hitter_sb)} SB gives the current offensive read.`;
}

function emergingCatalyst(row) {
  if (Number(row.emerging_pre_score) >= 70) return "Performance Breakout";
  if (row.priority_tier === "card_api_candidate") return "Card-Market Watch";
  if (String(row.level || "").toUpperCase() === "AAA") return "MLB Proximity";
  if (String(row.level || "").toUpperCase() === "AA") return "Promotion Watch";
  return "Research Watch";
}

function emergingNextMove(row) {
  const level = String(row.level || "").toUpperCase();
  if (level === "AAA") return "MLB radar";
  if (level === "AA") return "Triple-A case";
  if (level === "A+" || level === "A") return "Upper-minors test";
  return "Stats confirmation";
}

function emergingConfidence(row) {
  const value = Number(row.emerging_pre_score);
  if (!Number.isFinite(value)) return "Needs Data";
  if (value >= 70) return "High";
  if (value >= 55) return "Medium";
  return "Low";
}

function emergingRecordCells(row) {
  if (String(row.stats_role || "").toLowerCase().includes("pitch")) {
    const cells = [
      { label: "Level", value: row.level || "-" },
      { label: "IP", value: stat(row.pitcher_ip) },
      { label: "ERA", value: era(row.pitcher_era) },
      { label: "WHIP", value: stat(row.pitcher_whip) },
      { label: "K%", value: pct(row.pitcher_k_pct) },
      { label: "BB%", value: pct(row.pitcher_bb_pct) },
      { label: "K-BB%", value: pct(row.pitcher_k_minus_bb_pct) },
    ];
    return cells.some((cell) => cell.label !== "Level" && cell.value !== "-") ? cells : [];
  }

  const cells = [
    { label: "Level", value: row.level || "-" },
    { label: "PA", value: count(row.hitter_pa) },
    { label: "OPS", value: avg(row.hitter_ops) },
    { label: "HR", value: count(row.hitter_hr) },
    { label: "SB", value: count(row.hitter_sb) },
    { label: "BB%", value: pct(row.hitter_bb_pct) },
    { label: "K%", value: pct(row.hitter_k_pct) },
  ];
  return cells.some((cell) => cell.label !== "Level" && cell.value !== "-") ? cells : [];
}

function derivedEmergingMarketRead(row) {
  const market = row.latest_market_snapshot || {};
  if (!market || !Object.keys(market).length) return "Market Pending";
  const avg30 = Number(market.avg_price_30d);
  const avg90 = Number(market.avg_price_90d);
  const sales90 = Number(market.sales_count_90d);
  const sales30 = Number(market.sales_count_30d);
  if (Number.isFinite(sales90) && sales90 <= 0) return "No Liquidity";
  if (Number.isFinite(avg30) && Number.isFinite(avg90) && avg90 > 0) {
    if (avg30 > avg90 * 1.4) return "Priced In";
    if (avg30 > avg90 * 1.2 && Number.isFinite(sales30) && sales30 >= 5) return "Heating";
  }
  return "Early / Stable";
}

function emergingLiquidity(row) {
  const market = row.latest_market_snapshot || {};
  const sales90 = Number(market.sales_count_90d);
  if (!Number.isFinite(sales90)) return "Pending";
  if (sales90 >= 10) return "Good";
  if (sales90 >= 4) return "Moderate";
  if (sales90 >= 1) return "Thin";
  return "No Liquidity";
}

function emergingBuyZone(row) {
  const market = row.latest_market_snapshot || {};
  const avg30 = Number(market.avg_price_30d);
  if (!Number.isFinite(avg30)) return "Pending";
  const read = derivedEmergingMarketRead(row).toLowerCase();
  const low = Math.round(avg30 * (read.includes("heating") ? 0.75 : 0.8));
  const high = Math.round(avg30 * (read.includes("heating") ? 0.88 : 0.92));
  return `${currency(low)} - ${currency(high)}`;
}

function emergingMarketTakeaway(row) {
  if (!row.latest_market_snapshot) return "Card market review pending. Only Card Candidates should be refreshed with paid SoldComps pulls.";
  return `${row.marketRead} market read with ${row.liquidity.toLowerCase()} liquidity. The benchmark card is ${row.benchmark}.`;
}

function emergingRiskText(row) {
  if (!row.latest_market_snapshot) return "Market risk is unknown until the benchmark card has current sold comps and liquidity.";
  const liquidity = row.liquidity || emergingLiquidity(row);
  const marketReadValue = row.marketRead || derivedEmergingMarketRead(row);
  if (liquidity === "No Liquidity" || liquidity === "Thin") return "Liquidity is thin, so one sale can distort the read and exits may be slow.";
  if (marketReadValue === "Priced In") return "The card may already be reacting; avoid chasing above the buy zone.";
  return "Primary risk is confirmation: the stats signal still needs sustained performance and market validation.";
}

function emergingMainReason(row) {
  if (row.recommendation.thesis) return row.recommendation.thesis;
  if (Number(row.emerging_pre_score) >= 70) return "Strong stats pre-score creates an early movement signal before broader Top 100 attention.";
  if (row.priority_tier === "card_api_candidate") return "This profile is already marked as a card-market candidate for deeper comp review.";
  return "The current case is built from emerging stats, level, age, and a benchmark card target.";
}

function keyStat(row) {
  if (String(row.stats_role || "").toLowerCase().includes("pitch")) {
    return `${stat(row.pitcher_ip)} IP · ${era(row.pitcher_era)} ERA · ${stat(row.pitcher_whip)} WHIP · K-BB ${pct(row.pitcher_k_minus_bb_pct)}`;
  }
  return `${avg(row.hitter_ops)} OPS · ${count(row.hitter_pa)} PA · ${count(row.hitter_hr)} HR · ${count(row.hitter_sb)} SB`;
}

function unique(values) {
  return [...new Set(values.map(String).filter(Boolean))];
}

function scoreClass(value) {
  const numeric = Number(value);
  if (numeric >= 70) return "score-high";
  if (numeric >= 55) return "score-medium";
  return "score-low";
}

function score(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? String(Math.round(numeric)) : "-";
}

function count(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? String(Math.round(numeric)) : "-";
}

function stat(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric.toFixed(1).replace(/\.0$/, "") : "-";
}

function avg(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric.toFixed(3).replace(/^0/, "") : "-";
}

function era(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric.toFixed(2) : "-";
}

function pct(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "-";
  return `${(numeric <= 1 ? numeric * 100 : numeric).toFixed(1)}%`;
}

function currency(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "-";
  return `$${numeric.toFixed(numeric >= 100 ? 0 : 2)}`;
}

function normalize(value) {
  return String(value || "").toLowerCase().replaceAll(/[^a-z0-9]+/g, " ").trim();
}

function normalizeTier(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\+/g, "plus")
    .replaceAll(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
