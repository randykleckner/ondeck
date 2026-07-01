import { onRequest } from "../functions/api/market-data.js";
import { onRequest as onMarketHistoryRequest } from "../functions/api/market-history.js";
import { onRequest as onRankTrendsRequest, runTop100TrendUpdate } from "../functions/api/rank-trends.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/market-data") {
      return onRequest({ request, env, ctx });
    }

    if (url.pathname === "/api/market-history") {
      return onMarketHistoryRequest({ request, env, ctx });
    }

    if (url.pathname === "/api/rank-trends") {
      return onRankTrendsRequest({ request, env, ctx });
    }

    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runTop100TrendUpdate(env));
  },
};
