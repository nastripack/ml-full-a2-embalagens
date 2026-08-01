import { listarPlanejadorEnvios, calcularIndiceSaude } from "../lib/analytics.js";

const ROTULO_PRIORIDADE = {
  critico: "Crítico",
  alto: "Alto",
  medio: "Médio",
  sem_dados: "Sem dados",
  nao_enviar: "Não enviar"
};

const ROTULO_TENDENCIA = {
  crescimento: "Crescimento",
  estavel: "Estável",
  desaceleracao: "Desaceleração",
  volatil: "Volátil",
  sem_dados: "Sem dados"
};

const ROTULO_CONFIANCA = { alta: "Alta", media: "Média", baixa: "Baixa" };

export function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

export function layout(titulo, corpo) {
  return `<!doctype html>
<html lang="pt-br">
<head>
<meta charset="utf-8">
<title>${escapeHtml(titulo)}</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 2rem; background: #f5f5f5; color: #1a1a1a; }
  h1 { font-size: 1.4rem; }
  a { color: #1a56db; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .voltar { display: inline-block; margin-bottom: 1rem; font-size: 0.9rem; }
  .banner { background: #e6f4ea; border: 1px solid #b7dfc0; color: #1e7a34; padding: 0.75rem 1rem; border-radius: 8px; margin-bottom: 1.5rem; }
  .cards { display: flex; gap: 1rem; margin-bottom: 2rem; flex-wrap: wrap; }
  .card { background: white; border-radius: 8px; padding: 1rem 1.5rem; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  .card .label { font-size: 0.8rem; color: #666; }
  .card .value { font-size: 1.6rem; font-weight: 600; }
  .table-wrap { overflow-x: auto; margin-bottom: 2rem; }
  table { width: 100%; border-collapse: collapse; background: white; border-radius: 8px; overflow: hidden; }
  th, td { text-align: left; padding: 0.5rem 0.75rem; border-bottom: 1px solid #eee; font-size: 0.9rem; }
  th { background: #fafafa; }
  .rank-1 { font-weight: 700; }
  .badge { display: inline-block; padding: 0.15rem 0.6rem; border-radius: 999px; font-size: 0.78rem; font-weight: 600; }
  .badge-critico { background: #fde2e1; color: #a31510; }
  .badge-alto { background: #fef0c7; color: #92400e; }
  .badge-medio { background: #e0edff; color: #1e40af; }
  .badge-baixo { background: #eef2f5; color: #4b5563; }
  .badge-sem_dados { background: #eee; color: #666; }
  .missao { background: white; border-radius: 8px; padding: 1rem 1.25rem; margin-bottom: 0.75rem; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  .missao .situacao { font-weight: 600; margin: 0.4rem 0 0.2rem; }
  .missao .motivo, .missao .impacto { font-size: 0.88rem; color: #444; margin: 0.15rem 0; }
  .missao .acoes { margin-top: 0.6rem; }
  .missao .acoes button { font-size: 0.8rem; padding: 0.3rem 0.7rem; border-radius: 6px; border: 1px solid #ccc; background: #fafafa; cursor: pointer; margin-right: 0.5rem; }
  .missao .acoes button:hover { background: #eee; }
  .saude-score { font-size: 2rem; font-weight: 700; }
</style>
</head>
<body>
${corpo}
</body>
</html>`;
}

