function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

function layout(titulo, corpo) {
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
  table { width: 100%; border-collapse: collapse; background: white; border-radius: 8px; overflow: hidden; margin-bottom: 2rem; }
  th, td { text-align: left; padding: 0.5rem 0.75rem; border-bottom: 1px solid #eee; font-size: 0.9rem; }
  th { background: #fafafa; }
  .rank-1 { font-weight: 700; }
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
  <h1>Visao Geral - Mercado Livre Full</h1>

  <h2>Lojas conectadas</h2>
  <table>
    <thead><tr><th>Loja</th></tr></thead>
    <tbody>${linhasLojas || '<tr><td>Nenhuma loja conectada ainda. Acesse /auth/login para conectar a primeira.</td></tr>'}</tbody>
  </table>

  <h2>Ranking de vendas (30 dias)</h2>
  <table>
    <thead><tr><th>#</th><th>Loja</th><th>Valor liquido</th><th>Pedidos</th></tr></thead>
    <tbody>${linhasRanking || '<tr><td colspan="4">Sem vendas no periodo.</td></tr>'}</tbody>
  </table>

  <h2>Top produtos entre todas as lojas (30 dias)</h2>
  <table>
    <thead><tr><th>Produto</th><th>Loja</th><th>Qtd vendida</th><th>Receita liquida</th></tr></thead>
    <tbody>${linhasTop || '<tr><td colspan="4">Sem vendas no periodo.</td></tr>'}</tbody>
  </table>
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
  </div>
  <h2>Produtos sincronizados</h2>
  <table>
    <thead><tr><th>SKU</th><th>MLB</th><th>Nome</th><th>Status</th></tr></thead>
    <tbody>${linhasProdutos || `<tr><td colspan="4">Nenhum produto sincronizado ainda. Acesse /sync?loja=${escapeHtml(lojaId)}.</td></tr>`}</tbody>
  </table>
  `);
}

export async function handleDashboard(request, env) {
  const url = new URL(request.url);
  const lojaId = url.searchParams.get("loja");
  const recemConectado = url.searchParams.get("recem_conectado") === "1";

  const html = lojaId ? await renderLoja(env, lojaId, recemConectado) : await renderOverview(env);

  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}
