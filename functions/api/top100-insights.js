import { parseCsv } from "../../src/lib/csv.js";
import { mergeProspectData } from "../../src/lib/scoring.js";

export const ON_DECK_MIN_SCORE = 60;
export const ON_DECK_ALLOWED_ACTIONS = [
  "Strong Buy",
  "Buy Zone",
  "Watch Buy Zone",
  "Watch",
  "Research",
  "Needs Market",
];

const BOARD_TYPE = "top100";
const PROMPT_VERSION = "top100-dynamic-briefing-v4";
const MODEL_PROVIDER = "cloudflare-workers-ai";
const DEFAULT_MODEL = "@cf/meta/llama-3.2-3b-instruct";
const ALLOWED_ACTIONS = [
  "Strong Buy",
  "Buy Zone",
  "Watch",
  "Research",
  "Needs Market",
  "No Liquidity",
  "Avoid Chase",
];
const ALLOWED_CONFIDENCE = ["High", "Medium-High", "Medium", "Low"];
const REQUIRED_MODEL_FIELDS = [
  "call",
  "confidence",
  "thesis",
  "why_now",
  "market_read",
  "edge",
  "risk",
  "next_trigger",
  "do_not_buy_if",
  "sources_json",
];

export async function onTop100InsightsRequest(context) {
  const url = new URL(context.request.url);
  if (context.request.method === "GET" && url.searchParams.get("top10") === "true") {
    return jsonResponse(await readCurrentOnDeckInsights(context.env?.MARKET_DB));
  }
  if (context.request.method === "GET") {
    const player = url.searchParams.get("player") || url.searchParams.get("player_id") || "Josuar Gonzalez";
    const skipAi = url.searchParams.get("skip_ai") === "true";
    const packet = await buildTop100InsightPacket(context.env, player, { context });
    if (skipAi) return jsonResponse({ status: "ok", dryRun: true, packet });
    const { insight: validated, rawModelResponse: modelResponse, quality } = await generateValidatedInsight(context.env, packet);
    return jsonResponse({
      status: "ok",
      dryRun: true,
      internal_packet: packet.internal_context,
      research_context: packet.research_context,
      data_gaps: packet.data_gaps,
      raw_ai_response: modelResponse,
      parsed_ai_response: validated,
      quality,
      packet,
    });
  }
  if (context.request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed." }, 405, { Allow: "GET, POST" });
  }

  const result = await runTop100InsightPipeline(context, {
    player: url.searchParams.get("player") || "",
    limit: numericParam(url.searchParams.get("limit"), 10),
    offset: numericParam(url.searchParams.get("offset"), 0),
    force: url.searchParams.get("force") === "true",
    dryRun: url.searchParams.get("dry_run") === "true",
    skipAi: url.searchParams.get("skip_ai") === "true",
  });
  return jsonResponse(result);
}

export async function onPlayerInsightRequest(context) {
  if (context.request.method !== "GET") {
    return jsonResponse({ error: "Method not allowed." }, 405, { Allow: "GET" });
  }
  const db = context.env?.MARKET_DB;
  if (!db) return jsonResponse({ insight: null, status: "empty", message: "MARKET_DB is not configured." });
  const url = new URL(context.request.url);
  const playerId = url.searchParams.get("player_id") || url.searchParams.get("id") || "";
  const playerName = url.searchParams.get("player") || "";
  if (!playerId && !playerName) return jsonResponse({ insight: null, status: "empty", message: "No player id supplied." });
  const insight = await readCurrentInsight(db, playerId || playerName, BOARD_TYPE);
  return jsonResponse({
    insight: insight ? insightRowToApi(insight) : null,
    status: insight ? "ok" : "empty",
  }, 200, {
    "Cache-Control": "public, max-age=300",
  });
}

export async function runTop100InsightPipeline(context, options = {}) {
  const env = context.env || context;
  const db = env.MARKET_DB;
  if (!db) return { status: "error", message: "MARKET_DB D1 binding is required." };
  const startedAt = new Date().toISOString();
  const summary = {
    jobName: "top100_weekly_insights",
    startedAt,
    completedAt: "",
    status: "running",
    playersChecked: 0,
    marketQueriesUsed: Number(options.marketQueriesUsed) || 0,
    packetsBuilt: 0,
    aiCallsAttempted: 0,
    aiCallsSkipped: 0,
    insightsCreated: 0,
    insightsReused: 0,
    insightsFailed: 0,
    onDeckTop10Updated: 0,
    errors: [],
    results: [],
  };

  const data = await loadTop100SourceData({ env, request: context.request });
  const filter = normalizeName(options.player || "");
  const pool = data.scored.filter((player) => {
    if (!filter) return true;
    return String(player.player_id) === options.player || normalizeName(player.player_name).includes(filter);
  });
  const offset = Math.max(0, Number(options.offset) || 0);
  const limit = Math.max(1, Math.min(500, Number(options.limit) || pool.length || 100));
  const selected = pool.slice(offset, offset + limit);

  for (const player of selected) {
    summary.playersChecked += 1;
    try {
      const packet = await buildTop100InsightPacket(env, player.player_id, { context, data });
      packet.opportunity.opportunity_score = computeCardMarketOpportunityScore(packet);
      summary.packetsBuilt += 1;
      const hash = await hashInsightPacket(packet);
      const current = await readCurrentInsight(db, packet.player.player_id, BOARD_TYPE);
      if (!options.force && current?.input_data_hash === hash && isFutureDate(current.expires_at)) {
        summary.insightsReused += 1;
        summary.aiCallsSkipped += 1;
        summary.results.push({ playerId: packet.player.player_id, playerName: packet.player.player_name, status: "reused" });
        continue;
      }
      if (options.skipAi) {
        summary.aiCallsSkipped += 1;
        summary.results.push({ playerId: packet.player.player_id, playerName: packet.player.player_name, status: "packet-only" });
        continue;
      }
      summary.aiCallsAttempted += 1;
      const { insight, rawModelResponse, attempts, quality } = await generateValidatedInsight(env, packet);
      summary.aiCallsAttempted += attempts - 1;
      if (!quality?.ok) {
        summary.insightsFailed += options.dryRun ? 0 : 1;
        summary.results.push({
          playerId: packet.player.player_id,
          playerName: packet.player.player_name,
          status: options.dryRun ? "dry-run-quality-failed" : "quality-failed-not-saved",
          finalAction: insight.final_action,
          qualityErrors: quality?.errors || [],
        });
        continue;
      }
      const eligible = computeOnDeckEligibility(packet, insight);
      if (!options.dryRun) {
        await saveInsightSnapshot(db, {
          packet,
          insight,
          inputDataHash: hash,
          modelName: DEFAULT_MODEL,
          onDeckEligible: eligible,
          refreshReason: current ? "packet_changed_or_forced" : "new_player",
          rawModelResponse,
        });
      }
      summary.insightsCreated += options.dryRun ? 0 : 1;
      summary.results.push({
        playerId: packet.player.player_id,
        playerName: packet.player.player_name,
        status: options.dryRun ? "dry-run-valid" : "created",
        finalAction: insight.final_action,
        onDeckEligible: eligible,
      });
    } catch (error) {
      summary.insightsFailed += 1;
      summary.errors.push({ player: player.player_name || player.player_id, message: safeErrorMessage(error) });
    }
  }

  const top10 = await readCurrentOnDeckInsights(db);
  summary.onDeckTop10Updated = top10.items.length;
  summary.completedAt = new Date().toISOString();
  summary.status = summary.errors.length ? "partial" : "success";
  if (!options.dryRun) await logInsightRun(db, summary);
  return summary;
}

