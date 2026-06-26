const LEVEL_SCORE = {
  MLB: 100,
  AAA: 88,
  AA: 70,
  "A+": 46,
  A: 34,
  ROK: 12,
  RK: 12,
};

export function mergeProspectData(prospects, stats, depthCharts) {
  const statsById = indexByPlayerId(stats);
  const depthById = indexByPlayerId(depthCharts);

  return prospects.map((prospect) => {
    const player = {
      ...prospect,
      ...(statsById.get(String(prospect.player_id)) ?? {}),
      ...(depthById.get(String(prospect.player_id)) ?? {}),
    };
    return scorePlayer(player);
  });
}

export function scorePlayer(player) {
  const performance = performanceScore(player);
  const opportunity = opportunityScore(player);
  const readiness = readinessScore(player);
  const score = Math.round(performance * 0.42 + opportunity * 0.38 + readiness * 0.2);
  const signal = score >= 60 ? "Green" : score >= 50 ? "Yellow" : "Red";

  return {
    ...player,
    performance_score: Math.round(performance),
    opportunity_score: Math.round(opportunity),
    readiness_score: Math.round(readiness),
    callup_score: score,
    signal,
    insights: buildInsights(player, { performance, opportunity, readiness, score }),
  };
}

function performanceScore(player) {
  if (!hasStatInput(player)) {
    return inferredPerformanceScore(player);
  }

  if (isPitcher(player.position)) {
    const era = inverseScale(numberOr(player.era, 5.2), 2.2, 5.2);
    const whip = inverseScale(numberOr(player.whip, 1.55), 0.9, 1.55);
    const strikeouts = scale(numberOr(player.k_per_9, 7), 7, 13);
    const walks = inverseScale(numberOr(player.bb_per_9, 4.2), 1.5, 4.2);
    const recent = inverseScale(numberOr(recentPitcherValue(player), player.era || 5), 2.0, 5.0);
    return clamp(era * 0.24 + whip * 0.22 + strikeouts * 0.2 + walks * 0.16 + recent * 0.18);
  }

  const terms = [];
  if (hasValue(player.ops)) {
    terms.push({ value: scale(Number(player.ops), 0.66, 1.0), weight: 0.25 });
  }
  if (hasValue(player.wrc_plus)) {
    terms.push({ value: scale(Number(player.wrc_plus), 86, 150), weight: 0.28 });
  }
  if (recentHitterValue(player) != null || hasValue(player.ops)) {
    const recentOps = recentHitterValue(player) ?? Number(player.ops);
    terms.push({ value: scale(recentOps, 0.66, 1.05), weight: 0.2 });
  }
  if (hasValue(player.k_rate) || hasValue(player.bb_rate)) {
    const approach = inverseScale(numberOr(player.k_rate, 29), 16, 33) * 0.55 + scale(numberOr(player.bb_rate, 6), 6, 15) * 0.45;
    terms.push({ value: approach, weight: 0.17 });
  }
  if (hasValue(player.hr) || hasValue(player.sb)) {
    terms.push({ value: scale(numberOr(player.hr, 0) + numberOr(player.sb, 0), 4, 28), weight: 0.1 });
  }
  return weightedAverage(terms, inferredPerformanceScore(player));
}

function opportunityScore(player) {
  if (isMlbLevel(player)) {
    return 100;
  }

  const teamNeed = scale(numberOr(player.mlb_team_need, inferredTeamNeed(player)), 0, 10);
  const orgDepth = inverseScale(numberOr(player.org_depth, inferredOrgDepth(player)), 1, 8);
  const blockers = inverseScale(numberOr(player.mlb_blockers, inferredBlockers(player)), 0, 6);
  const fortyMan = parseBoolean(player.on_40man) ? 100 : 42;
  const injuryOpening = parseBoolean(player.injury_opening) ? 100 : 45;
  const pressure = serviceTimeScore(player.service_time_pressure);

  return clamp(teamNeed * 0.28 + orgDepth * 0.2 + blockers * 0.2 + fortyMan * 0.16 + injuryOpening * 0.1 + pressure * 0.06);
}