async function renderOverview(env) {
  const db = env.DB;

  const lojas = await db.prepare("SELECT loja_id, nickname FROM lojas WHERE ativo = 1 ORDER BY nickname").all();

  const ranking = await db.prepare(
    `SELECT l.loja_id, l.nickname,
            COALESCE(SUM(v.valor_liquido), 0) as total,
            COUNT(v.id) as pedidos
     FROM lojas l
     LEFT JOIN vendas v ON v.loja_id = l.loja_id AND v.data_hora >= datetime('now', '-30 days')
     WHERE l.ativo = 1
     GROUP BY l.loja_id
     ORDER BY total DESC`
  ).all();

  const topProdutos = await db.prepare(
    `SELECT p.nome, l.nickname, SUM(v.quantidade) as qtd, SUM(v.valor_liquido) as receita
     FROM vendas v
     JOIN produtos p ON p.id = v.produto_id
     JOIN lojas l ON l.loja_id = v.loja_id
     WHERE v.data_hora >= datetime('now', '-30 days')
     GROUP BY v.produto_id
     ORDER BY receita DESC
     LIMIT 10`
  ).all();

  const linhasLojas = (lojas.results || []).map(l => `
    <tr><td><a href="/?loja=${encodeURIComponent(l.loja_id)}">${escapeHtml(l.nickname || l.loja_id)}</a></td></tr>`).join("");

  const linhasRanking = (ranking.results || []).map((r, i) => `
    <tr class="${i === 0 ? "rank-1" : ""}">
      <td>${i + 1}</td>
      <td><a href="/?loja=${encodeURIComponent(r.loja_id)}">${escapeHtml(r.nickname || r.loja_id)}</a></td>
      <td>R$ ${Number(r.total).toFixed(2)}</td>
      <td>${r.pedidos}</td>
    </tr>`).join("");

  const linhasTop = (topProdutos.results || []).map(p => `
    <tr>
      <td>${escapeHtml(p.nome)}</td>
      <td>${escapeHtml(p.nickname)}</td>
      <td>${p.qtd}</td>
      <td>R$ ${Number(p.receita).toFixed(2)}</td>
    </tr>`).join("");

  return layout("Visao Geral - ML Full", `
  <a class="voltar" href="/saude">Saude do sistema &rarr;</a>
  <h1>Visao Geral - Mercado Livre Full</h1>

  <h2>Lojas conectadas</h2>
  <div class="table-wrap"><table>
    <thead><tr><th>Loja</th></tr></thead>
    <tbody>${linhasLojas || '<tr><td>Nenhuma loja conectada ainda. Acesse /auth/login para conectar a primeira.</td></tr>'}</tbody>
  </table></div>

  <h2>Ranking de vendas (30 dias)</h2>
  <div class="table-wrap"><table>
    <thead><tr><th>#</th><th>Loja</th><th>Valor liquido</th><th>Pedidos</th></tr></thead>
    <tbody>${linhasRanking || '<tr><td colspan="4">Sem vendas no periodo.</td></tr>'}</tbody>
  </table></div>

  <h2>Top produtos entre todas as lojas (30 dias)</h2>
  <div class="table-wrap"><table>
    <thead><tr><th>Produto</th><th>Loja</th><th>Qtd vendida</th><th>Receita liquida</th></tr></thead>
    <tbody>${linhasTop || '<tr><td colspan="4">Sem vendas no periodo.</td></tr>'}</tbody>
  </table></div>
  `);
}