export async function buildTop100InsightPacket(env, playerId, options = {}) {
  const data = options.data || await loadTop100SourceData({ env, request: options.context?.request });
  const player = findPlayer(data.scored, playerId);
  if (!player) throw new Error(`Top 100 player not found: ${playerId}`);
  const market = await readMarketSnapshot(env.MARKET_DB, player.player_id);
  const cardTarget = data.cardTargetsById.get(String(player.player_id)) || data.cardTargetsByName.get(normalizeName(player.player_name)) || null;
  const rankTrend = await readRankTrend(env.MARKET_DB, player);
  const top100Rank = numberOrNull(player.prospect_rank);
  const previousRank = numberOrNull(rankTrend?.previous_rank ?? player.previous_rank);
  const rankMovement = numberOrNull(rankTrend?.movement ?? player.rank_movement) ?? derivedRankMovement(previousRank, top100Rank);
  const packet = compactObject({
    player: compactObject({
      player_id: player.player_id,
      player_name: player.player_name,
      organization: player.org || null,
      team: player.stat_team || player.current_team || null,
      position: player.position || null,
      level: player.level || null,
      age: numberOrNull(player.age),
      eta: player.eta || null,
      top100_rank: top100Rank,
      rank_movement: rankMovement,
      previous_rank: previousRank,
    }),
    stats: compactObject({
      games: numberOrNull(player.games),
      avg: decimalOrNull(player.avg),
      obp: decimalOrNull(player.obp),
      slg: decimalOrNull(player.slg),
      ops: decimalOrNull(player.ops),
      hr: numberOrNull(player.hr),
      sb: numberOrNull(player.sb),
      bb_rate: decimalOrNull(player.bb_rate),
      k_rate: decimalOrNull(player.k_rate),
      era: pitcherStatOrNull(player, "era"),
      whip: pitcherStatOrNull(player, "whip"),
      k_per_9: pitcherStatOrNull(player, "k_per_9"),
      bb_per_9: pitcherStatOrNull(player, "bb_per_9"),
      last_14_ops: decimalOrNull(player.last_14_ops),
      last_30_ops: decimalOrNull(player.last_30_ops),
      last_60_ops: decimalOrNull(player.last_60_ops),
      last_14_era: pitcherStatOrNull(player, "last_14_era"),
      last_30_era: pitcherStatOrNull(player, "last_30_era"),
      last_60_era: pitcherStatOrNull(player, "last_60_era"),
    }),
    opportunity: compactObject({
      callup_score: numberOrNull(player.callup_score),
      opportunity_score: numberOrNull(player.opportunity_score),
      performance_score: numberOrNull(player.performance_score),
      readiness_score: numberOrNull(player.readiness_score),
      mlb_team_need: numberOrNull(player.mlb_team_need),
      mlb_blockers: numberOrNull(player.mlb_blockers),
      org_depth: numberOrNull(player.org_depth),
      on_40man: booleanOrNull(player.on_40man),
      injury_opening: booleanOrNull(player.injury_opening),
      depth_note: player.notes || null,
      known_risks: riskList(player),
      next_likely_trigger: nextTrigger(player),
    }),
    card: compactObject({
      target_exists: Boolean(cardTarget?.card_code),
      card_code: cardTarget?.card_code || player.card_code || null,
      card_query: cardTarget?.card_query || player.card_query || null,
      card_year: cardTarget?.card_year || player.card_year || null,
      sell_through_30: numberOrNull(cardTarget?.sell_through_30 ?? player.sell_through_30),
      sell_through_90: numberOrNull(cardTarget?.sell_through_90 ?? player.sell_through_90),
      sellers_30: numberOrNull(cardTarget?.sellers_30 ?? player.sellers_30),
      sellers_90: numberOrNull(cardTarget?.sellers_90 ?? player.sellers_90),
    }),
    market: compactObject({
      market_exists: Boolean(market && (Number(market.sales_count_30d) > 0 || Number(market.sales_count_90d) > 0 || market.last_sold_price != null)),
      sales_count_30d: numberOrNull(market?.sales_count_30d),
      sales_count_90d: numberOrNull(market?.sales_count_90d),
      avg_price_30d: numberOrNull(market?.avg_sold_price_30d),
      avg_price_90d: numberOrNull(market?.avg_sold_price_90d),
      last_sold_price: numberOrNull(market?.last_sold_price),
      last_sold_at: market?.last_sold_at || null,
      active_listing_count: numberOrNull(market?.active_listing_count),
      sell_thru_rate_30d: numberOrNull(market?.sell_thru_rate_30d),
      sell_thru_rate_90d: numberOrNull(market?.sell_thru_rate_90d),
      liquidity: liquidityLabel(market, cardTarget),
      trend: marketTrend(market),
      checked_at: market?.checked_at || null,
    }),
  });
  packet.opportunity.opportunity_score = computeCardMarketOpportunityScore(packet);
  if (packet.opportunity.opportunity_score >= ON_DECK_MIN_SCORE && Array.isArray(packet.opportunity.known_risks)) {
    packet.opportunity.known_risks = packet.opportunity.known_risks
      .filter((risk) => !String(risk).includes("Opportunity score is below the On Deck threshold."));
  }
  packet.internal_context = {
    player: packet.player,
    stats: packet.stats,
    opportunity: packet.opportunity,
    card: packet.card,
    market: packet.market,
  };
  packet.research_context = await collectPlayerResearchContext(packet.player);
  packet.data_gaps = buildDataGaps(packet);
  return packet;
}

export async function collectPlayerResearchContext(player) {
  void player;
  return [];
}

function buildDataGaps(packet) {
  const gaps = [];
  if (!packet.research_context?.length) gaps.push("No external player-news research context has been supplied yet.");
  if (!packet.market?.market_exists) gaps.push("No confirmed benchmark sold-comps market snapshot is available.");
  if (!packet.stats || !Object.keys(packet.stats).length) gaps.push("Current stat snapshot is incomplete.");
  if (packet.player?.rank_movement == null) gaps.push("Top 100 movement trend is missing or not yet recorded.");
  return gaps;
}

export async function hashInsightPacket(packet) {
  const stable = JSON.stringify(sortKeys(packet));
  const bytes = new TextEncoder().encode(stable);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function generatePlayerInsightWithWorkersAI(env, packet) {
  if (!env?.AI?.run) throw new Error("Workers AI binding AI is not configured.");
  const baseBriefing = buildDynamicInsight(packet);
  const result = await env.AI.run(DEFAULT_MODEL, {
    messages: [
      {
        role: "system",
        content: [
          "You are a strict prospect card-market analyst writing a concise OnDeck player briefing.",
          "Use internal_context and supplied research_context only. Do not invent stats, prices, sales counts, rankings, injuries, promotions, transactions, or sources.",
          "Do not copy the base_briefing. Use it as facts, then make a judgment about the most important tension in the profile.",
          "The judgment should explain whether the baseball signal is ahead of the card market, the market is ahead of the player, or the profile is only a watch.",
          "Do not use philosophy language. Do not say source-backed research is missing. Do not repeat the same template for every player.",
          "Make the content about this player only: level, rank trend, current form, promotion trigger, market volume, price trend, liquidity, and buy discipline.",
          "Cite only supplied research_context entries in sources_json.",
          "Return one valid minified JSON object and nothing else.",
          "Required keys: call, confidence, thesis, why_now, market_read, edge, risk, next_trigger, do_not_buy_if, sources_json.",
          `call must be one of: ${ALLOWED_ACTIONS.join(", ")}.`,
          `confidence must be one of: ${ALLOWED_CONFIDENCE.join(", ")}.`,
          "sources_json must be an array of source urls used from research_context; use [] if none.",
          "Keep each string value under 240 characters. Escape quotes inside strings.",
        ].join(" "),
      },
      {
        role: "user",
        content: JSON.stringify({
          base_briefing: baseBriefing,
          internal_context: packet.internal_context,
          research_context: packet.research_context,
          data_gaps: packet.data_gaps,
        }),
      },
    ],
    temperature: 0,
    max_tokens: 700,
  });
  return result;
}

async function generateValidatedInsight(env, packet) {
  let lastError;
  let lastRawModelResponse = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const rawModelResponse = await generatePlayerInsightWithWorkersAI(env, packet);
    lastRawModelResponse = rawModelResponse;
    try {
      const insight = mergeInsightWithDynamicBase(validateInsightResponse(rawModelResponse), packet);
      const quality = validateInsightQuality(insight, packet);
      if (!quality.ok) {
        const qualityError = new Error(`Insight quality failed: ${quality.errors.join("; ")}`);
        qualityError.quality = quality;
        throw qualityError;
      }
      return {
        insight,
        rawModelResponse,
        quality,
        attempts: attempt,
      };
    } catch (error) {
      lastError = error;
    }
  }
  const fallback = buildDynamicInsight(packet);
  return {
    insight: fallback,
    rawModelResponse: {
      last_ai_response: lastRawModelResponse,
      fallbackReason: safeErrorMessage(lastError),
      quality_errors_json: lastError?.quality?.errors || [],
      packetHash: await hashInsightPacket(packet),
    },
    quality: { ok: true, errors: [], fallback_errors_json: lastError?.quality?.errors || [safeErrorMessage(lastError)] },
    attempts: 2,
  };
}

export function validateInsightResponse(raw) {
  if (raw?.response && typeof raw.response === "object" && !Array.isArray(raw.response)) {
    raw = raw.response;
  }
  const text = typeof raw === "string"
    ? raw
    : raw?.response || raw?.result?.response || raw?.output_text || raw?.text || JSON.stringify(raw);
  const parsed = parseModelJson(text);
  const mapped = mapInsightFields(parsed);
  for (const field of REQUIRED_MODEL_FIELDS) {
    if (field === "sources_json") continue;
    if (typeof mapped[field] !== "string" || !mapped[field].trim()) {
      throw new Error(`Workers AI response missing ${field}.`);
    }
    mapped[field] = mapped[field].trim();
  }
  if (!Array.isArray(mapped.sources_json)) {
    throw new Error("Workers AI response missing sources_json.");
  }
  if (!ALLOWED_ACTIONS.includes(mapped.call)) {
    throw new Error(`Invalid call: ${mapped.call}`);
  }
  if (!ALLOWED_CONFIDENCE.includes(mapped.confidence)) {
    throw new Error(`Invalid confidence: ${mapped.confidence}`);
  }
  return {
    ...mapped,
    final_action: mapped.call,
    resume: mapped.thesis,
    signals: mapped.why_now,
    card_market_take: mapped.market_read,
    what_would_change_my_mind: mapped.do_not_buy_if,
  };
}

function mapInsightFields(parsed) {
  return {
    call: parsed.call || parsed.final_action || parsed.action || "Research",
    confidence: parsed.confidence || "Low",
    thesis: parsed.thesis || parsed.resume || "",
    why_now: parsed.why_now || parsed.signals || "",
    market_read: parsed.market_read || parsed.card_market_take || "",
    edge: parsed.edge || "",
    risk: parsed.risk || "",
    next_trigger: parsed.next_trigger || "",
    do_not_buy_if: parsed.do_not_buy_if || parsed.what_would_change_my_mind || "",
    sources_json: Array.isArray(parsed.sources_json) ? parsed.sources_json : [],
  };
}