function readinessScore(player) {
  const level = LEVEL_SCORE[String(player.level ?? "").toUpperCase()] ?? 45;
  const rank = inverseScale(numberOr(player.prospect_rank, 100), 1, 100);
  const eta = numberOr(player.eta, 2028) <= new Date().getFullYear() ? 100 : 55;
  const ageFit = ageToLevelScore(player.age, player.level);
  return clamp(level * 0.38 + rank * 0.28 + eta * 0.16 + ageFit * 0.18);
}

function buildInsights(player, scores) {
  const insights = [];
  const name = player.player_name || "This player";

  if (isMlbLevel(player)) {
    insights.push(`${name} is already listed at MLB level, so this profile should be treated as post-call-up, not a pre-call-up target.`);
  }

  const statSummary = buildStatSummary(player);
  if (statSummary) {
    insights.push(statSummary);
  } else {
    insights.push("Current stats: no 2026 MLB/MiLB stat line found in the public feed yet; this score is leaning more heavily on rank, level, ETA, and age-to-level.");
  }

  const recentSummary = buildRecentSummary(player);
  if (recentSummary) {
    insights.push(recentSummary);
  } else if (!statSummary) {
    insights.push("Trend check: no 14/30/60-day stat window is available until a current stat line appears in the public feed.");
  }

  if (player.rank_trend_note) {
    insights.push(`Rank movement: ${player.rank_trend_note}`);
  }

  const pathSummary = buildPathSummary(player);
  if (pathSummary) {
    insights.push(pathSummary);
  } else if (scores.opportunity < 45) {
    insights.push("Roster pathway is the main drag on the score right now.");
  } else if (scores.opportunity >= 72) {
    insights.push("Organization context is helping the call-up case.");
  }

  return insights;
}

function buildStatSummary(player) {
  if (isPitcher(player.position)) {
    if (!hasAny(player, ["era", "whip", "k_per_9"])) return "";
    return `Current stats: ${sourcePrefix(player)}${player.games ? `${player.games} G, ` : ""}${player.era ? `${player.era} ERA` : ""}${player.whip ? `, ${player.whip} WHIP` : ""}${player.k_per_9 ? `, ${player.k_per_9} K/9` : ""}${player.bb_per_9 ? `, ${player.bb_per_9} BB/9` : ""}.`;
  }
  if (!hasAny(player, ["ops", "avg", "obp", "slg"])) return "";
  return `Current stats: ${sourcePrefix(player)}${slashLine(player)}${player.ops ? `, ${formatDecimal(player.ops, 3)} OPS` : ""}${player.hr !== "" && player.hr != null ? `, ${player.hr} HR` : ""}${player.sb !== "" && player.sb != null ? `, ${player.sb} SB` : ""}${player.bb_rate ? `, ${player.bb_rate}% BB` : ""}${player.k_rate ? `, ${player.k_rate}% K` : ""}.`;
}