async function renderLoja(env, lojaId, recemConectado) {
  const db = env.DB;

  const loja = await db.prepare("SELECT nickname FROM lojas WHERE loja_id = ?").bind(lojaId).first();

  const totalVendido = await db.prepare(
    "SELECT COALESCE(SUM(valor_liquido), 0) as total, COUNT(*) as pedidos FROM vendas WHERE loja_id = ? AND data_hora >= datetime('now', '-30 days')"
  ).bind(lojaId).first();

  const produtos = await db.prepare(
    "SELECT id, sku, mlb, nome, status FROM produtos WHERE loja_id = ? ORDER BY atualizado_em DESC LIMIT 50"
  ).bind(lojaId).all();

  const ultimaSync = await db.prepare(
    "SELECT data_hora FROM eventos WHERE loja_id = ? AND tipo = 'sincronizacao_concluida' ORDER BY data_hora DESC LIMIT 1"
  ).bind(lojaId).first();

  const planejador = await listarPlanejadorEnvios(db, lojaId);
  const itensAtencao = planejador.filter(p => p.prioridade !== "nao_enviar" && p.prioridade !== "sem_dados");
  const itensCriticos = planejador.filter(p => p.prioridade === "critico" || p.prioridade === "alto").length;
  const indiceSaude = calcularIndiceSaude(planejador);

  const missoesPorPrioridade = await db.prepare(
    `SELECT prioridade, COUNT(*) as total FROM missoes WHERE loja_id = ? AND status = 'aberta' GROUP BY prioridade`
  ).bind(lojaId).all();
  const contagemMissoes = { critico: 0, alto: 0, medio: 0, baixo: 0 };
  for (const linha of missoesPorPrioridade.results || []) {
    if (linha.prioridade in contagemMissoes) contagemMissoes[linha.prioridade] = linha.total;
  }
  const totalMissoesAbertas = Object.values(contagemMissoes).reduce((a, b) => a + b, 0);

  const linhasProdutos = (produtos.results || []).map(p => `
    <tr>
      <td>${escapeHtml(p.sku || "-")}</td>
      <td>${escapeHtml(p.mlb)}</td>
      <td>${escapeHtml(p.nome)}</td>
      <td>${escapeHtml(p.status || "-")}</td>
    </tr>`).join("");

  const banner = recemConectado
    ? `<div class="banner">Conta vinculada com sucesso! Se ainda nao tiver dados abaixo, acesse <a href="/sync?loja=${encodeURIComponent(lojaId)}">/sync?loja=${escapeHtml(lojaId)}</a> para sincronizar pela primeira vez.</div>`
    : "";

  const nomeLoja = loja?.nickname || lojaId;

  return layout(`Dashboard - ${nomeLoja}`, `
  <a class="voltar" href="/">&larr; Ver todas as lojas</a>
  <a class="voltar" href="/missoes?loja=${encodeURIComponent(lojaId)}" style="margin-left:1rem">Central de Missões &rarr;</a>
  ${banner}
  <h1>Dashboard Executivo - ${escapeHtml(nomeLoja)}</h1>
  <div class="cards">
    <div class="card">
      <div class="label">Valor liquido vendido (30 dias)</div>
      <div class="value">R$ ${Number(totalVendido.total).toFixed(2)}</div>
    </div>
    <div class="card">
      <div class="label">Pedidos (30 dias)</div>
      <div class="value">${totalVendido.pedidos}</div>
    </div>
    <div class="card">
      <div class="label">Ultima sincronizacao</div>
      <div class="value" style="font-size:1rem">${ultimaSync ? escapeHtml(ultimaSync.data_hora) : "nunca"}</div>
    </div>
    <div class="card">
      <div class="label">Itens em risco de ruptura</div>
      <div class="value">${itensCriticos}</div>
    </div>
    <div class="card">
      <div class="label">Índice de saúde da operação</div>
      <div class="value saude-score">${indiceSaude === null ? "-" : `${indiceSaude}%`}</div>
    </div>
  </div>

  <h2>Resumo executivo</h2>
  <p>
    ${totalMissoesAbertas === 0
      ? "Nenhuma missão aberta no momento — operação sob controle."
      : `${totalMissoesAbertas} missão(ões) aberta(s): ${contagemMissoes.critico} crítica(s), ${contagemMissoes.alto} alta(s), ${contagemMissoes.medio} média(s), ${contagemMissoes.baixo} baixa(s).
         <a href="/missoes?loja=${encodeURIComponent(lojaId)}">Ver Central de Missões &rarr;</a>`}
  </p>

  <h2>Planejador Inteligente de Envios</h2>
  <div class="table-wrap"><table>
    <thead><tr>
      <th>Produto</th><th>Estoque Full</th><th>Média diária</th><th>Cobertura (dias)</th>
      <th>Tendência</th><th>Confiança</th><th>Sugestão de envio</th>
      <th>Projeção 7d</th><th>Projeção 15d</th><th>Projeção 30d</th><th>Projeção 60d</th>
      <th>Prioridade</th>
    </tr></thead>
    <tbody>${itensAtencao.length ? itensAtencao.slice(0, 20).map(p => `
      <tr>
        <td>${escapeHtml(p.nome)}</td>
        <td>${p.estoqueAtual}</td>
        <td>${p.mediaDiaria.toFixed(2)}</td>
        <td>${p.cobertura === Infinity ? "-" : Math.round(p.cobertura)}</td>
        <td>${ROTULO_TENDENCIA[p.tendencia]}</td>
        <td>${ROTULO_CONFIANCA[p.confianca]}</td>
        <td>${p.sugestaoEnvio}</td>
        <td>${p.projecoes.d7}</td>
        <td>${p.projecoes.d15}</td>
        <td>${p.projecoes.d30}</td>
        <td>${p.projecoes.d60}</td>
        <td><span class="badge badge-${p.prioridade}">${ROTULO_PRIORIDADE[p.prioridade]}</span></td>
      </tr>`).join("") : '<tr><td colspan="12">Nenhum item precisando de atenção no momento.</td></tr>'}</tbody>
  </table></div>

  <h2>Produtos sincronizados</h2>
  <div class="table-wrap"><table>
    <thead><tr><th>SKU</th><th>MLB</th><th>Nome</th><th>Status</th></tr></thead>
    <tbody>${linhasProdutos || `<tr><td colspan="4">Nenhum produto sincronizado ainda. Acesse /sync?loja=${escapeHtml(lojaId)}.</td></tr>`}</tbody>
  </table></div>
  `);
}

export async function handleDashboard(request, env) {
  const url = new URL(request.url);
  const lojaId = url.searchParams.get("loja");
  const recemConectado = url.searchParams.get("recem_conectado") === "1";

  const html = lojaId ? await renderLoja(env, lojaId, recemConectado) : await renderOverview(env);

  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}