function validateInsightQuality(insight, packet) {
  const errors = [];
  const name = String(packet?.player?.player_name || "").split(/\s+/)[0]?.toLowerCase();
  const suppliedUrls = new Set((packet?.research_context || []).map((source) => String(source.url || "")));
  const genericPhrases = [
    "monitor progress",
    "if performance declines",
    "could be a good opportunity",
    "player attention may move",
    "source-backed research is missing",
    "baseball path and collector attention",
    "edge is strongest",
    "main risk is timing",
  ];
  if (isGenericMemoText(insight.thesis, name, genericPhrases)) errors.push("thesis is generic or missing player-specific detail");
  if (isGenericMemoText(insight.why_now, name, genericPhrases)) errors.push("why_now lacks a specific player fact");
  if (!/(price|avg|sales|liquid|liquidity|thin|buyable|chased|market|volume)/i.test(insight.market_read || "")) errors.push("market_read lacks price/liquidity interpretation");
  if (/monitor progress/i.test(insight.next_trigger || "")) errors.push("next_trigger is generic");
  if (/if performance declines/i.test(insight.do_not_buy_if || "")) errors.push("do_not_buy_if is generic");
  for (const url of insight.sources_json || []) {
    if (!suppliedUrls.has(String(url))) errors.push(`sources_json references unsupplied source: ${url}`);
  }
  return { ok: errors.length === 0, errors };
}

function isGenericMemoText(value, playerToken, genericPhrases) {
  const text = String(value || "").toLowerCase();
  if (!text || text.length < 35) return true;
  if (genericPhrases.some((phrase) => text.includes(phrase))) return true;
  if (playerToken && !text.includes(playerToken) && !hasSpecificPlayerFact(text)) return true;
  return false;
}

function hasSpecificPlayerFact(value) {
  return /(\bno\.\s*\d+|\b\d+\s*(spots|sales|30d|90d|\/10|%|ops|avg|era|whip)\b|aaa|aa|a\+|rookie|rank|liquid|liquidity|price|market|call-up|debut|promotion|40-man)/i.test(String(value || ""));
}

function sanitizeInsightPlayerName(insight, packet) {
  const playerName = String(packet?.player?.player_name || "").trim();
  const normalizedPlayer = normalizeName(playerName);
  const words = playerName.split(/\s+/).filter(Boolean);
  if (!playerName || !normalizedPlayer || words.length < 2) return insight;
  const fields = [
    "thesis",
    "resume",
    "why_now",
    "signals",
    "edge",
    "risk",
    "market_read",
    "card_market_take",
    "next_trigger",
    "do_not_buy_if",
    "what_would_change_my_mind",
  ];
  const next = { ...insight };
  for (const field of fields) {
    next[field] = correctPlayerNameInText(next[field], playerName, normalizedPlayer, words.length);
  }
  return next;
}

function correctPlayerNameInText(value, playerName, normalizedPlayer, wordCount) {
  const text = String(value || "");
  if (!text) return value;
  const pattern = new RegExp(`^(\\p{L}+(?:-\\p{L}+)*(?:\\s+\\p{L}+(?:-\\p{L}+)*){${wordCount - 1}})('s)?`, "u");
  const match = text.match(pattern);
  if (!match) return text;
  const normalizedCandidate = normalizeName(match[1]);
  if (normalizedCandidate !== normalizedPlayer && consonantSignature(normalizedCandidate) !== consonantSignature(normalizedPlayer)) return text;
  return `${playerName}${match[2] || ""}${text.slice(match[0].length)}`;
}

function consonantSignature(value) {
  return normalizeName(value).replace(/[aeiou]/g, "");
}

/*
  Legacy validator kept in the diff context for old snapshots; new snapshots are
  normalized through mapInsightFields above.
*/
function validateLegacyInsightResponse(parsed) {
  for (const field of ["final_action", "confidence", "resume", "signals", "edge", "risk", "card_market_take", "next_trigger", "what_would_change_my_mind"]) {
    if (typeof parsed[field] !== "string" || !parsed[field].trim()) {
      throw new Error(`Workers AI response missing ${field}.`);
    }
    parsed[field] = parsed[field].trim();
  }
  if (!ALLOWED_ACTIONS.includes(parsed.final_action)) {
    throw new Error(`Invalid final_action: ${parsed.final_action}`);
  }
  if (!ALLOWED_CONFIDENCE.includes(parsed.confidence)) {
    throw new Error(`Invalid confidence: ${parsed.confidence}`);
  }
  return parsed;
}

async function saveInsightSnapshot(db, { packet, insight, inputDataHash, modelName, onDeckEligible, refreshReason, rawModelResponse }) {
  await db.prepare(`
    UPDATE player_insight_snapshots
    SET is_current = 0
    WHERE player_id = ? AND board_type = ? AND is_current = 1
  `).bind(packet.player.player_id, BOARD_TYPE).run();

  await db.prepare(`
    INSERT INTO player_insight_snapshots (
      player_id, player_name, board_type, input_data_hash, model_provider, model_name,
      prompt_version, opportunity_score, callup_score, final_action, confidence, status,
      on_deck_eligible, resume, signals, edge, risk, card_market_take, next_trigger,
      what_would_change_my_mind, expires_at, is_current, refresh_reason,
      raw_packet_json, raw_model_response_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
  `).bind(
    packet.player.player_id,
    packet.player.player_name,
    BOARD_TYPE,
    inputDataHash,
    MODEL_PROVIDER,
    modelName,
    PROMPT_VERSION,
    packet.opportunity.opportunity_score,
    packet.opportunity.callup_score,
    insight.final_action,
    insight.confidence,
    onDeckEligible ? "current" : "watch",
    onDeckEligible ? 1 : 0,
    insight.resume,
    insight.signals,
    insight.edge,
    insight.risk,
    insight.card_market_take,
    insight.next_trigger,
    insight.what_would_change_my_mind,
    nextMondayIso(),
    refreshReason,
    JSON.stringify(packet),
    JSON.stringify(rawModelResponse),
  ).run();
}

