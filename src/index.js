import { handleLogin, handleCallback } from "./routes/auth.js";
import { handleSync, runSyncForLoja } from "./routes/sync.js";
import { handleDashboard } from "./routes/dashboard.js";
import { handleBackfillRemessas, handleBackfillVendas } from "./routes/backfill.js";
import { enviarAlertaFalha } from "./lib/alertas.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/auth/login") return handleLogin(request, env);
      if (url.pathname === "/auth/callback") return handleCallback(request, env);
      if (url.pathname === "/sync") return handleSync(request, env);
      if (url.pathname === "/backfill-remessas") return handleBackfillRemessas(request, env);
      if (url.pathname === "/backfill-vendas") return handleBackfillVendas(request, env);
      if (url.pathname === "/") return handleDashboard(request, env);

      return new Response("Nao encontrado", { status: 404 });
    } catch (err) {
      return new Response(`Erro interno: ${err.message}`, { status: 500 });
    }
  },

  async scheduled(event, env, ctx) {
    const lojas = await env.DB.prepare("SELECT loja_id FROM ml_auth").all();
    for (const { loja_id } of lojas.results || []) {
      try {
        await runSyncForLoja(env, loja_id);
      } catch (err) {
        await enviarAlertaFalha(env, `sincronizacao automatica (loja ${loja_id})`, err);
      }
    }
  }
};
