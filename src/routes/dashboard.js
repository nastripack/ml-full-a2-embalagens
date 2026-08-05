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
const LIMITE_PLANEJADOR = 20; // a tabela mostra so os mais urgentes; o total aparece abaixo dela

export function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

// Formato brasileiro: virgula decimal, ponto de milhar (10002.69 -> 10.002,69).
export function formatarNumero(n, casas = 2) {
  return Number(n).toLocaleString("pt-BR", { minimumFractionDigits: casas, maximumFractionDigits: casas });
}

export function formatarMoeda(n) {
  return `R$ ${formatarNumero(n)}`;
}

// Brasil nao observa horario de verao desde 2019 - UTC-3 fixo o ano todo, sem tabela de regras.
const OFFSET_BRASILIA_MS = -3 * 60 * 60 * 1000;

// Formato brasileiro de data: dia/mes/ano (opcionalmente com hora). O banco (SQLite/D1) grava tudo
// em UTC via datetime('now') - sem converter, a hora exibida ficava 3h a frente da hora real de
// Brasilia, dando a impressao de sincronizacao no futuro. So desloca quando ha hora no valor (colunas
// data_hora, timestamp completo); colunas so-data (envios.data, performance_historico.data, gravadas
// com date('now')) nao tem componente de hora pra deslocar com seguranca, entao ficam como estao.
export function formatarData(valor, comHora = false) {
  if (!valor) return "-";
  const str = String(valor);
  const horaMatch = str.match(/(\d{2}):(\d{2})/);

  if (comHora && horaMatch) {
    const isoUtc = str.replace(" ", "T") + (str.endsWith("Z") ? "" : "Z");
    const instante = new Date(isoUtc);
    if (!isNaN(instante.getTime())) {
      const local = new Date(instante.getTime() + OFFSET_BRASILIA_MS);
      const dia = String(local.getUTCDate()).padStart(2, "0");
      const mes = String(local.getUTCMonth() + 1).padStart(2, "0");
      const ano = local.getUTCFullYear();
      const hora = String(local.getUTCHours()).padStart(2, "0");
      const minuto = String(local.getUTCMinutes()).padStart(2, "0");
      return `${dia}/${mes}/${ano} ${hora}:${minuto}`;
    }
  }

  const dataMatch = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!dataMatch) return str;
  const [, ano, mes, dia] = dataMatch;
  let resultado = `${dia}/${mes}/${ano}`;
  if (comHora && horaMatch) resultado += ` ${horaMatch[1]}:${horaMatch[2]}`;
  return resultado;
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
  .simulacao { background: white; border-radius: 8px; padding: 1rem 1.25rem; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  .sim-inputs { display: flex; gap: 1.5rem; flex-wrap: wrap; }
  .sim-inputs label { display: flex; flex-direction: column; font-size: 0.85rem; color: #444; gap: 0.3rem; }
  .sim-inputs input { padding: 0.5rem 0.7rem; border: 1px solid #ccc; border-radius: 6px; font-size: 0.95rem; width: 160px; }
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
      <td>${formatarMoeda(r.total)}</td>
      <td>${r.pedidos}</td>
    </tr>`).join("");

  const linhasTop = (topProdutos.results || []).map(p => `
    <tr>
      <td>${escapeHtml(p.nome)}</td>
      <td>${escapeHtml(p.nickname)}</td>
      <td>${p.qtd}</td>
      <td>${formatarMoeda(p.receita)}</td>
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

  const LABEL_COLETA_FULL = "Custo do serviço de coleta Full";
  const custosColeta = await db.prepare(
    `SELECT periodo, valor FROM custos_transporte WHERE loja_id = ? AND label = ? ORDER BY periodo DESC LIMIT 2`
  ).bind(lojaId, LABEL_COLETA_FULL).all();
  const [custoMesAtual, custoMesAnterior] = custosColeta.results || [];
  const variacaoColeta = custoMesAtual && custoMesAnterior && custoMesAnterior.valor > 0
    ? (custoMesAtual.valor - custoMesAnterior.valor) / custoMesAnterior.valor
    : null;

  // Usa o mesmo periodo do custo exibido (pode nao ser o mes corrente - ex: agosto ainda sem
  // cobranca de coleta lancada mostra julho), pra nao cruzar custo de um mes com envios de outro.
  const unidadesEnviadasMes = custoMesAtual
    ? await db.prepare(
        `SELECT COALESCE(SUM(quantidade_enviada), 0) as total FROM envios
         WHERE loja_id = ? AND strftime('%Y-%m', data) = ?`
      ).bind(lojaId, custoMesAtual.periodo.slice(0, 7)).first()
    : { total: 0 };
  const custoMedioUnidade = custoMesAtual && unidadesEnviadasMes.total > 0
    ? custoMesAtual.valor / unidadesEnviadasMes.total
    : null;

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
  <a class="voltar" href="/aptos-full?loja=${encodeURIComponent(lojaId)}" style="margin-left:1rem">Aptos para o Full &rarr;</a>
  ${banner}
  <h1>Dashboard Executivo - ${escapeHtml(nomeLoja)}</h1>
  <form method="GET" action="/pesquisa" style="margin-bottom:1.5rem;">
    <input type="hidden" name="loja" value="${escapeHtml(lojaId)}">
    <input type="text" name="q" placeholder="Buscar por SKU, MLB ou nome..."
      style="padding:0.6rem 0.9rem;border:1px solid #ccc;border-radius:6px;width:320px;font-size:0.95rem;">
    <button type="submit" style="padding:0.6rem 1rem;border-radius:6px;border:none;background:#1a56db;color:white;cursor:pointer;">Buscar</button>
  </form>
  <div class="cards">
    <div class="card">
      <div class="label">Valor liquido vendido (30 dias)</div>
      <div class="value">${formatarMoeda(totalVendido.total)}</div>
    </div>
    <div class="card">
      <div class="label">Pedidos (30 dias)</div>
      <div class="value">${totalVendido.pedidos}</div>
    </div>
    <div class="card">
      <div class="label">Ultima sincronizacao</div>
      <div class="value" style="font-size:1rem">${ultimaSync ? formatarData(ultimaSync.data_hora, true) : "nunca"}</div>
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

  <h2>Gastos com Transporte (Coleta Full)</h2>
  <div class="cards">
    <div class="card">
      <div class="label">Custo de coleta - ${custoMesAtual ? custoMesAtual.periodo.slice(0, 7) : "mês atual"}</div>
      <div class="value">${formatarMoeda(custoMesAtual ? custoMesAtual.valor : 0)}</div>
    </div>
    <div class="card">
      <div class="label">Variação vs. mês anterior</div>
      <div class="value" style="font-size:1.3rem">${variacaoColeta === null ? "-" : `${variacaoColeta > 0 ? "+" : ""}${formatarNumero(variacaoColeta * 100, 1)}%`}</div>
    </div>
    <div class="card">
      <div class="label">Custo médio por unidade enviada</div>
      <div class="value" style="font-size:1.3rem">${custoMedioUnidade === null ? "-" : formatarMoeda(custoMedioUnidade)}</div>
    </div>
  </div>
  <p style="font-size:0.85rem; color:#666; margin-top:-0.5rem">
    Total mensal de "Custo do serviço de coleta Full" via API de Faturamento do Mercado Livre — não há detalhamento por remessa individual disponível via API.
  </p>

  <h2>Planejador Inteligente de Envios</h2>
  <div class="table-wrap"><table>
    <thead><tr>
      <th>Produto</th><th>Estoque Full</th><th>Média diária</th><th>Cobertura (dias)</th>
      <th>Tendência</th><th>Confiança</th><th>Sugestão de envio</th>
      <th>Projeção 7d</th><th>Projeção 15d</th><th>Projeção 30d</th><th>Projeção 60d</th>
      <th>Prioridade</th>
    </tr></thead>
    <tbody>${itensAtencao.length ? itensAtencao.slice(0, LIMITE_PLANEJADOR).map(p => `
      <tr>
        <td>${escapeHtml(p.nome)}</td>
        <td>${p.estoqueAtual}</td>
        <td>${formatarNumero(p.mediaDiaria)}</td>
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
  ${itensAtencao.length > LIMITE_PLANEJADOR ? `<p style="font-size:0.85rem; color:#666; margin-top:-0.5rem">
    Mostrando os ${LIMITE_PLANEJADOR} itens mais urgentes de ${formatarNumero(itensAtencao.length, 0)} que precisam de atenção.
  </p>` : ""}

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