export async function readCurrentOnDeckInsights(db, options = {}) {
  const limit = Math.max(1, Math.min(50, Number(options.limit) || 10));
  if (!db) return { items: [], count: 0, status: "empty", source: "d1-insights", message: "MARKET_DB is not configured." };
  try {
    const rows = await db.prepare(`
      WITH latest_stats AS (
        SELECT s.*
        FROM player_stats_snapshots s
        JOIN (
          SELECT player_id, MAX(snapshot_date) AS snapshot_date
          FROM player_stats_snapshots
          GROUP BY player_id
        ) latest ON latest.player_id = s.player_id AND latest.snapshot_date = s.snapshot_date
      ),
      latest_pre AS (
        SELECT pre.*
        FROM emerging_prescore_snapshots pre
        JOIN (
          SELECT player_id, card_target_id, MAX(snapshot_date) AS snapshot_date
          FROM emerging_prescore_snapshots
          GROUP BY player_id, card_target_id
        ) latest ON latest.player_id = pre.player_id
          AND (latest.card_target_id = pre.card_target_id OR (latest.card_target_id IS NULL AND pre.card_target_id IS NULL))
          AND latest.snapshot_date = pre.snapshot_date
      ),
      latest_market AS (
        SELECT m.*
        FROM card_market_snapshots m
        JOIN (
          SELECT player_id, card_target_id, MAX(snapshot_date) AS snapshot_date
          FROM card_market_snapshots
          GROUP BY player_id, card_target_id
        ) latest ON latest.player_id = m.player_id
          AND (latest.card_target_id = m.card_target_id OR (latest.card_target_id IS NULL AND m.card_target_id IS NULL))
          AND latest.snapshot_date = m.snapshot_date
      ),
      latest_recommendation AS (
        SELECT rec.*
        FROM recommendation_snapshots rec
        JOIN (
          SELECT player_id, card_target_id, board_type, MAX(snapshot_date) AS snapshot_date
          FROM recommendation_snapshots
          WHERE board_type = 'emerging'
          GROUP BY player_id, card_target_id, board_type
        ) latest ON latest.player_id = rec.player_id
          AND latest.board_type = rec.board_type
          AND (latest.card_target_id = rec.card_target_id OR (latest.card_target_id IS NULL AND rec.card_target_id IS NULL))
          AND latest.snapshot_date = rec.snapshot_date
        WHERE rec.board_type = 'emerging'
      ),
      candidate_rows AS (
        SELECT
          'insight' AS row_kind,
          id,
          player_id,
          player_name,
          board_type,
          opportunity_score AS move_score,
          callup_score,
          final_action,
          confidence,
          status,
          on_deck_eligible,
          resume,
          signals,
          edge,
          risk,
          card_market_take,
          next_trigger,
          what_would_change_my_mind,
          raw_packet_json,
          created_at,
          CASE
            WHEN board_type = 'top100' THEN 'Top 100'
            WHEN board_type = 'emerging' THEN 'Emerging'
            ELSE 'Watchlist'
          END AS source_badge,
          NULL AS organization,
          NULL AS position,
          NULL AS level,
          NULL AS age,
          NULL AS birth_date,
          NULL AS dob,
          NULL AS player_age,
          NULL AS top100_rank,
          NULL AS card_code,
          NULL AS market_sales_count_30d,
          NULL AS market_sales_count_90d,
          NULL AS market_avg_price_30d,
          NULL AS market_avg_price_90d,
          NULL AS market_last_sold_price,
          NULL AS market_liquidity,
          CASE WHEN raw_packet_json LIKE '%"trend":"Down"%' THEN 'Down' ELSE NULL END AS market_trend,
          CASE WHEN raw_packet_json LIKE '%"trend":"Down"%' THEN 'Down' ELSE NULL END AS market_signal
        FROM player_insight_snapshots
        WHERE is_current = 1
          AND board_type IN ('top100', 'emerging')
          AND player_id IS NOT NULL
          AND player_id != ''
          AND opportunity_score >= ?
          AND final_action NOT IN ('Avoid Chase', 'No Liquidity')

        UNION ALL

        SELECT
          'tracking' AS row_kind,
          p.id AS id,
          CAST(p.id AS TEXT) AS player_id,
          p.player_name,
          CASE
            WHEN pts.priority_tier IN ('card_api_candidate', 'emerging_a', 'emerging_bplus') THEN 'emerging'
            ELSE 'watchlist'
          END AS board_type,
          COALESCE(rec.total_score, pre.emerging_pre_score, pre.performance_score, 0) AS move_score,
          COALESCE(pre.level_score, pre.age_level_score, 0) AS callup_score,
          COALESCE(rec.recommendation, 'Research') AS final_action,
          CASE WHEN rec.grade IN ('A', 'A-', 'B+') THEN 'Medium-High' ELSE 'Medium' END AS confidence,
          pts.status,
          CASE WHEN COALESCE(rec.total_score, pre.emerging_pre_score, pre.performance_score, 0) >= ? THEN 1 ELSE 0 END AS on_deck_eligible,
          COALESCE(rec.thesis, pre.pre_score_notes, 'Tracked player with stats and card-market data.') AS resume,
          COALESCE(rec.catalyst, 'Current stats and benchmark card market data are available.') AS signals,
          COALESCE(rec.thesis, 'The edge is the combined baseball and market profile.') AS edge,
          COALESCE(rec.risk_notes, 'Needs continued stats and market confirmation.') AS risk,
          COALESCE(m.market_signal, 'Market data available') AS card_market_take,
          'Next assignment or ranking update' AS next_trigger,
          COALESCE(rec.risk_notes, 'Do not chase if price separates from recent comps.') AS what_would_change_my_mind,
          NULL AS raw_packet_json,
          COALESCE(rec.created_at, m.snapshot_date, pre.snapshot_date, s.snapshot_date, pts.last_reviewed_at) AS created_at,
          CASE
            WHEN pts.priority_tier IN ('card_api_candidate', 'emerging_a', 'emerging_bplus') THEN 'Emerging'
            ELSE 'Watchlist'
          END AS source_badge,
          COALESCE(p.current_org, p.current_team, ct.team_on_card) AS organization,
          p.position,
          s.level,
          s.age,
          p.birth_date,
          p.birth_date AS dob,
          s.age AS player_age,
          NULL AS top100_rank,
          COALESCE(ct.auto_code, ct.card_number) AS card_code,
          m.sales_count_30d AS market_sales_count_30d,
          m.sales_count_90d AS market_sales_count_90d,
          m.avg_price_30d AS market_avg_price_30d,
          m.avg_price_90d AS market_avg_price_90d,
          m.last_sold_price AS market_last_sold_price,
          NULL AS market_liquidity,
          NULL AS market_trend,
          m.market_signal
        FROM player_tracking_status pts
        JOIN players p ON p.id = pts.player_id
        LEFT JOIN emerging_card_targets ct ON ct.player_id = p.id AND ct.active = 1
        LEFT JOIN latest_stats s ON s.player_id = p.id
        LEFT JOIN latest_pre pre ON pre.player_id = p.id AND (pre.card_target_id = ct.id OR pre.card_target_id IS NULL)
        LEFT JOIN latest_market m ON m.player_id = p.id AND (m.card_target_id = ct.id OR m.card_target_id IS NULL)
        LEFT JOIN latest_recommendation rec ON rec.player_id = p.id AND (rec.card_target_id = ct.id OR rec.card_target_id IS NULL)
        WHERE pts.status = 'active'
          AND (
            pts.priority_tier IN ('card_api_candidate', 'emerging_a', 'emerging_bplus')
            OR (
              s.player_id IS NOT NULL
              AND (
                COALESCE(m.sales_count_30d, 0) > 0
                OR COALESCE(m.sales_count_90d, 0) > 0
                OR COALESCE(m.avg_price_30d, 0) > 0
                OR COALESCE(m.avg_price_90d, 0) > 0
              )
            )
          )
          AND (
            COALESCE(m.sales_count_30d, 0) > 0
            OR COALESCE(m.sales_count_90d, 0) > 0
            OR COALESCE(m.avg_price_30d, 0) > 0
            OR COALESCE(m.avg_price_90d, 0) > 0
          )
          AND COALESCE(rec.recommendation, '') NOT IN ('Avoid Chase', 'No Liquidity')
          AND LOWER(COALESCE(m.market_signal, '')) NOT LIKE '%down%'
          AND LOWER(COALESCE(m.market_signal, '')) NOT LIKE '%cooling%'
          AND LOWER(COALESCE(m.market_signal, '')) NOT LIKE '%avoid%'
          AND NOT (
            m.avg_price_30d IS NOT NULL
            AND m.avg_price_90d IS NOT NULL
            AND m.avg_price_90d > 0
            AND m.avg_price_30d <= m.avg_price_90d * 0.88
          )
      ),
      ranked AS (
        SELECT candidate_rows.*,
          ROW_NUMBER() OVER (
            PARTITION BY player_id
            ORDER BY move_score DESC, CASE WHEN row_kind = 'insight' THEN 1 ELSE 0 END DESC, created_at DESC
          ) AS player_row
        FROM candidate_rows
      )
      SELECT *
      FROM ranked
      WHERE player_row = 1
        AND move_score >= ?
        AND LOWER(COALESCE(market_signal, '')) NOT LIKE '%down%'
        AND LOWER(COALESCE(market_signal, '')) NOT LIKE '%cooling%'
        AND LOWER(COALESCE(market_signal, '')) NOT LIKE '%avoid%'
        AND NOT (
          market_avg_price_30d IS NOT NULL
          AND market_avg_price_90d IS NOT NULL
          AND market_avg_price_90d > 0
          AND market_avg_price_30d <= market_avg_price_90d * 0.88
        )
      ORDER BY move_score DESC, callup_score DESC, created_at DESC
      LIMIT ?
    `).bind(ON_DECK_MIN_SCORE, ON_DECK_MIN_SCORE, ON_DECK_MIN_SCORE, limit).all();
    const items = (rows.results || []).map(onDeckCandidateRowToApi);
    return {
      items,
      players: items,
      count: items.length,
      generated_at: new Date().toISOString(),
      status: items.length ? "ok" : "empty",
      source: "d1-insights",
      universe: "investable",
    };
  } catch (error) {
    return { items: [], players: [], count: 0, status: "empty", source: "d1-insights", message: safeErrorMessage(error) };
  }
}

async function loadTop100SourceData(context) {
  const [top100, stats, savantStats, depthCharts, news, enrichment, rankHistory, cardTargets] = await Promise.all([
    readCsvAsset(context, "/data/mlb-top100-2026.csv"),
    readCsvAsset(context, "/data/current-stats.csv").catch(() => []),
    readCsvAsset(context, "/data/savant-stats.csv").catch(() => []),
    readCsvAsset(context, "/data/depth-chart-current.csv").catch(() => []),
    readCsvAsset(context, "/data/player-news.csv").catch(() => []),
    readCsvAsset(context, "/data/player-enrichment.csv").catch(() => []),
    readCsvAsset(context, "/data/rank-history.csv").catch(() => []),
    readCsvAsset(context, "/data/card-targets.csv").catch(() => []),
  ]);
  const enriched = applyProspectEnrichment(top100, mergeRowsByPlayerId(enrichment, rankHistory));
  const scored = applyCardTargets(
    mergeProspectData(enriched, mergeRowsByPlayerId(stats, savantStats), mergeRowsByPlayerId(depthCharts, news)),
    cardTargets,
  ).filter((player) => String(player.level || "").toUpperCase() !== "MLB");
  const enabledTargets = cardTargets.filter((row) => String(row.enabled ?? "true").toLowerCase() !== "false");
  return {
    scored,
    cardTargets,
    cardTargetsById: new Map(enabledTargets.map((row) => [String(row.player_id), row])),
    cardTargetsByName: new Map(enabledTargets.map((row) => [normalizeName(row.player_name), row])),
  };
}

function applyProspectEnrichment(prospects, enrichment) {
  const byId = new Map(enrichment.map((row) => [String(row.player_id), row]));
  return prospects.map((prospect) => {
    const overlay = byId.get(String(prospect.player_id));
    return overlay ? { ...prospect, ...overlay, level: overlay.current_level || prospect.level } : prospect;
  });
}

function applyCardTargets(players, cardTargets) {
  const enabledTargets = cardTargets.filter((row) => String(row.enabled ?? "true").toLowerCase() !== "false");
  const byId = new Map(enabledTargets.map((row) => [String(row.player_id), row]));
  const byName = new Map(enabledTargets.map((row) => [normalizeName(row.player_name), row]));
  return players.map((player) => {
    const target = byId.get(String(player.player_id)) || byName.get(normalizeName(player.player_name));
    return target ? { ...player, ...target, player_id: player.player_id, player_name: player.player_name } : player;
  });
}

function computeOnDeckEligibility(packet, insight) {
  return Number(packet.opportunity.opportunity_score) >= ON_DECK_MIN_SCORE
    && Boolean(packet.player.player_id)
    && insight.final_action !== "Avoid Chase"
    && insight.final_action !== "No Liquidity"
    && ON_DECK_ALLOWED_ACTIONS.includes(insight.final_action);
}

