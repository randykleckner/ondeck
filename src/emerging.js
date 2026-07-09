const groupsElement = document.querySelector("#emerging-groups");
const countElement = document.querySelector("#emerging-row-count");
const summaryElement = document.querySelector("#emerging-summary");
const filters = {
  search: document.querySelector("#emerging-search"),
  tier: document.querySelector("#emerging-tier"),
  year: document.querySelector("#emerging-year"),
  product: document.querySelector("#emerging-product"),
  role: document.querySelector("#emerging-role"),
};

const state = { prospects: [], selectedId: "" };
const levelGroups = [
  ["levelA", "A"],
  ["levelHighA", "A+ / High-A"],
  ["levelAA", "AA"],
  ["levelAAA", "AAA"],
  ["levelROK", "ROK / Rookie"],
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
    ["A", computed.levelA],
    ["A+ / High-A", computed.levelHighA],
    ["AA", computed.levelAA],
    ["AAA", computed.levelAAA],
    ["ROK", computed.levelROK],
  ];
  summaryElement.innerHTML = cells.map(([label, value]) => `<article><span>${escapeHtml(label)}</span><strong>${count(value)}</strong></article>`).join("");
}

function computedSummary() {
  const levels = state.prospects.reduce((totals, row) => {
    const key = levelGroup(row.level || row.stat_level || row.stats_level);
    if (key) totals[key] += 1;
    return totals;
  }, { levelA: 0, levelHighA: 0, levelAA: 0, levelAAA: 0, levelROK: 0 });
  return {
    active: state.prospects.length,
    cardCandidates: state.prospects.filter((row) => row.priority_tier === "card_api_candidate").length,
    emergingA: state.prospects.filter((row) => normalizeTier(row.pre_tier) === "emerging_a").length,
    emergingBPlus: state.prospects.filter((row) => normalizeTier(row.pre_tier) === "emerging_bplus").length,
    emergingB: state.prospects.filter((row) => normalizeTier(row.pre_tier) === "emerging_b").length,
    ...levels,
  };
}

