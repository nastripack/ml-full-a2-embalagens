// Aptos para o Full (PRS 12.8): anuncios fora do Full com potencial comprovado de migracao.

import { layout, escapeHtml } from "./dashboard.js";
import { listarAptosParaFull } from "../lib/analytics.js";

export async function handleAptosFull(request, env) {
  const url = new URL(request.url);
  const lojaId = url.searchParams.get("loja");
  if (!lojaId) {
    return new Response("Parametro 'loja' obrigatorio, ex: /aptos-full?loja=123456789", { status: 400 });
  }

  const db = env.DB;
  const loja = await db.prepare("SELECT nickname FROM lojas WHERE loja_id = ?").bind(lojaId).first();
  const nomeLoja = loja?.nickname || lojaId;

  const lista = await listarAptosParaFull(db, lojaId);

  const linhas = lista.slice(0, 50).map(p => `
    <tr>
      <td>${escapeHtml(p.titulo)}</td>
      <td>${escapeHtml(p.mlb)}</td>
      <td>${p.score}</td>
      <td>${p.regularidade}%</td>
      <td>${p.vendas30}</td>
      <td>${p.vendas60}</td>
      <td>${p.vendas90}</td>
      <td>${p.sugestaoInicial}</td>
    </tr>`).join("");

  return new Response(layout(`Aptos para o Full - ${nomeLoja}`, `
  <a class="voltar" href="/?loja=${encodeURIComponent(lojaId)}">&larr; Voltar ao dashboard</a>
  <h1>Aptos para o Full - ${escapeHtml(nomeLoja)}</h1>
  <p style="font-size:0.9rem; color:#666;">
    Anúncios fora do Full com vendas nos últimos 90 dias, ordenados por score de aptidão (regularidade + crescimento + estabilidade).
    Quantidade inicial sugerida é uma estimativa em unidades — sem custo do produto cadastrado, não é possível calcular o capital necessário em R$.
  </p>
  <div class="table-wrap"><table>
    <thead><tr>
      <th>Anúncio</th><th>MLB</th><th>Score</th><th>Regularidade</th>
      <th>Vendas 30d</th><th>Vendas 60d</th><th>Vendas 90d</th><th>Qtd. inicial sugerida</th>
    </tr></thead>
    <tbody>${linhas || '<tr><td colspan="8">Nenhum dado disponível ainda. Rode /backfill-vendas para popular o histórico fora do Full.</td></tr>'}</tbody>
  </table></div>
  `), { headers: { "Content-Type": "text/html; charset=utf-8" } });
}