async function readCurrentInsight(db, playerIdOrName, boardType) {
  if (!db) return null;
  const value = String(playerIdOrName || "");
  return db.prepare(`
    SELECT *
    FROM player_insight_snapshots
    WHERE board_type = ?
      AND is_current = 1
      AND (player_id = ? OR LOWER(player_name) = LOWER(?))
    ORDER BY created_at DESC
    LIMIT 1
  `).bind(boardType, value, value).first().catch(() => null);
}

async function readMarketSnapshot(db, playerId) {
  if (!db) return null;
  return db.prepare(`SELECT * FROM market_player_snapshots WHERE player_id = ?`).bind(playerId).first().catch(() => null);
}

async function readRankTrend(db, player) {
  if (!db) return null;
  return db.prepare(`
    SELECT *
    FROM top100_rank_trends
    WHERE player_id = ? OR LOWER(player_name) = LOWER(?)
    ORDER BY updated_at DESC
    LIMIT 1
  `).bind(player.player_id || "", player.player_name || "").first().catch(() => null);
}

async function logInsightRun(db, summary) {
  await db.prepare(`
    INSERT INTO top100_insight_runs (
      job_name, started_at, completed_at, status, players_checked, market_queries_used,
      packets_built, ai_calls_attempted, ai_calls_skipped, insights_created,
      insights_reused, insights_failed, on_deck_top10_updated, errors_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    summary.jobName,
    summary.startedAt,
    summary.completedAt,
    summary.status,
    summary.playersChecked,
    summary.marketQueriesUsed,
    summary.packetsBuilt,
    summary.aiCallsAttempted,
    summary.aiCallsSkipped,
    summary.insightsCreated,
    summary.insightsReused,
    summary.insightsFailed,
    summary.onDeckTop10Updated,
    JSON.stringify(summary.errors),
  ).run().catch(() => null);
}

function insightRowToApi(row) {
  const packet = safeJson(row.raw_packet_json);
  const marketStatus = marketStatusLabel(packet?.market);
  const market = packet?.market || {};
  const sourceBoard = row.board_type || "top100";
  const organization = packet?.player?.organization || "";
  const position = packet?.player?.position || "";
  const level = packet?.player?.level || "";
  const age = packet?.player?.age ?? row.age ?? "";
  return {
    id: row.id,
    player_id: row.player_id,
    playerId: row.player_id,
    player_name: row.player_name,
    playerName: row.player_name,
    source_board: sourceBoard,
    sourceBoard,
    board_type: sourceBoard,
    trend: packet?.player?.rank_movement ?? "",
    context: [organization, position, level].filter(Boolean).join(" · "),
    team: organization,
    organization,
    org: organization,
    position,
    level,
    age,
    player_age: age,
    birth_date: row.birth_date || "",
    dob: row.dob || "",
    rank: packet?.player?.top100_rank || "",
    prospect_rank: packet?.player?.top100_rank || "",
    card_code: packet?.card?.card_code || "",
    benchmarkCardCode: packet?.card?.card_code || "",
    opportunity_score: row.opportunity_score,
    opportunityScore: row.opportunity_score,
    callup_score: row.callup_score,
    move_score: row.opportunity_score,
    moveScore: row.opportunity_score,
    final_action: row.final_action,
    action: row.final_action,
    buy_zone: row.final_action,
    confidence: row.confidence,
    market_read: marketStatus,
    market_status: marketStatus,
    marketStatus,
    market_sales_count_30d: market.sales_count_30d ?? "",
    market_sales_count_90d: market.sales_count_90d ?? "",
    market_avg_price_30d: market.avg_price_30d ?? "",
    market_avg_price_90d: market.avg_price_90d ?? "",
    market_last_sold_price: market.last_sold_price ?? "",
    market_liquidity: market.liquidity || "",
    market_trend: market.trend || "",
    on_deck_eligible: Boolean(row.on_deck_eligible) || isApiEligible(row),
    onDeckEligible: Boolean(row.on_deck_eligible) || isApiEligible(row),
    status: row.status,
    resume: row.resume,
    signals: row.signals,
    edge: row.edge,
    risk: row.risk,
    card_market_take: row.card_market_take,
    next_trigger: row.next_trigger,
    what_would_change_my_mind: row.what_would_change_my_mind,
    updated_at: row.created_at,
    created_at: row.created_at,
    profile_url: `./player.html?type=${encodeURIComponent(sourceBoard === "emerging" ? "emerging" : "on-deck")}&id=${encodeURIComponent(row.player_id)}`,
    source_type: "d1-insights",
  };
}

function onDeckCandidateRowToApi(row) {
  if (row.row_kind === "insight") {
    const apiRow = insightRowToApi(row);
    return {
      ...apiRow,
      source_badge: row.source_badge || sourceBadgeForBoard(apiRow.source_board),
      sourceBadge: row.source_badge || sourceBadgeForBoard(apiRow.source_board),
      move_score: row.move_score ?? apiRow.move_score,
      moveScore: row.move_score ?? apiRow.moveScore,
      opportunity_score: row.move_score ?? apiRow.opportunity_score,
      opportunityScore: row.move_score ?? apiRow.opportunityScore,
    };
  }

  const marketStatus = marketStatusFromCandidate(row);
  const sourceBoard = row.board_type || "watchlist";
  const sourceBadge = row.source_badge || sourceBadgeForBoard(sourceBoard);
  const organization = row.organization || "";
  const position = row.position || "";
  const level = row.level || "";
  const age = row.age ?? row.player_age ?? "";
  return {
    id: row.id,
    player_id: row.player_id,
    playerId: row.player_id,
    player_name: row.player_name,
    playerName: row.player_name,
    source_board: sourceBoard,
    sourceBoard,
    source_badge: sourceBadge,
    sourceBadge,
    board_type: sourceBoard,
    trend: "",
    context: [organization, position, level].filter(Boolean).join(" · "),
    team: organization,
    organization,
    org: organization,
    position,
    level,
    age,
    player_age: age,
    birth_date: row.birth_date || "",
    dob: row.dob || "",
    rank: row.top100_rank || "",
    prospect_rank: row.top100_rank || "",
    card_code: row.card_code || "",
    benchmarkCardCode: row.card_code || "",
    opportunity_score: row.move_score,
    opportunityScore: row.move_score,
    callup_score: row.callup_score,
    move_score: row.move_score,
    moveScore: row.move_score,
    final_action: row.final_action,
    action: row.final_action,
    buy_zone: row.final_action,
    confidence: row.confidence,
    market_read: marketStatus,
    market_status: marketStatus,
    marketStatus,
    market_sales_count_30d: row.market_sales_count_30d ?? "",
    market_sales_count_90d: row.market_sales_count_90d ?? "",
    market_avg_price_30d: row.market_avg_price_30d ?? "",
    market_avg_price_90d: row.market_avg_price_90d ?? "",
    market_last_sold_price: row.market_last_sold_price ?? "",
    market_liquidity: row.market_liquidity || "",
    market_trend: row.market_trend || "",
    on_deck_eligible: Number(row.on_deck_eligible) === 1 || row.on_deck_eligible === true,
    onDeckEligible: Number(row.on_deck_eligible) === 1 || row.on_deck_eligible === true,
    status: row.status,
    resume: row.resume,
    signals: row.signals,
    edge: row.edge,
    risk: row.risk,
    card_market_take: row.card_market_take,
    next_trigger: row.next_trigger,
    what_would_change_my_mind: row.what_would_change_my_mind,
    updated_at: row.created_at,
    created_at: row.created_at,
    profile_url: `./player.html?type=${encodeURIComponent(sourceBoard === "top100" ? "on-deck" : "emerging")}&id=${encodeURIComponent(row.player_id)}`,
    source_type: "d1-investable-universe",
  };
}

function sourceBadgeForBoard(boardType) {
  if (boardType === "top100") return "Top 100";
  if (boardType === "emerging") return "Emerging";
  return "Watchlist";
}

function marketStatusFromCandidate(row) {
  const signal = String(row.market_signal || "").toLowerCase();
  if (signal.includes("avoid")) return "Avoid Chase";
  if (signal.includes("no liquidity")) return "No Liquidity";
  if (signal.includes("need")) return "Needs Market";
  const sales30 = Number(row.market_sales_count_30d);
  const sales90 = Number(row.market_sales_count_90d);
  const avg30 = Number(row.market_avg_price_30d);
  const avg90 = Number(row.market_avg_price_90d);
  let volume = "Confirmed";
  if (signal.includes("thin") || (Number.isFinite(sales90) && sales90 > 0 && sales90 < 4)) volume = "Thin";
  else if (signal.includes("liquid") || sales30 >= 12 || sales90 >= 20) volume = "Liquid";

  let trend = "";
  if (signal.includes("up") || signal.includes("heating")) trend = "Up";
  else if (signal.includes("down") || signal.includes("cooling")) trend = "Down";
  else if (Number.isFinite(avg30) && Number.isFinite(avg90) && avg90 > 0) {
    const movement = ((avg30 - avg90) / avg90) * 100;
    if (movement >= 12) trend = "Up";
    else if (movement <= -12) trend = "Down";
    else trend = "Stable";
  }
  if (!trend) trend = Number.isFinite(sales30) && Number.isFinite(sales90) && sales30 >= Math.max(3, sales90 * 0.4) ? "Active" : "Watch";
  return `${volume} · ${trend}`;
}

function findPlayer(players, playerIdOrName) {
  const value = String(playerIdOrName || "");
  const normalized = normalizeName(value);
  return players.find((player) => String(player.player_id) === value)
    || players.find((player) => normalizeName(player.player_name) === normalized)
    || players.find((player) => normalizeName(player.player_name).includes(normalized));
}

async function readCsvAsset(context, pathname) {
  if (!context.env?.ASSETS) return [];
  const requestUrl = new URL(context.request?.url || "https://ondeckprospect.com/");
  requestUrl.pathname = pathname;
  requestUrl.search = "";
  const response = await context.env.ASSETS.fetch(new Request(requestUrl.toString()));
  if (!response.ok) throw new Error(`Unable to read ${pathname}: ${response.status}`);
  return parseCsv(await response.text());
}

function mergeRowsByPlayerId(primaryRows, overlayRows) {
  const byId = new Map(primaryRows.map((row) => [String(row.player_id), { ...row }]));
  for (const row of overlayRows) {
    const key = String(row.player_id || "");
    if (!key) continue;
    byId.set(key, { ...(byId.get(key) || {}), ...nonBlank(row) });
  }
  return [...byId.values()];
}

function nonBlank(row) {
  return Object.fromEntries(Object.entries(row).filter(([, value]) => value !== "" && value != null));
}

function riskList(player) {
  const risks = [];
  if (Number(player.opportunity_score) < ON_DECK_MIN_SCORE) risks.push("Opportunity score is below the On Deck threshold.");
  if (Number(player.performance_score) < 55) risks.push("Current performance score is below the preferred range.");
  if (Number(player.readiness_score) < 55) risks.push("Readiness score points to a longer timeline.");
  if (player.notes) risks.push(player.notes);
  return risks;
}

function nextTrigger(player) {
  const level = String(player.level || "").toUpperCase();
  if (level === "AAA") return "MLB debut decision";
  if (level === "AA") return "Triple-A promotion";
  if (level === "A+" || level === "A") return "Upper-level promotion";
  return "Next assignment or ranking update";
}

function liquidityLabel(market, cardTarget) {
  const sales90 = Number(market?.sales_count_90d);
  const sellThrough30 = Number(cardTarget?.sell_through_30 ?? market?.sell_thru_rate_30d);
  if (Number.isFinite(sales90) && sales90 <= 0) return "No Liquidity";
  if (Number.isFinite(sales90) && sales90 <= 3) return "Thin";
  if (Number.isFinite(sellThrough30) && sellThrough30 >= 50) return "Liquid";
  if (Number.isFinite(sales90) && sales90 >= 4) return "Confirmed";
  return "Pending";
}

function marketTrend(market) {
  const avg30 = Number(market?.avg_sold_price_30d);
  const avg90 = Number(market?.avg_sold_price_90d);
  if (!Number.isFinite(avg30) || !Number.isFinite(avg90) || avg90 <= 0) return "Pending";
  const movement = ((avg30 - avg90) / avg90) * 100;
  if (movement >= 12) return "Up";
  if (movement <= -12) return "Down";
  return "Stable";
}

function parseModelJson(text) {
  const clean = String(text || "")
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
  try {
    return JSON.parse(clean);
  } catch {
    const match = clean.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("Workers AI response was not JSON.");
    return JSON.parse(match[0]);
  }
}

function computeCardMarketOpportunityScore(packet) {
  const attention = playerAttentionSignal(packet);
  const performance = performanceMovementSignal(packet);
  const market = marketConfirmationSignal(packet);
  const discipline = priceDisciplineSignal(packet);
  return Math.round(clamp(attention * 0.5 + performance * 0.2 + market * 0.2 + discipline * 0.1));
}

function playerAttentionSignal(packet) {
  const rank = Number(packet?.player?.top100_rank);
  const movement = Number(packet?.player?.rank_movement);
  const age = Number(packet?.player?.age);
  const level = String(packet?.player?.level || "").toUpperCase();
  const emerging = Number(packet?.opportunity?.emerging_pre_score);
  const rankScore = Number.isFinite(rank) ? inverseScale(rank, 1, 100) : numberOrNull(emerging) ?? 45;
  const movementScore = Number.isFinite(movement) ? clamp(50 + movement * 3) : 50;
  const levelScore = levelAttentionScore(level);
  const ageScore = ageToLevelAttention(age, level);
  return clamp(rankScore * 0.5 + movementScore * 0.2 + levelScore * 0.15 + ageScore * 0.15);
}

function performanceMovementSignal(packet) {
  const stats = packet?.stats || {};
  const hitterTerms = [
    scale(Number(stats.ops), 0.68, 1.0),
    scale(Number(stats.last_14_ops), 0.7, 1.08),
    scale(Number(stats.last_30_ops), 0.7, 1.02),
  ].filter(Number.isFinite);
  const pitcherTerms = [
    inverseScale(Number(stats.era), 2.2, 5.2),
    inverseScale(Number(stats.whip), 0.9, 1.55),
    scale(Number(stats.k_per_9), 7, 13),
    inverseScale(Number(stats.last_14_era), 2.0, 5.0),
  ].filter(Number.isFinite);
  const terms = hitterTerms.length ? hitterTerms : pitcherTerms;
  if (!terms.length) return 50;
  return clamp(terms.reduce((sum, value) => sum + value, 0) / terms.length);
}

function marketConfirmationSignal(packet) {
  if (!packet?.card?.card_code) return 20;
  const market = packet?.market || {};
  const sales30 = Number(market.sales_count_30d);
  const sales90 = Number(market.sales_count_90d);
  const liquidity = String(market.liquidity || "");
  if ((!Number.isFinite(sales30) || sales30 <= 0) && (!Number.isFinite(sales90) || sales90 <= 0)) return 35;
  const volumeScore = clamp(scale(Number.isFinite(sales30) ? sales30 : sales90 / 3, 1, 30));
  const liquidityScore = liquidity === "Liquid" ? 95 : liquidity === "Confirmed" ? 75 : liquidity === "Thin" ? 45 : 55;
  return clamp(volumeScore * 0.65 + liquidityScore * 0.35);
}

function priceDisciplineSignal(packet) {
  const market = packet?.market || {};
  const avg30 = Number(market.avg_price_30d);
  const avg90 = Number(market.avg_price_90d);
  if (!Number.isFinite(avg30) || !Number.isFinite(avg90) || avg90 <= 0) return 55;
  const move = ((avg30 - avg90) / avg90) * 100;
  if (move > 40) return 20;
  if (move > 25) return 35;
  if (move >= -10 && move <= 18) return 85;
  if (move < -25) return 45;
  return 65;
}

function actionForScore(packet, score) {
  if (marketStatusLabel(packet?.market) === "No Liquidity") return "No Liquidity";
  if (!packet?.market?.market_exists) {
    return score >= ON_DECK_MIN_SCORE ? "Needs Market" : "Research";
  }
  if (priceDisciplineSignal(packet) <= 35) return "Avoid Chase";
  if (score >= 90) return "Strong Buy";
  if (score >= 80) return "Buy Zone";
  if (score >= 70) return "Watch";
  if (score >= 60) return "Research";
  return "Research";
}

function marketStatusLabel(market) {
  const sales30 = Number(market?.sales_count_30d);
  const sales90 = Number(market?.sales_count_90d);
  const avg30 = Number(market?.avg_price_30d);
  const avg90 = Number(market?.avg_price_90d);
  const liquidity = String(market?.liquidity || "");
  const existingTrend = String(market?.trend || "").trim();
  if (liquidity === "No Liquidity") return "No Liquidity";
  if ((!Number.isFinite(sales30) || sales30 <= 0) && (!Number.isFinite(sales90) || sales90 <= 0)) return "Needs Market";

  let volume = "Confirmed";
  if (liquidity === "Thin" || (Number.isFinite(sales90) && sales90 > 0 && sales90 < 4)) volume = "Thin";
  else if (Number.isFinite(sales30) && sales30 >= 12) volume = "Liquid";
  else if (Number.isFinite(sales90) && sales90 >= 20) volume = "Liquid";

  let trend = existingTrend;
  if (!trend && Number.isFinite(avg30) && Number.isFinite(avg90) && avg90 > 0) {
    const movement = ((avg30 - avg90) / avg90) * 100;
    if (movement >= 12) trend = "Up";
    else if (movement <= -12) trend = "Down";
    else trend = "Stable";
  }
  if (!trend) trend = Number.isFinite(sales30) && Number.isFinite(sales90) && sales30 >= Math.max(3, sales90 * 0.4) ? "Active" : "Watch";
  return `${volume} · ${trend}`;
}

function isApiEligible(row) {
  return Number(row?.opportunity_score) >= ON_DECK_MIN_SCORE
    && !["Avoid Chase", "No Liquidity"].includes(String(row?.final_action || ""));
}

function mergeInsightWithDynamicBase(insight, packet) {
  const base = buildDynamicInsight(packet);
  return sanitizeInsightPlayerName({
    ...base,
    ...insight,
    thesis: keepSpecific(insight.thesis, base.thesis, packet),
    resume: keepSpecific(insight.resume || insight.thesis, base.resume, packet),
    why_now: keepSpecific(insight.why_now, base.why_now, packet),
    signals: keepSpecific(insight.signals || insight.why_now, base.signals, packet),
    market_read: keepSpecific(insight.market_read, base.market_read, packet, /(sales|avg|liquid|liquidity|thin|price|market|volume)/i),
    card_market_take: keepSpecific(insight.card_market_take || insight.market_read, base.card_market_take, packet, /(sales|avg|liquid|liquidity|thin|price|market|volume)/i),
    edge: keepSpecific(insight.edge, base.edge, packet),
    risk: keepSpecific(insight.risk, base.risk, packet),
    next_trigger: keepSpecific(insight.next_trigger, base.next_trigger, packet, /promotion|debut|assignment|ranking|update|decision/i),
    do_not_buy_if: keepSpecific(insight.do_not_buy_if, base.do_not_buy_if, packet),
    what_would_change_my_mind: keepSpecific(insight.what_would_change_my_mind || insight.do_not_buy_if, base.what_would_change_my_mind, packet),
    sources_json: Array.isArray(insight.sources_json) ? insight.sources_json : [],
  }, packet);
}

function keepSpecific(value, fallback, packet, requiredPattern = null) {
  const text = String(value || "").trim();
  const playerToken = String(packet?.player?.player_name || "").split(/\s+/)[0]?.toLowerCase();
  if (!text || text.length < 35) return fallback;
  const lower = text.toLowerCase();
  if (playerToken && !lower.includes(playerToken) && !hasSpecificPlayerFact(text)) return fallback;
  if (/source-backed research is missing|monitor progress|if performance declines|could be a good opportunity|player attention may move|baseball path and collector attention/i.test(text)) return fallback;
  if (requiredPattern && !requiredPattern.test(text)) return fallback;
  return text;
}

function levelAttentionScore(level) {
  if (level === "AAA") return 85;
  if (level === "AA") return 72;
  if (level === "A+") return 62;
  if (level === "A") return 55;
  if (level === "ROK" || level === "RK") return 45;
  return 55;
}

function ageToLevelAttention(age, level) {
  if (!Number.isFinite(age)) return 50;
  const baseline = level === "AAA" ? 24 : level === "AA" ? 23 : level === "A+" ? 22 : level === "A" ? 21 : 20;
  return clamp(65 + (baseline - age) * 8);
}

function scale(value, low, high) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return NaN;
  if (high === low) return 50;
  return clamp(((numeric - low) / (high - low)) * 100);
}

function inverseScale(value, low, high) {
  const scaled = scale(value, low, high);
  return Number.isFinite(scaled) ? clamp(100 - scaled) : NaN;
}

function clamp(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(100, numeric));
}

function buildDynamicInsight(packet) {
  const score = Number(packet?.opportunity?.opportunity_score);
  const callup = Number(packet?.opportunity?.callup_score);
  const rank = Number(packet?.player?.top100_rank);
  const movement = Number(packet?.player?.rank_movement);
  const sales30 = Number(packet?.market?.sales_count_30d);
  const sales90 = Number(packet?.market?.sales_count_90d);
  const avg30 = Number(packet?.market?.avg_price_30d);
  const avg90 = Number(packet?.market?.avg_price_90d);
  const liquidity = packet?.market?.liquidity || "Pending";
  const trend = packet?.market?.trend || "Pending";
  const hasCard = Boolean(packet?.card?.card_code);
  const hasMarket = Number.isFinite(sales30) && sales30 > 0 || Number.isFinite(sales90) && sales90 > 0;
  const finalAction = hasCard && hasMarket ? actionForScore(packet, score) : Number.isFinite(score) && score >= ON_DECK_MIN_SCORE ? "Needs Market" : "Research";

  const read = profileRead(packet);
  const priceText = pricePhrase({ avg30, avg90, sales30, sales90, liquidity, trend });
  const trigger = packet?.opportunity?.next_likely_trigger || nextTrigger({ level: packet?.player?.level });
  const salesText = hasMarket ? `${Number.isFinite(sales30) ? sales30 : sales90} recent benchmark sales` : "no confirmed benchmark sales";
  const confidence = hasMarket && Number.isFinite(score) && score >= 70 ? "Medium-High" : hasMarket ? "Medium" : "Low";
  const memo = {
    call: finalAction,
    confidence,
    thesis: read.thesis,
    why_now: read.whyNow,
    market_read: hasCard ? `Benchmark ${packet.card.card_code}: ${salesText}; ${priceText}` : "Needs Better Data: no confirmed benchmark Bowman card target.",
    edge: read.edge,
    risk: read.risk || riskPhrase(packet, finalAction),
    next_trigger: trigger,
    do_not_buy_if: read.doNotBuy || doNotBuyPhrase(packet, finalAction),
    sources_json: [],
  };
  return {
    ...memo,
    final_action: memo.call,
    resume: memo.thesis,
    signals: memo.why_now,
    card_market_take: memo.market_read,
    what_would_change_my_mind: memo.do_not_buy_if,
  };
}

function profileRead(packet) {
  const name = packet?.player?.player_name || "This player";
  const level = String(packet?.player?.level || "").toUpperCase();
  const org = packet?.player?.organization || "org pending";
  const position = packet?.player?.position || "position pending";
  const rank = Number(packet?.player?.top100_rank);
  const movement = Number(packet?.player?.rank_movement);
  const score = Number(packet?.opportunity?.opportunity_score);
  const callup = Number(packet?.opportunity?.callup_score);
  const need = Number(packet?.opportunity?.mlb_team_need);
  const blockers = Number(packet?.opportunity?.mlb_blockers);
  const on40 = packet?.opportunity?.on_40man === true;
  const injury = packet?.opportunity?.injury_opening === true;
  const trigger = packet?.opportunity?.next_likely_trigger || nextTrigger({ level });
  const market = packet?.market || {};
  const trend = String(market.trend || "Pending");
  const liquidity = String(market.liquidity || "Pending");
  const priceMove = percentMove(market.avg_price_30d, market.avg_price_90d);
  const form = formRead(packet);
  const rankRead = rankMomentumRead(movement);
  const pathRead = pathPressureRead({ level, need, blockers, on40, injury });
  const marketRead = marketInterpretation({ liquidity, trend, priceMove, sales30: Number(market.sales_count_30d), sales90: Number(market.sales_count_90d) });
  const rankText = Number.isFinite(rank) ? `No. ${rank}` : "rank pending";
  const scoreText = Number.isFinite(score) ? `${Math.round(score)} score` : "score pending";
  const callupText = Number.isFinite(callup) ? `${Math.round(callup)} call-up` : "call-up pending";

  if (trend === "Up" && priceMove > 18) {
    return {
      thesis: `${name} is a ${rankText} ${org} ${position} with ${scoreText}, but the card market is already moving faster than the promotion case.`,
      whyNow: `${rankRead}; ${form.summary}. The catalyst is ${trigger}, yet ${marketRead}.`,
      edge: `${name} is useful as a confirmation watch, not a blind chase; the better entry comes if price cools while the baseball signal holds.`,
      risk: `${name}'s 30D card average is ${priceMove.toFixed(0)}% above the 90D mark, so the risk is buying after the easy move.`,
      doNotBuy: `Do not buy ${name} if the 30D average keeps rising without another wave of sales or a fresh ${trigger.toLowerCase()}.`,
    };
  }

  if (Number.isFinite(movement) && movement > 8 && form.direction === "cooling") {
    return {
      thesis: `${name} has real ranking momentum at ${rankText}, but the recent stat trend is not fully backing the move yet.`,
      whyNow: `${rankRead}; ${form.summary}. ${pathRead}, with ${trigger} as the next check point.`,
      edge: `${name} becomes interesting if recent form turns back up before collectors fully price the ranking jump.`,
      risk: `${name}'s rank is rising while short-window form is cooling, which can create a false-start card move.`,
      doNotBuy: `Do not buy ${name} until the recent stat line stabilizes or the market gives a cleaner discount.`,
    };
  }

  if ((level === "AAA" || level === "AA") && form.direction === "heating" && ["Liquid", "Confirmed"].includes(liquidity)) {
    return {
      thesis: `${name} is one of the cleaner OnDeck setups: upper-level proximity, improving form, and a market with enough volume to trade.`,
      whyNow: `${form.summary}. ${pathRead}; ${rankRead}; the next catalyst is ${trigger}.`,
      edge: `${name}'s card case is strongest before the ${trigger.toLowerCase()} becomes a headline, because liquidity is already present.`,
      risk: `${name} can still stall if the promotion window slips or if the 30D average jumps before the baseball news arrives.`,
      doNotBuy: `Do not buy ${name} above the recent 30D average unless sales volume expands with the move.`,
    };
  }

  if (level === "AAA" && Number.isFinite(callup) && callup >= 65) {
    return {
      thesis: `${name} is more about proximity than hype: ${org} already has him at AAA with a ${callupText} read.`,
      whyNow: `${pathRead}. ${form.summary}; ${marketRead}; next trigger is ${trigger}.`,
      edge: `${name} makes sense as a near-term board candidate if the market stays orderly into the debut window.`,
      risk: `${name}'s card edge fades if the MLB path slows or if buyers push the benchmark above recent comps first.`,
      doNotBuy: `Do not buy ${name} if the roster path gets crowded or recent comps separate from the 90D baseline.`,
    };
  }

  if (liquidity === "Thin" || liquidity === "No Liquidity") {
    return {
      thesis: `${name} has baseball interest, but the benchmark card market is too thin to treat as a clean OnDeck entry.`,
      whyNow: `${rankRead}; ${form.summary}. The blocker is market quality: ${marketRead}.`,
      edge: `${name} belongs on watch until sold volume proves collectors can actually enter and exit the card.`,
      risk: `${name}'s biggest issue is liquidity, not the player case; one sale can distort the read.`,
      doNotBuy: `Do not buy ${name} until several clean benchmark sales show up inside the 30D window.`,
    };
  }

  return {
    thesis: `${name} is a ${rankText} ${org} ${position} with ${scoreText}; the profile is watchable, but the catalyst is not screaming yet.`,
    whyNow: `${rankRead}; ${form.summary}. ${pathRead}; market read is ${marketRead}.`,
    edge: `${name} is worth tracking because one clear ${trigger.toLowerCase()} could make the current market read matter quickly.`,
    risk: `${name} needs either stronger short-window performance or a clearer promotion lane before this becomes urgent.`,
    doNotBuy: `Do not buy ${name} unless the ${trigger.toLowerCase()} firms up or the market offers a discount to the 30D average.`,
  };
}