function levelGroup(value) {
  const level = String(value || "").trim().toUpperCase().replaceAll(/\s+/g, "");
  if (level === "A" || level === "LOWA" || level === "LOW-A" || level === "SINGLEA" || level === "SINGLE-A") return "levelA";
  if (level === "A+" || level === "HIGH-A" || level === "HIGHA" || level === "ADVANCEDA" || level === "ADVANCED-A") return "levelHighA";
  if (level === "AA" || level === "DOUBLEA" || level === "DOUBLE-A") return "levelAA";
  if (level === "AAA" || level === "TRIPLEA" || level === "TRIPLE-A") return "levelAAA";
  if (level === "ROK" || level === "ROOKIE" || level === "RK" || level === "R") return "levelROK";
  return "";
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
  groupsElement.innerHTML = levelGroups.map(([key, label], index) => {
    const groupRows = rows
      .filter((row) => levelGroup(row.level || row.stat_level || row.stats_level) === key)
      .sort((a, b) => Number(moveScore(b)) - Number(moveScore(a)) || String(a.player_name || "").localeCompare(String(b.player_name || "")));
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
            <th>Name</th><th>Team</th><th>Move Score</th><th>Market Read</th><th>Buy Zone</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((row) => `
            <tr data-player-id="${escapeHtml(row.player_id)}" class="${String(row.player_id) === state.selectedId ? "selected" : ""}">
              <td><strong>${escapeHtml(row.player_name)}</strong><span>${escapeHtml([row.level, row.position || row.stats_role].filter(Boolean).join(" · ") || row.tier_label || "Emerging")}</span></td>
              <td>${escapeHtml(row.team || row.current_team || row.current_org || row.team_on_card || "-")}</td>
              <td><span class="score-pill ${scoreClass(moveScore(row))}">${score(moveScore(row))}</span></td>
              <td><span class="market-status ${marketToneClass(marketRead(row))}">${escapeHtml(marketRead(row))}</span></td>
              <td>${escapeHtml(buyZone(row))}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function moveScore(row) {
  return row.move_score || row.emerging_pre_score || row.pre_score || row.opportunity_score || row.recommendation_total_score || "";
}

function marketRead(row) {
  const value = row.market_read || row.market_status || row.market_signal || row.latest_market_snapshot?.market_signal || "";
  if (String(value).includes(" · ")) return value;
  const sales30 = numberFrom(row.market_sales_count_30d ?? row.latest_market_snapshot?.sales_count_30d);
  const sales90 = numberFrom(row.market_sales_count_90d ?? row.latest_market_snapshot?.sales_count_90d);
  const avg30 = numberFrom(row.market_avg_price_30d ?? row.latest_market_snapshot?.avg_price_30d);
  const avg90 = numberFrom(row.market_avg_price_90d ?? row.latest_market_snapshot?.avg_price_90d);
  const text = String(value || "").toLowerCase();
  if (text.includes("avoid")) return "Avoid Chase";
  if (text.includes("no liquidity")) return "No Liquidity";
  if (text.includes("need")) return "Needs Market";
  if ((!Number.isFinite(sales30) || sales30 <= 0) && (!Number.isFinite(sales90) || sales90 <= 0)) {
    if (text.includes("thin")) return "Thin";
    return "Needs Market";
  }
  let volume = "Confirmed";
  if (text.includes("thin") || (Number.isFinite(sales90) && sales90 > 0 && sales90 < 4)) volume = "Thin";
  else if (text.includes("liquid") || sales30 >= 12 || sales90 >= 20) volume = "Liquid";
  let trend = "";
  if (text.includes("heating") || text.includes("up")) trend = "Up";
  else if (text.includes("priced")) trend = "Priced In";
  else if (text.includes("cooling") || text.includes("down")) trend = "Down";
  else if (Number.isFinite(avg30) && Number.isFinite(avg90) && avg90 > 0) {
    const movement = ((avg30 - avg90) / avg90) * 100;
    if (movement >= 12) trend = "Up";
    else if (movement <= -12) trend = "Down";
    else trend = "Stable";
  }
  if (!trend) trend = Number.isFinite(sales30) && Number.isFinite(sales90) && sales30 >= Math.max(3, sales90 * 0.4) ? "Active" : "Watch";
  return `${volume} · ${trend}`;
}

function numberFrom(value) {
  if (value === "" || value == null) return NaN;
  const numeric = Number(String(value).replaceAll(/[$,%]/g, ""));
  return Number.isFinite(numeric) ? numeric : NaN;
}

function marketToneClass(value) {
  const text = String(value || "").toLowerCase();
  if (text.includes("no liquidity") || text.includes("avoid") || text.includes("down") || text.includes("priced")) return "negative";
  if (text.includes("up") || text.includes("heating") || text.includes("strong")) return "positive";
  if (text.includes("stable") || text.includes("thin") || text.includes("need") || text.includes("pending") || text.includes("watch")) return "caution";
  return "neutral";
}

function buyZone(row) {
  const value = row.buy_zone || row.final_action || row.recommendation || row.latest_recommendation?.recommendation || "";
  const text = String(value || "").toLowerCase();
  if (text.includes("strong")) return "Strong Buy";
  if (text.includes("avoid")) return "Avoid Chase";
  if (text.includes("no liquidity")) return "No Liquidity";
  if (text.includes("need")) return "Needs Market";
  if (text.includes("buy")) return "Buy Zone";
  if (text.includes("watch")) return "Watch";
  if (text.includes("research")) return "Research";
  return Number(moveScore(row)) >= 60 ? "Research" : "Needs Market";
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
  if (!playerId) return;
  window.location.href = `./player.html?type=emerging&id=${encodeURIComponent(String(playerId))}`;
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
