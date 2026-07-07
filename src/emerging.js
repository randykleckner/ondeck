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
