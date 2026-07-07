import { onRequest } from "../functions/api/market-data.js";
import { onRequest as onMarketHistoryRequest } from "../functions/api/market-history.js";
import { onRequest as onRankTrendsRequest, runTop100TrendUpdate } from "../functions/api/rank-trends.js";
import { onMarketDataRequest, onRefreshTop100MarketRequest } from "../functions/api/top100-market.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/market-data") {
      return onRequest({ request, env, ctx });
    }

    if (url.pathname === "/api/market-history") {
      return onMarketHistoryRequest({ request, env, ctx });
    }

    if (url.pathname === "/api/top100-market-data") {
      if (request.method === "POST") {
        return onRefreshTop100MarketRequest({ request, env, ctx });
      }
      return onMarketDataRequest({ request, env, ctx });
    }

    if (url.pathname === "/api/admin/refresh-top100-market") {
      return onRefreshTop100MarketRequest({ request, env, ctx });
    }

    if (url.pathname === "/api/rank-trends") {
      return onRankTrendsRequest({ request, env, ctx });
    }

    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    const marketRefreshRequest = new Request("https://ondeckprospect.com/api/top100-market-data?limit=100", {
      method: "POST",
    });
    ctx.waitUntil(Promise.allSettled([
      runTop100TrendUpdate(env),
      onRefreshTop100MarketRequest({ request: marketRefreshRequest, env, ctx }),
    ]));
  },
};