function formRead(packet) {
  const stats = packet?.stats || {};
  const position = String(packet?.player?.position || "");
  if (isPitcherPosition(position) || stats.era != null || stats.whip != null) {
    const era = Number(stats.era);
    const recent = firstNumber(stats.last_14_era, stats.last_30_era, stats.last_60_era);
    const whip = Number(stats.whip);
    const summary = [
      Number.isFinite(era) ? `${era.toFixed(2)} ERA` : "",
      Number.isFinite(whip) ? `${whip.toFixed(2)} WHIP` : "",
      Number.isFinite(recent) ? `${recent.toFixed(2)} recent ERA` : "",
    ].filter(Boolean).join(", ") || "pitching form needs a cleaner stat refresh";
    const direction = Number.isFinite(era) && Number.isFinite(recent)
      ? recent <= era - 0.35 ? "heating" : recent >= era + 0.35 ? "cooling" : "steady"
      : "unknown";
    return { summary, direction };
  }
  const ops = Number(stats.ops);
  const avg = Number(stats.avg);
  const recent = firstNumber(stats.last_14_ops, stats.last_30_ops, stats.last_60_ops);
  const summary = [
    Number.isFinite(ops) ? `${ops.toFixed(3).replace(/^0/, "")} OPS` : "",
    Number.isFinite(avg) ? `${avg.toFixed(3).replace(/^0/, "")} AVG` : "",
    Number.isFinite(recent) ? `${recent.toFixed(3).replace(/^0/, "")} recent OPS` : "",
  ].filter(Boolean).join(", ") || "offensive form needs a cleaner stat refresh";
  const direction = Number.isFinite(ops) && Number.isFinite(recent)
    ? recent >= ops + 0.06 ? "heating" : recent <= ops - 0.06 ? "cooling" : "steady"
    : "unknown";
  return { summary, direction };
}

