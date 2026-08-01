import { handleLogin, handleCallback } from "./routes/auth.js";
import { handleSync, runSyncForLoja } from "./routes/sync.js";
import { handleDashboard } from "./routes/dashboard.js";
import { handleBackfillRemessas, handleBackfillVendas } from "./routes/backfill.js";
import { handleSaude } from "./routes/saude.js";
import { handleMissoes, handleMissaoStatus } from "./routes/missoes.js";
import { handleLoginPage, handleLoginSubmit, handleLogout } from "./routes/login.js";
import { verificarToken, lerCookie } from "./lib/sessao.js";
import { enviarAlertaFalha } from "./lib/alertas.js";

const HOST_LOGIN = "full2.nastripack.com.br";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      // /logout funciona em qualquer host, mesmo sem sessao valida
      if (url.pathname === "/logout") return handleLogout(request, env);

      // full2.nastripack.com.br so mostra a tela de login - e a "contracapa"
      if (url.hostname === HOST_LOGIN) {
        if (url.pathname === "/login" && request.method === "POST") return handleLoginSubmit(request, env);
        return handleLoginPage(request, env);
      }

      // qualquer outro host (o dashboard de verdade) exige sessao valida antes de qualquer rota
      const token = lerCookie(request, "sessao");
      const sessao = await verificarToken(env, token);
      if (!sessao) {
        const redirect = encodeURIComponent(url.pathname + url.search);
        return Response.redirect(`https://${HOST_LOGIN}/login?redirect=${redirect}`, 302);
      }

      if (url.pathname === "/auth/login") return handleLogin(request, env);
      if (url.pathname === "/auth/callback") return handleCallback(request, env);
      if (url.pathname === "/sync") return handleSync(request, env);
      if (url.pathname === "/backfill-remessas") return handleBackfillRemessas(request, env);
      if (url.pathname === "/backfill-vendas") return handleBackfillVendas(request, env);
      if (url.pathname === "/saude") return handleSaude(request, env);
      if (url.pathname === "/missoes") return handleMissoes(request, env);
      if (/^\/missoes\/\d+\/status$/.test(url.pathname) && request.method === "POST") return handleMissaoStatus(request, env);
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