function buildRecentSummary(player) {
  if (isPitcher(player.position)) {
    const window = recentPitcherWindow(player);
    if (!window) {
      if (hasValue(player.era)) {
        return `Trend check: recent 14/30/60-day ERA split is not available yet; season baseline is ${formatEra(player.era)} ERA.`;
      }
      return "";
    }
    const recentEra = Number(window.value);
    const seasonEra = Number(player.era);
    if (Number.isFinite(recentEra) && Number.isFinite(seasonEra)) {
      if (recentEra <= seasonEra - 0.35) {
        return `Trend check: ${formatEra(window.value)} ERA over the last ${window.days} days, better than the season ${formatEra(player.era)} ERA. Run prevention is trending up.`;
      }
      if (recentEra >= seasonEra + 0.35) {
        return `Trend check: ${formatEra(window.value)} ERA over the last ${window.days} days, worse than the season ${formatEra(player.era)} ERA. Run prevention is trending down.`;
      }
      return `Trend check: ${formatEra(window.value)} ERA over the last ${window.days} days, roughly in line with the season ${formatEra(player.era)} ERA.`;
    }
    return `Trend check: ${formatEra(window.value)} ERA over the last ${window.days} days.`;
  }
  if (!isPitcher(player.position)) {
    const window = recentHitterWindow(player);
    if (!window) {
      if (hasValue(player.ops)) {
        return `Trend check: recent 14/30/60-day OPS split is not available yet; season baseline is ${formatDecimal(player.ops, 3)} OPS.`;
      }
      return "";
    }
    const recentOps = Number(window.value);
    const seasonOps = Number(player.ops);
    if (Number.isFinite(recentOps) && Number.isFinite(seasonOps)) {
      if (recentOps >= seasonOps + 0.05) {
        return `Trend check: ${formatDecimal(window.value, 3)} OPS over the last ${window.days} days, above the season ${formatDecimal(player.ops, 3)} OPS. Bat is trending up.`;
      }
      if (recentOps <= seasonOps - 0.05) {
        return `Trend check: ${formatDecimal(window.value, 3)} OPS over the last ${window.days} days, below the season ${formatDecimal(player.ops, 3)} OPS. Bat is trending down.`;
      }
      return `Trend check: ${formatDecimal(window.value, 3)} OPS over the last ${window.days} days, close to the season ${formatDecimal(player.ops, 3)} OPS.`;
    }
    return `Trend check: ${formatDecimal(window.value, 3)} OPS over the last ${window.days} days.`;
  }
  return "";
}

function recentHitterWindow(player) {
  return firstWindowValue(player, [
    ["last_14_ops", 14],
    ["last_30_ops", 30],
    ["last_60_ops", 60],
  ]);
}

function recentPitcherWindow(player) {
  return firstWindowValue(player, [
    ["last_14_era", 14],
    ["last_30_era", 30],
    ["last_60_era", 60],
  ]);
}

function recentHitterValue(player) {
  return recentHitterWindow(player)?.value ?? null;
}

function recentPitcherValue(player) {
  return recentPitcherWindow(player)?.value ?? null;
}

function firstWindowValue(player, fields) {
  for (const [field, days] of fields) {
    const value = Number(player[field]);
    if (hasValue(player[field]) && Number.isFinite(value)) {
      return { value, days };
    }
  }
  return null;
}

function buildPathSummary(player) {
  const details = [];
  const fortyManKnown = player.on_40man !== "" && player.on_40man != null;
  if (player.mlb_blockers !== "" && player.mlb_blockers != null) {
    details.push(isPitcher(player.position) ? `${player.mlb_blockers} active MLB pitchers in the current depth picture` : `${player.mlb_blockers} MLB role blockers`);
  }
  if (player.mlb_team_need !== "" && player.mlb_team_need != null) {
    details.push(`${player.mlb_team_need}/10 team-need score`);
  }
  if (player.notes) {
    details.push(cleanPathNote(player.notes, fortyManKnown));
  }
  return details.filter(Boolean).length ? `Pathway: ${details.filter(Boolean).join("; ")}.` : "";
}

function sourcePrefix(player) {
  const parts = [player.stat_team, player.stat_level].filter(Boolean);
  return parts.length ? `${parts.join(" · ")}: ` : "";
}

function slashLine(player) {
  const avg = formatDecimal(player.avg, 3) || "---";
  const obp = formatDecimal(player.obp, 3) || "---";
  const slg = formatDecimal(player.slg, 3) || "---";
  return `${avg}/${obp}/${slg}`;
}

function hasAny(player, fields) {
  return fields.some((field) => player[field] !== "" && player[field] != null);
}

function hasValue(value) {
  return value !== "" && value != null;
}

