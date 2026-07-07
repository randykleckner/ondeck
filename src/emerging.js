import { parseCsv } from "./lib/csv.js";

const rowsElement = document.querySelector("#emerging-rows");
const countElement = document.querySelector("#emerging-row-count");

loadEmergingProspects();

async function loadEmergingProspects() {
  try {
    const [targets, top100, orgProspects] = await Promise.all([
      loadCsv("./data/card-targets.csv?v=20260706-1"),
      loadCsv("./data/mlb-top100-2026.csv?v=20260702-current"),
      loadCsv("./data/org-prospects.csv?v=20260630-1"),
    ]);
    const currentTop100Ids = new Set(top100.map((row) => String(row.player_id)));
    const currentTop100Names = new Set(top100.map((row) => normalizeName(row.player_name)));
    const orgByName = new Map(orgProspects.map((row) => [normalizeName(row.player_name), row]));
    const emerging = targets
      .filter((row) => isEnabledTarget(row))
      .filter((row) => !currentTop100Ids.has(String(row.player_id)))
      .filter((row) => !currentTop100Names.has(normalizeName(row.player_name)))
      .map((target) => emergingRow(target, orgByName.get(normalizeName(target.player_name))))
      .sort((a, b) => b.score - a.score || a.playerName.localeCompare(b.playerName));

    renderRows(emerging);
  } catch (error) {
    console.error(error);
    rowsElement.innerHTML = `<tr><td colspan="13" class="muted">Emerging prospects are unavailable right now.</td></tr>`;
    countElement.textContent = "Error loading emerging data";
  }
}

async function loadCsv(path) {
  const response = await fetch(path);
  if (!response.ok) return [];
  return parseCsv(await response.text());
}

function emergingRow(target, orgProspect = {}) {
  const score = emergingScore(target, orgProspect);
  return {
    playerName: target.player_name || "-",
    year: target.card_year || "-",
    product: productName(target),
    code: target.card_code || "-",
    teamOnCard: orgProspect.org || target.team_on_card || "TBD",
    role: orgProspect.position || "Prospect target",
    level: orgProspect.level || "Pre-Top 100",
    team: orgProspect.org || "TBD",
    age: orgProspect.age || "-",
    score,
    tier: tierLabel(score),
    query: `${target.player_name} Bowman Chrome 1st Auto`,
    status: target.sell_through_30 || target.sell_through_90 ? "Market watch" : "Needs comp history",
  };
}

function renderRows(rows) {
  countElement.textContent = `${rows.length} ${rows.length === 1 ? "prospect" : "prospects"}`;
  if (!rows.length) {
    rowsElement.innerHTML = `<tr><td colspan="13" class="muted">No emerging Bowman-auto targets are loaded yet.</td></tr>`;
    return;
  }

  rowsElement.innerHTML = rows.map((row) => `
    <tr>
      <td><strong>${escapeHtml(row.playerName)}</strong></td>
      <td>${escapeHtml(row.year)}</td>
      <td>${escapeHtml(row.product)}</td>
      <td>${escapeHtml(row.code)}</td>
      <td>${escapeHtml(row.teamOnCard)}</td>
      <td>${escapeHtml(row.role)}</td>
      <td>${escapeHtml(row.level)}</td>
      <td>${escapeHtml(row.team)}</td>
      <td>${escapeHtml(row.age)}</td>
      <td><span class="score-pill ${scoreClass(row.score)}">${escapeHtml(row.score)}</span></td>
      <td>${escapeHtml(row.tier)}</td>
      <td>${escapeHtml(row.query)}</td>
      <td>${escapeHtml(row.status)}</td>
    </tr>
  `).join("");
}

function emergingScore(target, orgProspect) {
  const sell30 = percentNumber(target.sell_through_30);
  const sell90 = percentNumber(target.sell_through_90);
  const sellers30 = Number(target.sellers_30);
  const age = Number(orgProspect?.age);
  let score = 42;
  if (Number.isFinite(sell30)) score += Math.min(28, sell30 * 0.32);
  if (Number.isFinite(sell90)) score += Math.min(16, sell90 * 0.16);
  if (Number.isFinite(sellers30)) score += Math.min(8, sellers30 / 14);
  if (Number.isFinite(age) && age <= 21) score += 5;
  if (Number(target.card_year) >= 2025) score += 3;
  return Math.max(35, Math.min(92, Math.round(score)));
}

function tierLabel(score) {
  if (score >= 78) return "Priority Watch";
  if (score >= 66) return "Track Closely";
  if (score >= 54) return "Build History";
  return "Needs Data";
}

function productName(target) {
  const query = String(target.card_query || "");
  return query.replace(String(target.card_code || ""), "").trim() || "Bowman Chrome Auto";
}

function isEnabledTarget(row) {
  return String(row?.enabled ?? "true").toLowerCase() !== "false" && String(row?.card_code || "").trim() !== "";
}

function scoreClass(score) {
  if (score >= 70) return "score-high";
  if (score >= 55) return "score-medium";
  return "score-low";
}

function percentNumber(value) {
  if (value === "" || value == null) return NaN;
  const numeric = Number(String(value).replaceAll(/[^0-9.-]/g, ""));
  return Number.isFinite(numeric) ? numeric : NaN;
}

function normalizeName(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replaceAll(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, " ")
    .trim();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
