import { handleLogin, handleCallback } from "./routes/auth.js";
import { handleSync, runSyncForLoja } from "./routes/sync.js";
import { handleDashboard } from "./routes/dashboard.js";
import { handleBackfillRemessas, handleBackfillVendas } from "./routes/backfill.js";
import { handleSaude } from "./routes/saude.js";
import { handleMissoes, handleMissaoStatus } from "./routes/missoes.js";
import { handlePesquisa } from "./routes/pesquisa.js";
import { handleAptosFull } from "./routes/aptos.js";
import { handleLoginPage, handleLoginSubmit, handleLogout } from "./routes/login.js";
import { verificarToken, lerCookie } from "./lib/sessao.js";
import { enviarAlertaFalha } from "./lib/alertas.js";
import { registrarEvento, contarFalhasConsecutivas } from "./lib/db.js";

const HOST_LOGIN = "full2.nastripack.com.br";
// O cron roda de hora em hora: 3 falhas seguidas significam ~3h sem sincronizar, ai sim e problema
// de verdade e vale um e-mail. Falha isolada fica registrada em /saude, sem notificar.
const FALHAS_ANTES_DE_ALERTAR = 3;

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
      if (url.pathname === "/pesquisa") return handlePesquisa(request, env);
      if (url.pathname === "/aptos-full") return handleAptosFull(request, env);
      if (/^\/missoes\/\d+\/status$/.test(url.pathname) && request.method === "POST") return handleMissaoStatus(request, env);
      if (url.pathname === "/") return handleDashboard(request, env);

      return new Response("Nao encontrado", { status: 404 });
    } catch (err) {
      return new Response(`Erro interno: ${err.message}`, { status: 500 });
    }
  },

  async scheduled(event, env, ctx) {
    const lojas = await env.DB.prepare("SELECT loja_id FROM ml_auth").all();
    const lista = lojas.results || [];
    // Roda todas as lojas em paralelo (I/O-bound, esperando resposta da API do ML) em vez de
    // sequencial - com varias lojas conectadas, sequencial somaria o tempo de cada uma e arriscaria
    // estourar o teto de execucao do Worker, deixando as ultimas da lista sem sincronizar.
    const resultados = await Promise.allSettled(lista.map(({ loja_id }) => runSyncForLoja(env, loja_id)));
    for (let i = 0; i < resultados.length; i++) {
      if (resultados[i].status !== "rejected") continue;
      const lojaId = lista[i].loja_id;
      const erro = resultados[i].reason;

      // Registra a falha no banco antes de qualquer coisa: sem isso, uma sincronizacao que morre
      // no meio nao deixa rastro nenhum e a pagina /saude continua mostrando a ultima rodada boa,
      // como se estivesse tudo certo.
      try {
        await registrarEvento(env.DB, lojaId, "sincronizacao_falhou", null, { erro: erro?.message || String(erro) }, "worker_sync");
      } catch { /* se o proprio D1 estiver fora, ainda tentamos alertar abaixo */ }

      // So manda e-mail quando o problema persiste. A API do Mercado Livre devolve 429/5xx em
      // rajadas curtas que se resolvem sozinhas na rodada seguinte - alertar a cada uma delas so
      // gerava ruido diario na caixa de entrada e escondia a falha que importa.
      let consecutivas = FALHAS_ANTES_DE_ALERTAR;
      try {
        consecutivas = await contarFalhasConsecutivas(env.DB, lojaId);
      } catch { /* sem conseguir contar, mantem o comportamento de alertar */ }

      if (consecutivas >= FALHAS_ANTES_DE_ALERTAR) {
        await enviarAlertaFalha(
          env,
          `sincronizacao automatica (loja ${lojaId}) - ${consecutivas} falhas seguidas`,
          erro
        );
      }
    }
  }
};
