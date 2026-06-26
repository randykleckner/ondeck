import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = resolve(ROOT, "data");
const SEASON = 2026;
const SPORT_IDS = [1, 11, 12, 13, 14, 16];
const LEVEL_BY_SPORT = new Map([
  [1, "MLB"],
  [11, "AAA"],
  [12, "AA"],
  [13, "A+"],
  [14, "A"],
  [16, "ROK"],
]);
const SOURCE = "MLB Stats API";
const TOP_PROSPECT_STATS_URL = "https://www.mlb.com/prospects/stats/top-prospects";

const orgIdByName = new Map([
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

const prospects = parseCsv(await readFile(resolve(DATA_DIR, "mlb-top100-2026.csv"), "utf8"));
const pagePersonIds = await getMlbProspectPagePersonIds();
const enriched = [];
const statsRows = [];
const depthRows = [];
const errors = [];
const orgContextCache = new Map();

for (const prospect of prospects) {
  try {
    const person = await findPerson(prospect);
    const personDetail = await fetchJson(`/people/${person.id}?hydrate=currentTeam`);
    const current = personDetail.people?.[0] ?? person;
    const orgId = current.currentTeam?.parentOrgId ?? orgIdByName.get(prospect.org);
    const orgContext = orgId ? await getOrgContext(orgId) : emptyOrgContext();
    const statSplits = await getSeasonSplits(person.id, isPitcher(prospect.position));
    const bestSplit = chooseBestSplit(statSplits, prospect.level);
    const recentSplits = await getRecentSplits(person.id, isPitcher(prospect.position), bestSplit?.sportId ?? sportIdForLevel(prospect.level));
    const currentLevel = bestSplit?.level ?? prospect.level;
    const calledUp = Boolean(current.mlbDebutDate) || currentLevel === "MLB";
    const on40 = orgContext.fortyManIds.has(person.id);
    const pathway = buildPathway(prospect, orgContext, { calledUp, on40 });

    enriched.push({
      player_id: prospect.player_id,
      mlbam_id: person.id,
      player_name: prospect.player_name,
      current_team: current.currentTeam?.name ?? "",
      current_team_id: current.currentTeam?.id ?? "",
      org_id: orgId ?? "",
      current_level: currentLevel,
      called_up: calledUp,
      mlb_debut_date: current.mlbDebutDate ?? "",
      on_40man: on40,
      data_source: SOURCE,
      stats_source_url: TOP_PROSPECT_STATS_URL,
      last_updated: today(),
    });

    if (bestSplit) {
      statsRows.push(buildStatsRow(prospect.player_id, bestSplit, recentSplits));
    }

    depthRows.push({
      player_id: prospect.player_id,
      mlb_team_need: pathway.mlb_team_need,
      org_depth: pathway.org_depth,
      mlb_blockers: pathway.mlb_blockers,
      injury_opening: pathway.injury_opening,
      service_time_pressure: pathway.service_time_pressure,
      notes: pathway.notes,
    });

    console.log(`${prospect.prospect_rank}. ${prospect.player_name}: ${currentLevel}, ${calledUp ? "called up" : "watchlist"}`);
  } catch (error) {
    errors.push({ player_id: prospect.player_id, player_name: prospect.player_name, message: error.message });
    console.warn(`Could not enrich ${prospect.player_name}: ${error.message}`);
  }
}

await mkdir(DATA_DIR, { recursive: true });
await writeCsv(resolve(DATA_DIR, "player-enrichment.csv"), enriched);
await writeCsv(resolve(DATA_DIR, "current-stats.csv"), statsRows);
await writeCsv(resolve(DATA_DIR, "depth-chart-current.csv"), depthRows);
await writeFile(
  resolve(DATA_DIR, "enrichment-report.json"),
  `${JSON.stringify(
    {
      season: SEASON,
      source: SOURCE,
      stats_source_url: TOP_PROSPECT_STATS_URL,
      last_updated: today(),
      enriched: enriched.length,
      stats_rows: statsRows.length,
      depth_rows: depthRows.length,
      errors,
    },
    null,
    2,
  )}\n`,
);

console.log(`Wrote ${enriched.length} enrichment rows, ${statsRows.length} stat rows, ${depthRows.length} depth rows.`);

async function findPerson(prospect) {
  const response = await fetchJson(`/people/search?names=${encodeURIComponent(prospect.player_name)}`);
  const candidates = response.people ?? [];
  const scored = [];
  for (const candidate of candidates.filter((row) => row.isPlayer)) {
    const detail = await fetchJson(`/people/${candidate.id}?hydrate=currentTeam`);
    const person = detail.people?.[0] ?? candidate;
    const nameMatch = comparable(person.fullName) === comparable(prospect.player_name);
    const ageGap = Math.abs(number(person.currentAge) - number(prospect.age));
    const orgId = person.currentTeam?.parentOrgId;
    const expectedOrgId = orgIdByName.get(prospect.org);
    const orgMatch = expectedOrgId && orgId === expectedOrgId;
    const positionMatch = positionGroup(person.primaryPosition?.abbreviation) === positionGroup(prospect.position);
    const plausible = person.active !== false && ageGap <= 3 && (orgMatch || !orgId || !expectedOrgId) && positionMatch;
    const score = (nameMatch ? 6 : 0) + (orgMatch ? 4 : 0) + (positionMatch ? 2 : 0) - ageGap;
    if (plausible) {
      scored.push({ person, score });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  if (scored[0]) return scored[0].person;
  const pagePersonId = pagePersonIds.get(comparable(prospect.player_name));
  if (pagePersonId) {
    const detail = await fetchJson(`/people/${pagePersonId}?hydrate=currentTeam`);
    return detail.people?.[0] ?? { id: pagePersonId, fullName: prospect.player_name };
  }
  throw new Error("No MLBAM person match");
}

async function getMlbProspectPagePersonIds() {
  const response = await fetch(TOP_PROSPECT_STATS_URL, { headers: { "User-Agent": "mlb-prospects-local-dashboard" } });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} for ${TOP_PROSPECT_STATS_URL}`);
  }
  const html = await response.text();
  const ids = new Map();
  const linkPattern = /href="https:\/\/www\.milb\.com\/player\/(\d+)">([^<]+)<\/a>/g;
  for (const match of html.matchAll(linkPattern)) {
    ids.set(comparable(decodeHtml(match[2])), Number(match[1]));
  }
  return ids;
}

async function getSeasonSplits(personId, pitcher) {
  const group = pitcher ? "pitching" : "hitting";
  const splits = [];
  for (const sportId of SPORT_IDS) {
    const response = await fetchJson(`/people/${personId}/stats?stats=season&group=${group}&season=${SEASON}&sportId=${sportId}`);
    for (const split of response.stats?.[0]?.splits ?? []) {
      splits.push({ ...split, sportId, level: LEVEL_BY_SPORT.get(sportId) ?? "" });
    }
  }
  return splits;
}

async function getRecentSplits(personId, pitcher, sportId) {
  if (!sportId) return {};
  const end = today();
  const group = pitcher ? "pitching" : "hitting";
  const windows = {};
  for (const days of [14, 30, 60]) {
    const start = offsetDate(-days);
    const response = await fetchJson(
      `/people/${personId}/stats?stats=byDateRange&group=${group}&startDate=${start}&endDate=${end}&sportId=${sportId}`,
    );
    windows[days] = response.stats?.[0]?.splits?.[0] ?? null;
  }
  return windows;
}

function chooseBestSplit(splits, seedLevel) {
  if (!splits.length) return null;
  const priority = ["MLB", "AAA", "AA", "A+", "A"];
  return splits
    .map((split) => ({ ...split, priority: priority.indexOf(split.level), games: Number(split.stat?.gamesPlayed ?? 0) }))
    .sort((a, b) => a.priority - b.priority || b.games - a.games)[0] ?? null;
}

async function getOrgContext(orgId) {
  if (orgContextCache.has(orgId)) return orgContextCache.get(orgId);
  const [active, fortyMan] = await Promise.all([
    fetchRoster(orgId, "active"),
    fetchRoster(orgId, "40Man"),
  ]);
  const context = {
    active,
    fortyMan,
    fortyManIds: new Set(fortyMan.map((row) => row.person?.id).filter(Boolean)),
  };
  orgContextCache.set(orgId, context);
  return context;
}

async function fetchRoster(orgId, rosterType) {
  const response = await fetchJson(`/teams/${orgId}/roster/${rosterType}?season=${SEASON}`);
  return response.roster ?? [];
}

function emptyOrgContext() {
  return { active: [], fortyMan: [], fortyManIds: new Set() };
}

function buildStatsRow(playerId, split, recentSplits) {
  const stat = split.stat ?? {};
  const recent14 = recentSplits[14]?.stat ?? {};
  const recent30 = recentSplits[30]?.stat ?? {};
  const recent60 = recentSplits[60]?.stat ?? {};
  const pa = number(stat.plateAppearances);
  const bb = number(stat.baseOnBalls);
  const so = number(stat.strikeOuts);

  if (stat.era || stat.whip) {
    return {
      player_id: playerId,
      games: stat.gamesPlayed ?? "",
      era: stat.era ?? "",
      whip: stat.whip ?? "",
      k_per_9: stat.strikeoutsPer9Inn ?? "",
      bb_per_9: stat.walksPer9Inn ?? "",
      last_14_era: recent14.era ?? "",
      last_30_era: recent30.era ?? "",
      last_60_era: recent60.era ?? "",
      stat_level: split.level,
      stat_team: split.team?.name ?? "",
      data_source: SOURCE,
      source_url: TOP_PROSPECT_STATS_URL,
    };
  }

  return {
    player_id: playerId,
    games: stat.gamesPlayed ?? "",
    pa: stat.plateAppearances ?? "",
    avg: stat.avg ?? "",
    obp: stat.obp ?? "",
    slg: stat.slg ?? "",
    ops: stat.ops ?? "",
    hr: stat.homeRuns ?? "",
    sb: stat.stolenBases ?? "",
    bb_rate: pa ? round((bb / pa) * 100, 1) : "",
    k_rate: pa ? round((so / pa) * 100, 1) : "",
    last_14_ops: recent14.ops ?? "",
    last_30_ops: recent30.ops ?? "",
    last_60_ops: recent60.ops ?? "",
    stat_level: split.level,
    stat_team: split.team?.name ?? "",
    data_source: SOURCE,
    source_url: TOP_PROSPECT_STATS_URL,
  };
}

function buildPathway(prospect, orgContext, flags) {
  const group = positionGroup(prospect.position);
  const activeBlockers = orgContext.active.filter((row) => positionGroup(row.position?.abbreviation) === group);
  const injuredSameGroup = orgContext.fortyMan.some((row) => positionGroup(row.position?.abbreviation) === group && isInjured(row.status?.code));
  const blockers = flags.calledUp ? 0 : activeBlockers.length;
  const orgDepth = flags.on40 ? 3 : Math.min(8, Math.max(3, blockers + 1));
  const teamNeed = flags.calledUp ? 10 : Math.max(2, 10 - blockers - (flags.on40 ? 0 : 1) + (injuredSameGroup ? 2 : 0));
  const servicePressure = flags.calledUp ? "low" : flags.on40 ? "medium" : "high";
  const blockerNames = activeBlockers.slice(0, 5).map((row) => row.person?.fullName).filter(Boolean).join(", ");
  const roleLabel = group === "P" ? "MLB pitching depth includes" : `MLB ${group} blockers:`;

  return {
    mlb_team_need: Math.max(0, Math.min(10, teamNeed)),
    org_depth: orgDepth,
    mlb_blockers: blockers,
    injury_opening: injuredSameGroup,
    service_time_pressure: servicePressure,
    notes: [
      flags.on40 ? "On the 40-man roster." : "Not currently found on the 40-man roster.",
      blockerNames ? `${roleLabel} ${blockerNames}.` : "",
      injuredSameGroup ? `At least one injured 40-man ${group === "P" ? "pitcher" : group} creates some churn risk.` : "",
    ]
      .filter(Boolean)
      .join(" "),
  };
}

async function fetchJson(path) {
  const url = `https://statsapi.mlb.com/api/v1${path}`;
  const response = await fetch(url, { headers: { "User-Agent": "mlb-prospects-local-dashboard" } });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} for ${url}`);
  }
  return response.json();
}

function parseCsv(text) {
  const rows = [];
  let field = "";
  let row = [];
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '"' && quoted && next === '"') {
      field += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(field);
      field = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(field);
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (field || row.length) {
    row.push(field);
    if (row.some((value) => value.trim())) rows.push(row);
  }
  const headers = rows[0].map((header) => header.trim().toLowerCase().replaceAll(/\s+/g, "_"));
  return rows.slice(1).map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
}

async function writeCsv(path, rows) {
  const headers = [...rows.reduce((set, row) => {
    Object.keys(row).forEach((key) => set.add(key));
    return set;
  }, new Set())];
  const lines = [headers.join(","), ...rows.map((row) => headers.map((header) => escapeCsv(row[header])).join(","))];
  await writeFile(path, `${lines.join("\n")}\n`);
}

function escapeCsv(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function positionGroup(position) {
  const value = String(position ?? "").toUpperCase();
  if (value.includes("P")) return "P";
  if (value.includes("C") && !value.includes("CF")) return "C";
  if (value.includes("OF") || value.includes("LF") || value.includes("CF") || value.includes("RF")) return "OF";
  if (value.includes("1B") || value.includes("2B") || value.includes("3B") || value.includes("SS") || value.includes("INF")) return "INF";
  return value || "UNK";
}

function isPitcher(position) {
  return positionGroup(position) === "P";
}

function isInjured(statusCode) {
  return String(statusCode ?? "").startsWith("D");
}

function sportIdForLevel(level) {
  const entry = [...LEVEL_BY_SPORT.entries()].find(([, value]) => value === String(level ?? "").toUpperCase());
  return entry?.[0] ?? 11;
}

function comparable(value) {
  return String(value ?? "").normalize("NFD").replaceAll(/[\u0300-\u036f]/g, "").toLowerCase();
}

function decodeHtml(value) {
  return String(value ?? "")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&apos;", "'")
    .replaceAll("&ntilde;", "ñ")
    .replaceAll("&Ntilde;", "Ñ")
    .replaceAll("&eacute;", "é")
    .replaceAll("&Eacute;", "É")
    .replaceAll("&aacute;", "á")
    .replaceAll("&Aacute;", "Á")
    .replaceAll("&iacute;", "í")
    .replaceAll("&Iacute;", "Í")
    .replaceAll("&oacute;", "ó")
    .replaceAll("&Oacute;", "Ó")
    .replaceAll("&uacute;", "ú")
    .replaceAll("&Uacute;", "Ú");
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function round(value, places) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function today() {
  return "2026-06-26";
}

function offsetDate(offsetDays) {
  const date = new Date(`${today()}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}