function rankMomentumRead(movement) {
  const value = Number(movement);
  if (!Number.isFinite(value)) return "rank movement is not recorded yet";
  if (value >= 10) return `rank momentum is loud, up ${value} spots`;
  if (value > 0) return `rank trend is positive, up ${value} spots`;
  if (value <= -10) return `rank trend is a warning, down ${Math.abs(value)} spots`;
  if (value < 0) return `rank trend is slightly negative, down ${Math.abs(value)} spots`;
  return "rank is holding flat";
}

function pathPressureRead({ level, need, blockers, on40, injury }) {
  const parts = [];
  if (level === "AAA") parts.push("AAA proximity keeps the MLB clock relevant");
  else if (level === "AA") parts.push("AA status makes the next promotion the real catalyst");
  else parts.push("lower-level status keeps this more developmental");
  if (Number.isFinite(need) && need >= 7) parts.push(`team-need score is ${need}/10`);
  if (Number.isFinite(blockers) && blockers >= 8) parts.push(`${blockers} listed blockers make the lane crowded`);
  else if (Number.isFinite(blockers) && blockers <= 3) parts.push(`${blockers} listed blockers keeps the lane manageable`);
  if (on40) parts.push("40-man status removes one roster friction point");
  if (injury) parts.push("an injury opening adds churn");
  return parts.join("; ");
}

