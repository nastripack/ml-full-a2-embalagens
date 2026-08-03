// Pesquisa Global de SKU (PRS secao 12.2): busca por SKU/MLB/nome e mostra um painel completo
// do produto, reaproveitando dados/funcoes ja existentes (sem calculo novo).

import { layout, escapeHtml, formatarMoeda, formatarData } from "./dashboard.js";
import { listarPlanejadorEnvios } from "../lib/analytics.js";

const ROTULO_PRIORIDADE = {
  critico: "Crítico", alto: "Alto", medio: "Médio", sem_dados: "Sem dados", nao_enviar: "Não enviar"
};
const ROTULO_TENDENCIA = {
  crescimento: "Crescimento", estavel: "Estável", desaceleracao: "Desaceleração", volatil: "Volátil", sem_dados: "Sem dados"
};
const ROTULO_CONFIANCA = { alta: "Alta", media: "Média", baixa: "Baixa" };

function formularioBusca(lojaId, valorAtual) {
  return `<form method="GET" action="/pesquisa" style="margin-bottom:1.5rem;">
    <input type="hidden" name="loja" value="${escapeHtml(lojaId)}">
    <input type="text" name="q" value="${escapeHtml(valorAtual)}" placeholder="Buscar por SKU, MLB ou nome..."
      style="padding:0.6rem 0.9rem;border:1px solid #ccc;border-radius:6px;width:320px;font-size:0.95rem;">
    <button type="submit" style="padding:0.6rem 1rem;border-radius:6px;border:none;background:#1a56db;color:white;cursor:pointer;">Buscar</button>
  </form>`;
}

function cabecalho(lojaId, nomeLoja, q) {
  return `
  <a class="voltar" href="/?loja=${encodeURIComponent(lojaId)}">&larr; Voltar ao dashboard</a>
  <h1>Pesquisa Global de SKU - ${escapeHtml(nomeLoja)}</h1>
  ${formularioBusca(lojaId, q)}`;
}

