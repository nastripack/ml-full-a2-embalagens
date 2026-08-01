// Central de Missoes (PRS secao 12.3): lista as missoes abertas geradas pelo Motor de Regras
// (lib/regras.js) e deixa o usuario marcar como executada ou ignorada (RF-020/RB-008).

import { layout, escapeHtml } from "./dashboard.js";

const ROTULO_PRIORIDADE = { critico: "Crítico", alto: "Alto", medio: "Médio", baixo: "Baixo" };
const ROTULO_TIPO = {
  reposicao: "Reposição",
  armazenagem: "Armazenagem",
  precificacao: "Precificação",
  baixa_relevancia: "Baixa relevância"
};

export async function handleMissoes(request, env) {
  const url = new URL(request.url);
  const lojaId = url.searchParams.get("loja");
  if (!lojaId) {
    return new Response("Parametro 'loja' obrigatorio, ex: /missoes?loja=123456789", { status: 400 });
  }

  const db = env.DB;
  const loja = await db.prepare("SELECT nickname FROM lojas WHERE loja_id = ?").bind(lojaId).first();
  const missoes = await db.prepare(
    `SELECT * FROM missoes WHERE loja_id = ? AND status = 'aberta'
     ORDER BY CASE prioridade WHEN 'critico' THEN 0 WHEN 'alto' THEN 1 WHEN 'medio' THEN 2 WHEN 'baixo' THEN 3 ELSE 4 END, criado_em DESC`
  ).bind(lojaId).all();

  const nomeLoja = loja?.nickname || lojaId;
  const lista = missoes.results || [];

  const cartoes = lista.map(m => `
    <div class="missao">
      <span class="badge badge-${m.prioridade}">${ROTULO_PRIORIDADE[m.prioridade] || m.prioridade}</span>
      <span style="color:#888; font-size:0.8rem; margin-left:0.5rem;">${ROTULO_TIPO[m.tipo] || m.tipo}</span>
      <div class="situacao">${escapeHtml(m.situacao)}</div>
      <div class="motivo">${escapeHtml(m.motivo)}</div>
      <div class="impacto">${escapeHtml(m.impacto_estimado || "")}</div>
      <form class="acoes" method="POST" action="/missoes/${m.id}/status">
        <input type="hidden" name="redirect" value="/missoes?loja=${encodeURIComponent(lojaId)}">
        <button type="submit" name="status" value="executada">Marcar como executada</button>
        <button type="submit" name="status" value="ignorada">Ignorar</button>
      </form>
    </div>`).join("");

  return new Response(layout(`Missões - ${nomeLoja}`, `
    <a class="voltar" href="/?loja=${encodeURIComponent(lojaId)}">&larr; Voltar ao dashboard</a>
    <h1>Central de Missões - ${escapeHtml(nomeLoja)}</h1>
    ${lista.length ? cartoes : '<p>Nenhuma missão aberta no momento. Tudo sob controle.</p>'}
  `), { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

export async function handleMissaoStatus(request, env) {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/missoes\/(\d+)\/status$/);
  if (!match) return new Response("Nao encontrado", { status: 404 });
  const id = match[1];

  const form = await request.formData();
  const status = String(form.get("status") || "");
  const redirect = String(form.get("redirect") || "");
  if (status !== "executada" && status !== "ignorada") {
    return new Response("Status invalido", { status: 400 });
  }

  await env.DB.prepare(
    "UPDATE missoes SET status = ?, resolvido_em = datetime('now') WHERE id = ?"
  ).bind(status, id).run();

  const destino = redirect.startsWith("/") ? `https://${url.host}${redirect}` : `https://${url.host}/missoes`;
  return Response.redirect(destino, 302);
}