function formatDecimal(value, places) {
  if (value === "" || value == null) return "";
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return String(value);
  const fixed = numeric.toFixed(places);
  return fixed.startsWith("0.") ? fixed.slice(1) : fixed;
}

function formatEra(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return String(value);
  return numeric.toFixed(2);
}

function cleanPathNote(note, hasFortyManStatus) {
  let text = String(note ?? "").trim();
  if (hasFortyManStatus) {
    text = text
      .replace(/^Not currently found on the 40-man roster\.\s*/i, "")
      .replace(/^On the 40-man roster\.\s*/i, "");
  }
  return text
    .replace(/^MLB P blockers:/i, "MLB pitching depth includes")
    .replace(/\binjured 40-man\b/gi, "injured MLB")
    .replace(/\.\.+/g, ".")
    .replace(/\.$/, "");
}

function indexByPlayerId(records) {
  return new Map(records.map((record) => [String(record.player_id), record]));
}

function isPitcher(position) {
  return String(position ?? "").toUpperCase().includes("P");
}

function isMlbLevel(player) {
  return String(player.level ?? "").toUpperCase() === "MLB";
}

function hasStatInput(player) {
  const fields = ["ops", "wrc_plus", "era", "whip", "k_per_9", "last_14_ops", "last_30_ops", "last_60_ops", "last_14_era", "last_30_era", "last_60_era"];
  return fields.some((field) => player[field] !== "" && player[field] != null);
}

function inferredPerformanceScore(player) {
  if (isMlbLevel(player)) {
    return 100;
  }
  const level = LEVEL_SCORE[String(player.level ?? "").toUpperCase()] ?? 45;
  const rank = inverseScale(numberOr(player.prospect_rank, 100), 1, 100);
  const etaBoost = numberOr(player.eta, 2028) <= new Date().getFullYear() ? 76 : 52;
  return clamp(level * 0.38 + rank * 0.28 + etaBoost * 0.24 + ageToLevelScore(player.age, player.level) * 0.1);
}

function inferredTeamNeed(player) {
  if (isMlbLevel(player)) return 10;
  if (parseBoolean(player.on_40man)) return 7;
  return numberOr(player.eta, 2028) <= new Date().getFullYear() ? 6 : 4;
}

function inferredOrgDepth(player) {
  if (isMlbLevel(player)) return 1;
  if (parseBoolean(player.on_40man)) return 3;
  return numberOr(player.eta, 2028) <= new Date().getFullYear() ? 4 : 6;
}

function inferredBlockers(player) {
  if (isMlbLevel(player)) return 0;
  if (parseBoolean(player.on_40man)) return 2;
  return numberOr(player.eta, 2028) <= new Date().getFullYear() ? 3 : 5;
}

function scale(value, low, high) {
  return clamp(((value - low) / (high - low)) * 100);
}

function weightedAverage(terms, fallback) {
  const available = terms.filter((term) => Number.isFinite(term.value) && Number.isFinite(term.weight) && term.weight > 0);
  const weight = available.reduce((sum, term) => sum + term.weight, 0);
  if (!weight) return fallback;
  return clamp(available.reduce((sum, term) => sum + term.value * term.weight, 0) / weight);
}

function inverseScale(value, low, high) {
  return 100 - scale(value, low, high);
}

function ageToLevelScore(age, level) {
  const value = numberOr(age, 24);
  const expected = { AAA: 24, AA: 23, "A+": 22, A: 21 }[String(level ?? "").toUpperCase()] ?? 24;
  return clamp(70 + (expected - value) * 10);
}

function serviceTimeScore(value) {
  const normalized = String(value ?? "").toLowerCase();
  if (normalized === "low") return 92;
  if (normalized === "medium") return 68;
  if (normalized === "high") return 35;
  return 58;
}

function parseBoolean(value) {
  return value === true || String(value).toLowerCase() === "true" || String(value).toLowerCase() === "yes";
}

function numberOr(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function clamp(value) {
  return Math.max(0, Math.min(100, value));
}