export async function handlePesquisa(request, env) {
  const url = new URL(request.url);
  const lojaId = url.searchParams.get("loja");
  const q = (url.searchParams.get("q") || "").trim();
  if (!lojaId) {
    return new Response("Parametro 'loja' obrigatorio, ex: /pesquisa?loja=123456789", { status: 400 });
  }

  const db = env.DB;
  const loja = await db.prepare("SELECT nickname FROM lojas WHERE loja_id = ?").bind(lojaId).first();
  const nomeLoja = loja?.nickname || lojaId;

  const responder = (corpo) => new Response(
    layout(`Pesquisa - ${nomeLoja}`, corpo),
    { headers: { "Content-Type": "text/html; charset=utf-8" } }
  );

  if (!q) {
    return responder(cabecalho(lojaId, nomeLoja, q));
  }

  const termo = `%${q}%`;
  const resultados = await db.prepare(
    `SELECT * FROM produtos WHERE loja_id = ? AND (sku LIKE ? OR mlb LIKE ? OR nome LIKE ?) ORDER BY nome LIMIT 20`
  ).bind(lojaId, termo, termo, termo).all();
  const lista = resultados.results || [];

  if (lista.length === 0) {
    return responder(`${cabecalho(lojaId, nomeLoja, q)}<p>Nenhum produto encontrado para "${escapeHtml(q)}".</p>`);
  }

  if (lista.length > 1) {
    const linhas = lista.map(p => `
      <tr>
        <td><a href="/pesquisa?loja=${encodeURIComponent(lojaId)}&q=${encodeURIComponent(p.mlb)}">${escapeHtml(p.nome)}</a></td>
        <td>${escapeHtml(p.sku || "-")}</td>
        <td>${escapeHtml(p.mlb)}</td>
      </tr>`).join("");
    return responder(`${cabecalho(lojaId, nomeLoja, q)}
      <p>${lista.length} produtos encontrados:</p>
      <div class="table-wrap"><table><thead><tr><th>Nome</th><th>SKU</th><th>MLB</th></tr></thead><tbody>${linhas}</tbody></table></div>`);
  }

  // Exatamente 1 produto - painel completo (PRS 12.2)
  const produto = lista[0];
  const produtoId = produto.id;

  const [estoque, vendas, envios, performance, missoesAbertas, planejador] = await Promise.all([
    db.prepare("SELECT * FROM estoque_historico WHERE produto_id = ? ORDER BY data_hora DESC LIMIT 1").bind(produtoId).first(),
    db.prepare("SELECT * FROM vendas WHERE produto_id = ? ORDER BY data_hora DESC LIMIT 15").bind(produtoId).all(),
    db.prepare("SELECT * FROM envios WHERE produto_id = ? ORDER BY data DESC LIMIT 10").bind(produtoId).all(),
    db.prepare("SELECT * FROM performance_historico WHERE produto_id = ? ORDER BY data DESC LIMIT 15").bind(produtoId).all(),
    db.prepare("SELECT * FROM missoes WHERE produto_id = ? AND status = 'aberta' ORDER BY criado_em DESC").bind(produtoId).all(),
    listarPlanejadorEnvios(db, lojaId)
  ]);

  const indicador = planejador.find(p => p.produtoId === produtoId);

  const linhasVendas = (vendas.results || []).map(v => `
    <tr><td>${formatarData(v.data_hora, true)}</td><td>${v.quantidade}</td><td>${formatarMoeda(v.valor_bruto)}</td><td>${formatarMoeda(v.valor_liquido)}</td></tr>`
  ).join("") || '<tr><td colspan="4">Sem vendas registradas.</td></tr>';

  const linhasEnvios = (envios.results || []).map(e => `
    <tr><td>${formatarData(e.data)}</td><td>${escapeHtml(e.remessa || "-")}</td><td>${e.quantidade_enviada ?? "-"}</td></tr>`
  ).join("") || '<tr><td colspan="3">Sem envios registrados.</td></tr>';

  const linhasPerformance = (performance.results || []).map(p => `
    <tr><td>${formatarData(p.data)}</td><td>${p.visualizacoes ?? "-"}</td></tr>`
  ).join("") || '<tr><td colspan="2">Sem dados de performance.</td></tr>';

  const analiseIA = (missoesAbertas.results || []).length
    ? (missoesAbertas.results || []).map(m => `
        <div class="missao">
          <div class="situacao">${escapeHtml(m.situacao)}</div>
          <div class="motivo">${escapeHtml(m.motivo)}</div>
          <div class="impacto">${escapeHtml(m.impacto_estimado || "")}</div>
        </div>`).join("")
    : "<p>Nenhuma situação especial identificada pelo Motor de Regras no momento.</p>";

  const painelIndicadores = indicador ? `
    <div class="cards">
      <div class="card"><div class="label">Prioridade</div><div class="value"><span class="badge badge-${indicador.prioridade}">${ROTULO_PRIORIDADE[indicador.prioridade]}</span></div></div>
      <div class="card"><div class="label">Cobertura (dias)</div><div class="value">${indicador.cobertura === Infinity ? "-" : Math.round(indicador.cobertura)}</div></div>
      <div class="card"><div class="label">Tendência</div><div class="value" style="font-size:1.2rem">${ROTULO_TENDENCIA[indicador.tendencia]}</div></div>
      <div class="card"><div class="label">Confiança</div><div class="value" style="font-size:1.2rem">${ROTULO_CONFIANCA[indicador.confianca]}</div></div>
      <div class="card"><div class="label">Sugestão de envio</div><div class="value">${indicador.sugestaoEnvio}</div></div>
    </div>
    <p style="font-size:0.9rem; color:#555;">Projeção de vendas: 7d = ${indicador.projecoes.d7} · 15d = ${indicador.projecoes.d15} · 30d = ${indicador.projecoes.d30} · 60d = ${indicador.projecoes.d60}</p>
  ` : "<p>Estoque ainda não sincronizado para este produto.</p>";

  return responder(`${cabecalho(lojaId, nomeLoja, q)}
  <h2>${escapeHtml(produto.nome)}</h2>
  <p style="color:#666;">SKU: ${escapeHtml(produto.sku || "-")} · MLB: ${escapeHtml(produto.mlb)} · Categoria: ${escapeHtml(produto.categoria || "-")} · Status: ${escapeHtml(produto.status || "-")}</p>

  <h3>Indicador de saúde do item</h3>
  ${painelIndicadores}

  <h3>Estoque Full atual</h3>
  <p>${estoque ? `${estoque.estoque_full ?? "-"} unidades (atualizado em ${formatarData(estoque.data_hora, true)})` : "Sem dado de estoque sincronizado."}</p>

  <h3>Análise da IA (Motor de Regras)</h3>
  ${analiseIA}

  <h3>Últimos envios ao Full</h3>
  <div class="table-wrap"><table><thead><tr><th>Data</th><th>Remessa</th><th>Quantidade</th></tr></thead><tbody>${linhasEnvios}</tbody></table></div>

  <h3>Histórico de vendas (últimas 15)</h3>
  <div class="table-wrap"><table><thead><tr><th>Data</th><th>Quantidade</th><th>Valor bruto</th><th>Valor líquido</th></tr></thead><tbody>${linhasVendas}</tbody></table></div>

  <h3>Performance (visitas)</h3>
  <div class="table-wrap"><table><thead><tr><th>Data</th><th>Visualizações</th></tr></thead><tbody>${linhasPerformance}</tbody></table></div>
  `);
}
