import { onRequest } from "../functions/api/market-data.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/market-data") {
      return onRequest({ request, env, ctx });
    }

    return env.ASSETS.fetch(request);
  },
};