function marketInterpretation({ liquidity, trend, priceMove, sales30, sales90 }) {
  const volume = Number.isFinite(sales30) ? `${sales30} sales in 30D` : Number.isFinite(sales90) ? `${sales90} sales in 90D` : "sales count pending";
  if (liquidity === "No Liquidity") return "no clean exit path yet";
  if (trend === "Up" && priceMove > 18) return `${volume}, but price is already ${priceMove.toFixed(0)}% above the 90D average`;
  if (trend === "Down") return `${volume} with a discounting price trend`;
  if (liquidity === "Liquid") return `${volume} and liquid enough to matter`;
  if (liquidity === "Thin") return `${volume}, but thin enough for one comp to distort it`;
  return `${volume} with a ${trend.toLowerCase()} trend`;
}

function percentMove(current, baseline) {
  const a = Number(current);
  const b = Number(baseline);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= 0) return 0;
  return ((a - b) / b) * 100;
}

function firstNumber(...values) {
  for (const value of values) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return NaN;
}

function buildFallbackInsight(packet) {
  return buildDynamicInsight(packet);
}

function playerStatPhrase(packet) {
  const stats = packet?.stats || {};
  const position = String(packet?.player?.position || "");
  if (isPitcherPosition(position) || stats.era != null || stats.whip != null) {
    const era = numberPhrase(stats.era, "ERA");
    const whip = numberPhrase(stats.whip, "WHIP");
    const recent = numberPhrase(stats.last_14_era ?? stats.last_30_era, "recent ERA");
    return [era, whip, recent].filter(Boolean).join(", ") || "pitching form needs the next stat refresh";
  }
  const ops = numberPhrase(stats.ops, "OPS");
  const avg = numberPhrase(stats.avg, "AVG");
  const recentOps = numberPhrase(stats.last_14_ops ?? stats.last_30_ops, "recent OPS");
  return [ops, avg, recentOps].filter(Boolean).join(", ") || "offensive form needs the next stat refresh";
}

function pricePhrase({ avg30, avg90, sales30, sales90, liquidity, trend }) {
  const parts = [];
  if (Number.isFinite(avg30)) parts.push(`30D avg $${avg30.toFixed(2)}`);
  if (Number.isFinite(avg90)) parts.push(`90D avg $${avg90.toFixed(2)}`);
  if (Number.isFinite(sales30)) parts.push(`${sales30} 30D sales`);
  else if (Number.isFinite(sales90)) parts.push(`${sales90} 90D sales`);
  parts.push(`liquidity ${liquidity}`);
  parts.push(`price trend ${trend}`);
  return parts.join("; ") + ".";
}

function riskPhrase(packet, finalAction) {
  const trend = String(packet?.market?.trend || "");
  const movement = Number(packet?.player?.rank_movement);
  if (finalAction === "Avoid Chase") return `${packet.player.player_name} looks chased on price, so the risk is paying after the market already moved.`;
  if (finalAction === "No Liquidity") return `${packet.player.player_name} has weak benchmark liquidity, so exiting the card could be harder than buying it.`;
  if (trend === "Down") return `${packet.player.player_name}'s card price trend is down, so the baseball case needs a visible catalyst to reverse demand.`;
  if (Number.isFinite(movement) && movement < 0) return `${packet.player.player_name}'s Top 100 trend is down, which can cap collector urgency until performance answers it.`;
  return `${packet.player.player_name} needs a cleaner catalyst before the card case turns urgent; otherwise the market can drift without new baseball news.`;
}

function doNotBuyPhrase(packet, finalAction) {
  if (finalAction === "Avoid Chase") return `Do not buy ${packet.player.player_name} above the recent average unless a new catalyst resets demand.`;
  if (finalAction === "No Liquidity") return `Do not buy ${packet.player.player_name} unless new sold comps prove the benchmark card can move.`;
  const trigger = packet?.opportunity?.next_likely_trigger || "next assignment";
  return `Do not buy ${packet.player.player_name} if the ${trigger.toLowerCase()} stalls or the 30D average jumps without matching sales volume.`;
}

function marketEdgeWord(liquidity, trend) {
  if (String(trend) === "Up") return "moving but not fully chased";
  if (String(trend) === "Down") return "discounted enough to watch";
  if (String(liquidity) === "Liquid") return "liquid and tradable";
  if (String(liquidity) === "Thin") return "thin but trackable";
  return "not fully confirmed";
}

function numberPhrase(value, label) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "";
  const formatted = label.includes("AVG") || label.includes("OPS")
    ? numeric.toFixed(3).replace(/^0/, "")
    : numeric.toFixed(2);
  return `${formatted} ${label}`;
}

function isPitcherPosition(position) {
  return /\b(P|RHP|LHP|SP|RP)\b/i.test(String(position || ""));
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, item === undefined ? null : item]));
}

function numberOrNull(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function decimalOrNull(value) {
  return numberOrNull(value);
}

function pitcherStatOrNull(player, field) {
  if (!isPitcherPosition(player?.position)) return null;
  return decimalOrNull(player?.[field]);
}

function derivedRankMovement(previousRank, currentRank) {
  const previous = Number(previousRank);
  const current = Number(currentRank);
  if (!Number.isFinite(previous) || !Number.isFinite(current)) return null;
  return previous - current;
}

function booleanOrNull(value) {
  if (value === true || value === false) return value;
  const text = String(value ?? "").toLowerCase();
  if (text === "true" || text === "yes" || text === "1") return true;
  if (text === "false" || text === "no" || text === "0") return false;
  return null;
}

function numericParam(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function nextMondayIso() {
  const date = new Date();
  const day = date.getUTCDay();
  const daysUntilMonday = ((8 - day) % 7) || 7;
  date.setUTCDate(date.getUTCDate() + daysUntilMonday);
  date.setUTCHours(10, 17, 0, 0);
  return date.toISOString();
}

function isFutureDate(value) {
  return value && new Date(value).getTime() > Date.now();
}

function normalizeName(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replaceAll(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, " ")
    .trim();
}

function safeJson(value) {
  try {
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

function safeErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function jsonResponse(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}
