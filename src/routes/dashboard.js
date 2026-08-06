import { listarPlanejadorEnvios, calcularIndiceSaude, listarAptosParaFull } from "../lib/analytics.js";

const ROTULO_PRIORIDADE = {
  critico: "Crítico",
  alto: "Alto",
  medio: "Médio",
  sem_dados: "Sem dados",
  nao_enviar: "Não enviar"
};

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
  <a href="/auth/login" style="display:inline-block;margin-bottom:1rem;padding:0.6rem 1.1rem;border-radius:6px;background:#1a56db;color:white;font-weight:600;">+ Conectar nova loja</a>
  <div class="table-wrap"><table>
    <thead><tr><th>Loja</th></tr></thead>
    <tbody>${linhasLojas || '<tr><td>Nenhuma loja conectada ainda.</td></tr>'}</tbody>
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

// ---- Painel de Comando (substitui o Dashboard Executivo) ----
// Segue a identidade visual ja usada nos outros projetos internos da Nastripack (nastripack-
// comunicados etc.): fundo #080B12/#0F1320, azul #2563EB, fonte Plus Jakarta Sans (igual ao
// cotacao.nastripack.com.br), icones estilo Tabler, botões vazados com borda iluminada.
// (traco fino, sem preenchimento). Cor sempre carrega significado, nunca decoracao.
const COR_STATUS = { ok: "#22c55e", atencao: "#eab308", alerta: "#f97316", critico: "#ef4444" };
const ROTULO_STATUS = { ok: "OK", atencao: "ATENÇÃO", alerta: "ALERTA", critico: "CRÍTICO" };

// Icones em traco fino (viewBox 24x24, stroke-based), no espirito do Tabler Icons ja usado nos
// outros projetos - desenhados a mao aqui em vez de embutir o pacote inteiro via CDN.
const ICONE_PATH = {
  sync: '<path d="M4 4v5h5"/><path d="M20 20v-5h-5"/><path d="M4.6 15A8 8 0 0 0 20 12"/><path d="M19.4 9A8 8 0 0 0 4 12"/>',
  pulso: '<path d="M3 12h4l2 7 4-15 2 8h6"/>',
  alerta: '<path d="M11.1 3.9 2.4 19a1 1 0 0 0 .9 1.5h17.4a1 1 0 0 0 .9-1.5L12.9 3.9a1 1 0 0 0-1.8 0Z"/><path d="M12 9.5v4"/><circle cx="12" cy="16.7" r="0.9" fill="currentColor" stroke="none"/>',
  alvo: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="0.8" fill="currentColor" stroke="none"/>',
  caminhao: '<rect x="1.5" y="6.5" width="12.5" height="10" rx="1.2"/><path d="M14 10h4l3.5 3.3V16.5H14z"/><circle cx="6" cy="19" r="1.7"/><circle cx="17.5" cy="19" r="1.7"/>',
  busca: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M20 20 15 15"/>',
  setaAlvo: '<path d="M17 7 7 17"/><path d="M8 7h9v9"/>',
  engrenagem: '<circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6V21a2 2 0 1 1-4 0v-.2a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.6-1H3a2 2 0 1 1 0-4h.2a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.6V3a2 2 0 1 1 4 0v.2a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.6 1H21a2 2 0 1 1 0 4h-.2a1.7 1.7 0 0 0-1.6 1Z"/>',
  tendencia: '<path d="M3 17 9 11 13 15 21 6"/><path d="M15 6h6v6"/>',
  caixa: '<path d="M3.5 8.2 12 4l8.5 4.2v7.6L12 20l-8.5-4.2z"/><path d="M3.5 8.2 12 12l8.5-3.8"/><path d="M12 12v8"/>'
};
function icone(nome) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONE_PATH[nome]}</svg>`;
}

const ORDEM_SEVERIDADE = ["ok", "atencao", "alerta", "critico"];
function pior(nivelA, nivelB) {
  return ORDEM_SEVERIDADE.indexOf(nivelA) >= ORDEM_SEVERIDADE.indexOf(nivelB) ? nivelA : nivelB;
}

// Combina o "ha quanto tempo" com os erros da propria rodada - uma sincronizacao recente (verde
// pelo horario) ainda pode ter tido varios erros parciais, e isso ficava so visivel no /saude.
function statusSincronizacao(ultimaSync) {
  if (!ultimaSync) return { nivel: "critico", texto: "nunca sincronizou" };
  const horas = (Date.now() - new Date(ultimaSync.data_hora.replace(" ", "T") + "Z").getTime()) / 3600000;
  const textoHoras = horas < 1 ? `há ${Math.round(horas * 60)} min` : `há ${formatarNumero(horas, 1)}h`;

  let nivelHoras;
  if (horas <= 2) nivelHoras = "ok";
  else if (horas <= 6) nivelHoras = "atencao";
  else if (horas <= 24) nivelHoras = "alerta";
  else nivelHoras = "critico";
  const textoFinalHoras = horas > 24 ? `há ${Math.round(horas / 24)}d` : textoHoras;

  let qtdErros = 0;
  try {
    qtdErros = (JSON.parse(ultimaSync.payload_json || "{}").erros || []).length;
  } catch { /* payload malformado - trata como 0 erros, o horario ja cobre o essencial */ }

  let nivelErros = "ok";
  if (qtdErros > 15) nivelErros = "critico";
  else if (qtdErros > 5) nivelErros = "alerta";
  else if (qtdErros > 0) nivelErros = "atencao";

  const nivel = pior(nivelHoras, nivelErros);
  const texto = qtdErros > 0 ? `${textoFinalHoras} · ${qtdErros} erro(s)` : textoFinalHoras;
  return { nivel, texto };
}

function statusIndiceSaude(indice) {
  if (indice === null) return { nivel: "atencao", texto: "sem dado" };
  if (indice >= 85) return { nivel: "ok", texto: "saudável" };
  if (indice >= 70) return { nivel: "atencao", texto: "atenção" };
  if (indice >= 50) return { nivel: "alerta", texto: "alerta" };
  return { nivel: "critico", texto: "crítico" };
}

// Limiares pensados pro tamanho de catalogo tipico deste projeto (dezenas de produtos ativos) -
// 1-2 criticos e' "alerta", 3+ e' "critico" (risco real de ruptura generalizada).
function statusRuptura(criticos, altos) {
  if (criticos === 0 && altos === 0) return { nivel: "ok" };
  if (criticos === 0) return { nivel: "atencao" };
  if (criticos <= 2) return { nivel: "alerta" };
  return { nivel: "critico" };
}

function statusMissoes(contagem) {
  if (contagem.critico > 0) return { nivel: "critico" };
  if (contagem.alto > 0) return { nivel: "alerta" };
  if (contagem.medio > 0 || contagem.baixo > 0) return { nivel: "atencao" };
  return { nivel: "ok" };
}

// Preenche os N dias corridos com 0 onde nao houve venda - sem isso o grafico pularia dias sem dado.
function preencherSerieDiaria(linhas, dias) {
  const porDia = Object.fromEntries((linhas || []).map(l => [l.dia, l.total]));
  const resultado = [];
  for (let i = dias - 1; i >= 0; i--) {
    const chave = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    resultado.push({ dia: chave, total: porDia[chave] || 0 });
  }
  return resultado;
}

function dataCurta(isoDia) {
  const [, mes, dia] = isoDia.split("-");
  return `${dia}/${mes}`;
}

// Grafico de linha em SVG puro, gerado no servidor - sem dependencia externa (CDN, biblioteca de
// grafico) nem JS no cliente, consistente com o resto do projeto (package.json so tem wrangler).
function graficoReceita(pontos) {
  const LARGURA = 760, ALTURA = 190, PAD_X = 4, PAD_TOPO = 16, PAD_BASE = 26;
  const max = Math.max(...pontos.map(p => p.total), 1);
  const passoX = (LARGURA - PAD_X * 2) / Math.max(pontos.length - 1, 1);
  const y = (v) => ALTURA - PAD_BASE - (v / max) * (ALTURA - PAD_TOPO - PAD_BASE);

  const coords = pontos.map((p, i) => [PAD_X + i * passoX, y(p.total)]);
  const linha = coords.map(([cx, cy], i) => `${i === 0 ? "M" : "L"}${cx.toFixed(1)},${cy.toFixed(1)}`).join(" ");
  const area = `${linha} L${coords[coords.length - 1][0].toFixed(1)},${ALTURA - PAD_BASE} L${coords[0][0].toFixed(1)},${ALTURA - PAD_BASE} Z`;
  const [ux, uy] = coords[coords.length - 1];

  return `
  <svg viewBox="0 0 ${LARGURA} ${ALTURA}" class="grafico-receita" preserveAspectRatio="none" role="img" aria-label="Receita liquida diaria, ultimos ${pontos.length} dias">
    <line x1="${PAD_X}" y1="${ALTURA - PAD_BASE}" x2="${LARGURA - PAD_X}" y2="${ALTURA - PAD_BASE}" class="gr-eixo" />
    <path d="${area}" class="gr-area" />
    <path d="${linha}" class="gr-linha" fill="none" />
    <circle cx="${ux.toFixed(1)}" cy="${uy.toFixed(1)}" r="4.5" class="gr-ponto" />
    <text x="${PAD_X}" y="${ALTURA - 6}" class="gr-eixo-label">${dataCurta(pontos[0].dia)}</text>
    <text x="${LARGURA - PAD_X}" y="${ALTURA - 6}" text-anchor="end" class="gr-eixo-label">${dataCurta(pontos[pontos.length - 1].dia)}</text>
  </svg>`;
}

function statCard(nomeIcone, rotulo, valor, sub, nivel) {
  return `
  <div class="stat-card">
    <div class="stat-topo">
      <div class="stat-icone stat-icone-${nivel}">${icone(nomeIcone)}</div>
      <span class="stat-badge stat-badge-${nivel}">${ROTULO_STATUS[nivel]}</span>
    </div>
    <div class="stat-valor">${valor}</div>
    <div class="stat-label">${rotulo}</div>
    <div class="stat-sub">${sub}</div>
  </div>`;
}

// Card de Oportunidade Full: visualmente parecido com os de risco, mas com paleta propria
// (azul, "OPORTUNIDADE") - nunca vermelho/verde, pra nao insinuar que mais oportunidade e' ruim.
function opportunityCard(nomeIcone, rotulo, valor, sub) {
  return `
  <div class="stat-card stat-card-oportunidade">
    <div class="stat-topo">
      <div class="stat-icone stat-icone-oportunidade">${icone(nomeIcone)}</div>
      <span class="stat-badge stat-badge-oportunidade">OPORTUNIDADE</span>
    </div>
    <div class="stat-valor">${valor}</div>
    <div class="stat-label">${rotulo}</div>
    <div class="stat-sub">${sub}</div>
  </div>`;
}

async function renderLoja(env, lojaId, recemConectado) {
  const db = env.DB;

  const loja = await db.prepare("SELECT nickname FROM lojas WHERE loja_id = ?").bind(lojaId).first();

  // Seletor rapido de loja: busca todas as ativas mesmo com so 1 conectada hoje - construido agora
  // pra nao precisar de retrabalho quando a 2a/3a loja entrarem, so passa a ter mais de 1 opcao.
  const todasAsLojas = await db.prepare("SELECT loja_id, nickname FROM lojas WHERE ativo = 1 ORDER BY nickname").all();

  const totalVendido = await db.prepare(
    "SELECT COALESCE(SUM(valor_liquido), 0) as total, COUNT(*) as pedidos FROM vendas WHERE loja_id = ? AND data_hora >= datetime('now', '-30 days')"
  ).bind(lojaId).first();

  const receitaAnterior = await db.prepare(
    "SELECT COALESCE(SUM(valor_liquido), 0) as total, COUNT(*) as pedidos FROM vendas WHERE loja_id = ? AND data_hora >= datetime('now', '-60 days') AND data_hora < datetime('now', '-30 days')"
  ).bind(lojaId).first();
  const variacaoReceita = receitaAnterior.total > 0 ? (totalVendido.total - receitaAnterior.total) / receitaAnterior.total : null;

  // Aviso de transicao do bug de comissao (ver PLANO.md): vendas antes de 01/08/2026 tem
  // valor_liquido == valor_bruto (comissao nao descontada), sem backfill retroativo por decisao do
  // usuario. A janela "30-60 dias atras" so fica 100% livre dessa contaminacao quando "hoje - 60
  // dias" >= 01/08/2026, ou seja, a partir de ~30/09/2026 - antes disso, a comparacao de tendencia
  // pode ficar artificialmente negativa conforme a janela atual for ganhando dias corretamente
  // descontados enquanto a anterior continua 100% inflada. Auto-expira sozinho depois dessa data.
  const FIM_TRANSICAO_COMISSAO = new Date(Date.UTC(2026, 8, 30)); // 30/09/2026 (mes 8 = setembro, zero-indexed)
  const emTransicaoComissao = Date.now() < FIM_TRANSICAO_COMISSAO.getTime();

  const ticketMedioAtual = totalVendido.pedidos > 0 ? totalVendido.total / totalVendido.pedidos : 0;
  const ticketMedioAnterior = receitaAnterior.pedidos > 0 ? receitaAnterior.total / receitaAnterior.pedidos : null;
  const variacaoTicket = ticketMedioAnterior > 0 ? (ticketMedioAtual - ticketMedioAnterior) / ticketMedioAnterior : null;

  // Top produtos (30d) desta loja - mesma pergunta que ja existe no renderOverview (comparando
  // lojas), mas nunca trazida pra dentro do painel de uma loja especifica: "o que esta funcionando,
  // pra eu reforcar?"
  const topProdutosRows = await db.prepare(
    `SELECT p.nome, SUM(v.quantidade) as qtd, SUM(v.valor_liquido) as receita
     FROM vendas v JOIN produtos p ON p.id = v.produto_id
     WHERE v.loja_id = ? AND v.data_hora >= datetime('now', '-30 days')
     GROUP BY v.produto_id ORDER BY receita DESC LIMIT 5`
  ).bind(lojaId).all();
  const topProdutos = topProdutosRows.results || [];

  const vendasDiariasRows = await db.prepare(
    `SELECT date(data_hora) as dia, COALESCE(SUM(valor_liquido), 0) as total
     FROM vendas WHERE loja_id = ? AND data_hora >= datetime('now', '-30 days')
     GROUP BY dia ORDER BY dia`
  ).bind(lojaId).all();
  const serieReceita = preencherSerieDiaria(vendasDiariasRows.results, 30);

  // Catalogo por status - visibilidade simples de quanto do catalogo esta parado (pausado/fechado)
  // vs ativo, informacao que hoje nao aparece em lugar nenhum do painel.
  const produtosPorStatusRows = await db.prepare(
    "SELECT status, COUNT(*) as total FROM produtos WHERE loja_id = ? GROUP BY status"
  ).bind(lojaId).all();
  const contagemStatus = { active: 0, paused: 0, closed: 0, outros: 0 };
  for (const linha of produtosPorStatusRows.results || []) {
    if (linha.status in contagemStatus) contagemStatus[linha.status] = linha.total;
    else contagemStatus.outros += linha.total;
  }

  // Full vs. Fora do Full: quanto do negocio ja migrou pro Full vs. ainda vende fora. Nota: fora do
  // Full so tem valor_bruto (sem desconto de comissao/frete), enquanto a receita Full acima e'
  // valor_liquido - nao e' comparacao perfeita "maca com maca", mas da a ordem de grandeza certa.
  const foraDoFull = await db.prepare(
    "SELECT COALESCE(SUM(valor_bruto), 0) as total, COUNT(DISTINCT pedido_id) as pedidos FROM vendas_fora_full WHERE loja_id = ? AND data_hora >= datetime('now', '-30 days')"
  ).bind(lojaId).first();
  const totalGeralAprox = totalVendido.total + foraDoFull.total;
  const pctFull = totalGeralAprox > 0 ? (totalVendido.total / totalGeralAprox) * 100 : null;

  const ultimaSync = await db.prepare(
    "SELECT data_hora, payload_json FROM eventos WHERE loja_id = ? AND tipo = 'sincronizacao_concluida' ORDER BY data_hora DESC LIMIT 1"
  ).bind(lojaId).first();

  const planejador = await listarPlanejadorEnvios(db, lojaId);
  const itensAtencao = planejador.filter(p => p.prioridade !== "nao_enviar" && p.prioridade !== "sem_dados");
  const itensCriticosCount = planejador.filter(p => p.prioridade === "critico").length;
  const itensAltosCount = planejador.filter(p => p.prioridade === "alto").length;
  const indiceSaude = calcularIndiceSaude(planejador);

  const missoesPorPrioridade = await db.prepare(
    `SELECT prioridade, COUNT(*) as total FROM missoes WHERE loja_id = ? AND status = 'aberta' GROUP BY prioridade`
  ).bind(lojaId).all();
  const contagemMissoes = { critico: 0, alto: 0, medio: 0, baixo: 0 };
  for (const linha of missoesPorPrioridade.results || []) {
    if (linha.prioridade in contagemMissoes) contagemMissoes[linha.prioridade] = linha.total;
  }
  const totalMissoesAbertas = Object.values(contagemMissoes).reduce((a, b) => a + b, 0);

  // Momentum: missoes resolvidas nos ultimos 7 dias - sem isso, o painel so mostra "quanto ainda
  // falta", nunca "quanto ja foi resolvido". Contexto de progresso, nao so de pendencia.
  const missoesResolvidas7d = await db.prepare(
    "SELECT COUNT(*) as total FROM missoes WHERE loja_id = ? AND status = 'resolvida' AND resolvido_em >= datetime('now', '-7 days')"
  ).bind(lojaId).first();

  // Oportunidade Full: quantos anuncios fora do Full ja tem potencial forte comprovado (score >= 60,
  // combinando regularidade + crescimento + estabilidade - ver listarAptosParaFull). E' metrica
  // positiva (mais candidato = melhor), entao NAO usa o semaforo de risco dos outros cards.
  const aptosFull = await listarAptosParaFull(db, lojaId);
  const candidatosFortes = aptosFull.filter(a => a.score >= 60).length;
  const quaseAptos = aptosFull.filter(a => a.score >= 40 && a.score < 60).slice(0, 8);
  const melhorScore = aptosFull.length > 0 ? aptosFull[0].score : null;

  const LABEL_COLETA_FULL = "Custo do serviço de coleta Full";
  const custosColeta = await db.prepare(
    `SELECT periodo, valor FROM custos_transporte WHERE loja_id = ? AND label = ? ORDER BY periodo DESC LIMIT 2`
  ).bind(lojaId, LABEL_COLETA_FULL).all();
  const [custoMesAtual, custoMesAnterior] = custosColeta.results || [];
  const variacaoColeta = custoMesAtual && custoMesAnterior && custoMesAnterior.valor > 0
    ? (custoMesAtual.valor - custoMesAnterior.valor) / custoMesAnterior.valor
    : null;

  const unidadesEnviadasMes = custoMesAtual
    ? await db.prepare(
        `SELECT COALESCE(SUM(quantidade_enviada), 0) as total FROM envios
         WHERE loja_id = ? AND strftime('%Y-%m', data) = ?`
      ).bind(lojaId, custoMesAtual.periodo.slice(0, 7)).first()
    : { total: 0 };
  const custoMedioUnidade = custoMesAtual && unidadesEnviadasMes.total > 0
    ? custoMesAtual.valor / unidadesEnviadasMes.total
    : null;

  const nomeLoja = loja?.nickname || lojaId;

  const sSync = statusSincronizacao(ultimaSync);
  const sSaude = statusIndiceSaude(indiceSaude);
  const sRuptura = statusRuptura(itensCriticosCount, itensAltosCount);
  const sMissoes = statusMissoes(contagemMissoes);

  const banner = recemConectado
    ? `<div class="painel-banner">Conta vinculada com sucesso! Se ainda não tiver dados abaixo, acesse <a href="/sync?loja=${encodeURIComponent(lojaId)}">/sync?loja=${escapeHtml(lojaId)}</a> para sincronizar pela primeira vez.</div>`
    : "";

  const linhasPlanejador = itensAtencao.length ? itensAtencao.slice(0, LIMITE_PLANEJADOR).map(p => `
      <tr>
        <td>${escapeHtml(p.nome)}</td>
        <td>${p.estoqueAtual}</td>
        <td>${formatarNumero(p.mediaDiaria)}</td>
        <td>${p.cobertura === Infinity ? "-" : Math.round(p.cobertura)}</td>
        <td>${p.sugestaoEnvio}</td>
        <td><span class="tag tag-${p.prioridade}">${ROTULO_PRIORIDADE[p.prioridade]}</span></td>
      </tr>`).join("") : '<tr><td colspan="6" class="vazio">Nenhum item precisando de atenção agora — tudo dentro da cobertura-alvo.</td></tr>';

  return `<!doctype html>
<html lang="pt-br">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Painel - ${escapeHtml(nomeLoja)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #080B12; --painel: #0F1320; --painel-2: #131828; --borda: #1c2333; --borda-forte: #2a3348;
    --texto: #E7ECF5; --texto-fraco: #8A93A6; --acento: #2563EB;
    --ok: ${COR_STATUS.ok}; --atencao: ${COR_STATUS.atencao}; --alerta: ${COR_STATUS.alerta}; --critico: ${COR_STATUS.critico};
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--texto); font-family: 'Plus Jakarta Sans', system-ui, sans-serif; }
  a { color: var(--acento); }
  svg { width: 20px; height: 20px; }
  .painel-wrap { max-width: 1180px; margin: 0 auto; padding: 1.75rem 1.5rem 3rem; }
  .topo { display: flex; justify-content: space-between; align-items: flex-end; flex-wrap: wrap; gap: 1rem; margin-bottom: 1.5rem; }
  .marca { font-weight: 800; font-size: 0.95rem; letter-spacing: -0.01em; color: var(--texto); }
  .marca span { color: var(--acento); }
  .eyebrow { font-size: 0.72rem; letter-spacing: 0.12em; color: var(--texto-fraco); text-transform: uppercase; margin: 0.4rem 0 0.3rem; font-weight: 600; }
  .loja-seletor-wrap { position: relative; display: inline-block; }
  .loja-seletor { appearance: none; -webkit-appearance: none; background: transparent; border: none; color: var(--texto); font-family: inherit; font-size: 1.7rem; font-weight: 800; letter-spacing: -0.01em; padding: 0 1.6rem 0 0; cursor: pointer; }
  .loja-seletor:disabled { cursor: default; opacity: 1; -webkit-text-fill-color: var(--texto); }
  .loja-seletor:not(:disabled):hover { color: var(--acento); }
  .loja-seletor-wrap::after { content: ""; position: absolute; right: 0.15rem; top: 50%; width: 9px; height: 9px; border-right: 2px solid var(--texto-fraco); border-bottom: 2px solid var(--texto-fraco); transform: translateY(-70%) rotate(45deg); pointer-events: none; }
  .loja-seletor-wrap:has(select:disabled)::after { display: none; }
  .topo-links { display: flex; gap: 0.6rem; align-items: center; flex-wrap: wrap; }
  .botao { text-decoration: none; font-size: 0.84rem; font-weight: 600; padding: 0.55rem 0.95rem; border-radius: 8px; }
  .botao-fantasma { color: var(--texto-fraco); border: 1.5px solid var(--borda-forte); background: transparent; }
  .botao-fantasma:hover { border-color: var(--texto); color: var(--texto); box-shadow: 0 0 14px rgba(231,236,245,0.15); }
  .botao-primario { background: transparent; color: var(--acento); border: 1.5px solid var(--acento); box-shadow: 0 0 14px rgba(37,99,235,0.4), inset 0 0 10px rgba(37,99,235,0.06); }
  .botao-primario:hover { box-shadow: 0 0 22px rgba(37,99,235,0.65), inset 0 0 12px rgba(37,99,235,0.12); background: rgba(37,99,235,0.06); }
  .busca { display: flex; gap: 0.5rem; }
  .busca input { flex: 1; max-width: 360px; background: var(--painel); border: 1px solid var(--borda-forte); color: var(--texto); padding: 0.6rem 0.9rem; border-radius: 8px; font-family: inherit; font-size: 0.92rem; }
  .busca input::placeholder { color: var(--texto-fraco); }
  .busca button { background: transparent; color: var(--texto); border: 1.5px solid var(--borda-forte); padding: 0.6rem 1.1rem; border-radius: 8px; font-weight: 600; cursor: pointer; font-family: inherit; }
  .busca button:hover { border-color: var(--acento); color: var(--acento); box-shadow: 0 0 14px rgba(37,99,235,0.35); }
  .busca button:hover { border-color: var(--acento); }
  .painel-banner { background: rgba(34,197,94,0.1); border: 1px solid var(--ok); color: #a8f0c6; padding: 0.75rem 1rem; border-radius: 10px; margin-bottom: 1.5rem; font-size: 0.9rem; }

  .luzes { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 0.9rem; margin-bottom: 1.5rem; }
  .stat-card { background: var(--painel); border: 1px solid var(--borda); border-radius: 14px; padding: 1.3rem 1.4rem; }
  .stat-card-oportunidade { border-color: rgba(37,99,235,0.35); }
  .stat-topo { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem; }
  .stat-icone { width: 40px; height: 40px; border-radius: 10px; display: flex; align-items: center; justify-content: center; }
  .stat-icone-ok { background: rgba(34,197,94,0.14); color: var(--ok); }
  .stat-icone-atencao { background: rgba(234,179,8,0.14); color: var(--atencao); }
  .stat-icone-alerta { background: rgba(249,115,22,0.14); color: var(--alerta); }
  .stat-icone-critico { background: rgba(239,68,68,0.14); color: var(--critico); }
  .stat-icone-oportunidade { background: rgba(37,99,235,0.14); color: var(--acento); }
  .stat-badge { font-size: 0.66rem; font-weight: 700; letter-spacing: 0.06em; padding: 0.22rem 0.6rem; border-radius: 999px; }
  .stat-badge-ok { background: rgba(34,197,94,0.14); color: var(--ok); }
  .stat-badge-atencao { background: rgba(234,179,8,0.14); color: var(--atencao); }
  .stat-badge-alerta { background: rgba(249,115,22,0.14); color: var(--alerta); }
  .stat-badge-critico { background: rgba(239,68,68,0.14); color: var(--critico); }
  .stat-badge-oportunidade { background: rgba(37,99,235,0.14); color: var(--acento); }
  .stat-valor { font-size: 1.9rem; font-weight: 800; letter-spacing: -0.01em; }
  .stat-label { font-size: 0.8rem; color: var(--texto-fraco); margin-top: 0.35rem; font-weight: 500; }
  .stat-sub { font-size: 0.76rem; color: var(--texto-fraco); margin-top: 0.15rem; }

  .grade-principal { display: grid; grid-template-columns: 2fr 1fr; gap: 1rem; margin-bottom: 1rem; align-items: start; }
  .painel-box { background: var(--painel); border: 1px solid var(--borda); border-radius: 14px; padding: 1.4rem 1.5rem; }
  .catalogo-box { margin-bottom: 1.5rem; }
  .catalogo-grade { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 1rem; }
  .catalogo-item { text-align: center; padding: 0.9rem 0.5rem; border-radius: 10px; background: var(--painel-2); }
  .catalogo-valor { font-size: 1.7rem; font-weight: 800; }
  .catalogo-label { font-size: 0.8rem; color: var(--texto-fraco); margin-top: 0.2rem; }
  .painel-box h2 { font-size: 0.95rem; color: var(--texto); margin: 0 0 1rem; font-weight: 700; display: flex; align-items: center; gap: 0.5rem; }
  .painel-box h2 svg { color: var(--acento); width: 18px; height: 18px; }
  .receita-topo { display: flex; align-items: baseline; gap: 0.7rem; margin-bottom: 0.9rem; flex-wrap: wrap; }
  .receita-valor { font-size: 2rem; font-weight: 800; letter-spacing: -0.01em; }
  .receita-badge { font-size: 0.8rem; font-weight: 700; padding: 0.22rem 0.65rem; border-radius: 999px; }
  .receita-badge-alta { background: rgba(34,197,94,0.14); color: var(--ok); }
  .receita-badge-baixa { background: rgba(239,68,68,0.14); color: var(--critico); }
  .receita-meta { font-size: 0.82rem; color: var(--texto-fraco); width: 100%; }
  .receita-meta b { color: var(--texto); font-weight: 700; }
  .aviso-dados { display: flex; gap: 0.5rem; align-items: flex-start; background: rgba(234,179,8,0.08); border: 1px solid rgba(234,179,8,0.35); border-radius: 8px; padding: 0.6rem 0.8rem; margin-top: 0.8rem; font-size: 0.76rem; color: var(--texto-fraco); line-height: 1.4; }
  .aviso-dados svg { width: 15px; height: 15px; flex-shrink: 0; color: var(--atencao); margin-top: 0.1rem; }
  .grafico-receita { width: 100%; height: auto; display: block; }
  .gr-eixo { stroke: var(--borda-forte); stroke-width: 1; }
  .gr-area { fill: rgba(37, 99, 235, 0.12); }
  .gr-linha { stroke: var(--acento); stroke-width: 2.4; }
  .gr-ponto { fill: var(--acento); }
  .gr-eixo-label { fill: var(--texto-fraco); font-size: 10px; }

  .transporte-linha { display: flex; justify-content: space-between; align-items: baseline; padding: 0.6rem 0; border-bottom: 1px solid var(--borda); }
  .transporte-linha:last-child { border-bottom: none; }
  .transporte-label { font-size: 0.82rem; color: var(--texto-fraco); }
  .transporte-valor { font-weight: 700; }
  .transporte-nota { font-size: 0.74rem; color: var(--texto-fraco); margin-top: 0.8rem; line-height: 1.4; }
  .up { color: var(--critico); } .down { color: var(--ok); }

  .tabela-box table { width: 100%; border-collapse: collapse; }
  .tabela-box th { text-align: left; font-size: 0.7rem; letter-spacing: 0.06em; text-transform: uppercase; color: var(--texto-fraco); padding: 0.5rem 0.6rem; border-bottom: 1px solid var(--borda-forte); font-weight: 600; }
  .tabela-box td { padding: 0.65rem 0.6rem; border-bottom: 1px solid var(--borda); font-size: 0.88rem; }
  .tabela-box td.vazio { color: var(--texto-fraco); text-align: center; padding: 1.5rem; }
  .tag { display: inline-block; padding: 0.2rem 0.6rem; border-radius: 999px; font-size: 0.7rem; font-weight: 700; }
  .tag-critico { background: rgba(239,68,68,0.14); color: var(--critico); }
  .tag-alto { background: rgba(249,115,22,0.14); color: var(--alerta); }
  .tag-medio { background: rgba(234,179,8,0.14); color: var(--atencao); }

  .atalho { display: inline-flex; align-items: center; gap: 0.4rem; text-decoration: none; padding: 0.5rem 0.85rem; border-radius: 8px; border: 1.5px solid var(--atalho-cor); color: var(--atalho-cor); background: transparent; font-size: 0.82rem; font-weight: 600; box-shadow: 0 0 10px color-mix(in srgb, var(--atalho-cor) 25%, transparent); transition: box-shadow 0.12s ease, transform 0.12s ease; }
  .atalho svg { width: 16px; height: 16px; }
  .atalho:hover { transform: translateY(-1px); box-shadow: 0 0 18px color-mix(in srgb, var(--atalho-cor) 50%, transparent); }
  .atalho-missoes { --atalho-cor: var(--alerta); }
  .atalho-pesquisa { --atalho-cor: var(--acento); }
  .atalho-aptos { --atalho-cor: var(--ok); }
  .atalho-saude { --atalho-cor: #a78bfa; }
  .busca-linha { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 0.8rem; margin-bottom: 1.75rem; }
  .atalhos-linha { display: flex; gap: 0.6rem; flex-wrap: wrap; }

  @media (max-width: 860px) {
    .luzes { grid-template-columns: repeat(2, 1fr); }
    .grade-principal { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>
<div class="painel-wrap">
  <div class="topo">
    <div>
      <p class="marca">Nastripack<span>.</span></p>
      <p class="eyebrow">Painel · Mercado Livre Full</p>
      <div class="loja-seletor-wrap">
        <select class="loja-seletor" onchange="if(this.value)location.href='/?loja='+encodeURIComponent(this.value)" ${todasAsLojas.results.length <= 1 ? "disabled" : ""}>
          ${todasAsLojas.results.map(l => `<option value="${escapeHtml(l.loja_id)}" ${l.loja_id === lojaId ? "selected" : ""}>${escapeHtml(l.nickname)}</option>`).join("")}
        </select>
      </div>
    </div>
    <div class="topo-links">
      <a class="botao botao-fantasma" href="/?ver_todas=1">Ver todas as lojas</a>
      <a class="botao botao-fantasma" href="/auth/login">+ Nova Loja</a>
      <a class="botao botao-primario" href="/sync?loja=${encodeURIComponent(lojaId)}">Sincronizar agora</a>
    </div>
  </div>

  ${banner}

  <div class="busca-linha">
    <form class="busca" method="GET" action="/pesquisa">
      <input type="hidden" name="loja" value="${escapeHtml(lojaId)}">
      <input type="text" name="q" placeholder="Buscar por SKU, MLB ou nome...">
      <button type="submit">Buscar</button>
    </form>
    <div class="atalhos-linha">
      <a class="atalho atalho-missoes" href="/missoes?loja=${encodeURIComponent(lojaId)}">${icone("alvo")} Missões</a>
      <a class="atalho atalho-pesquisa" href="/pesquisa?loja=${encodeURIComponent(lojaId)}">${icone("busca")} Pesquisa</a>
      <a class="atalho atalho-aptos" href="/aptos-full?loja=${encodeURIComponent(lojaId)}">${icone("setaAlvo")} Aptos Full</a>
      <a class="atalho atalho-saude" href="/saude">${icone("engrenagem")} Saúde</a>
    </div>
  </div>

  <div class="luzes">
    ${statCard("sync", "Sincronização", ROTULO_STATUS[sSync.nivel], sSync.texto, sSync.nivel)}
    ${statCard("pulso", "Índice de Saúde", indiceSaude === null ? "-" : `${indiceSaude}%`, sSaude.texto, sSaude.nivel)}
    ${statCard("alerta", "Risco de Ruptura", `${itensCriticosCount + itensAltosCount}`, `${itensCriticosCount} crítico(s) · ${itensAltosCount} alto(s)`, sRuptura.nivel)}
    ${statCard("alvo", "Missões Abertas", `${totalMissoesAbertas}`, totalMissoesAbertas === 0 ? "operação sob controle" : `${contagemMissoes.critico} crítica(s) · ${contagemMissoes.alto} alta(s) · ${missoesResolvidas7d.total} resolvida(s)/7d`, sMissoes.nivel)}
    ${opportunityCard("tendencia", "Oportunidade Full", `${candidatosFortes}`, melhorScore === null ? "nenhum candidato ainda" : `${aptosFull.length} candidato(s) · melhor score ${melhorScore}`)}
  </div>

  <div class="grade-principal">
    <div class="painel-box">
      <h2>${icone("tendencia")} Receita — últimos 30 dias</h2>
      <div class="receita-topo">
        <div class="receita-valor">${formatarMoeda(totalVendido.total)}</div>
        ${variacaoReceita !== null ? `<span class="receita-badge ${variacaoReceita >= 0 ? "receita-badge-alta" : "receita-badge-baixa"}">${variacaoReceita >= 0 ? "+" : ""}${formatarNumero(variacaoReceita * 100, 1)}% vs. 30d anteriores</span>` : ""}
        <div class="receita-meta">${totalVendido.pedidos} pedido(s) · ticket médio <b>${formatarMoeda(ticketMedioAtual)}</b>${variacaoTicket !== null ? ` <span class="receita-badge ${variacaoTicket >= 0 ? "receita-badge-alta" : "receita-badge-baixa"}" style="font-size:0.7rem;">${variacaoTicket >= 0 ? "+" : ""}${formatarNumero(variacaoTicket * 100, 1)}%</span>` : ""}</div>
      </div>
      ${graficoReceita(serieReceita)}
      ${emTransicaoComissao ? `<div class="aviso-dados">${icone("alerta")}<span>Vendas antes de 01/08/2026 ainda não têm a comissão do Mercado Livre descontada (bug histórico corrigido nessa data, sem reprocessamento retroativo). A comparação com o período anterior pode ficar distorcida até ~30/09/2026, enquanto a janela de 60 dias inclui dado dos dois lados da correção.</span></div>` : ""}
    </div>
    <div class="painel-box">
      <h2>${icone("caminhao")} Transporte</h2>
      <div class="transporte-linha">
        <span class="transporte-label">Coleta Full — ${custoMesAtual ? custoMesAtual.periodo.slice(0, 7) : "mês atual"}</span>
        <span class="transporte-valor">${formatarMoeda(custoMesAtual ? custoMesAtual.valor : 0)}</span>
      </div>
      <div class="transporte-linha">
        <span class="transporte-label">Variação vs. mês anterior</span>
        <span class="transporte-valor ${variacaoColeta > 0 ? "up" : variacaoColeta < 0 ? "down" : ""}">${variacaoColeta === null ? "-" : `${variacaoColeta > 0 ? "+" : ""}${formatarNumero(variacaoColeta * 100, 1)}%`}</span>
      </div>
      <div class="transporte-linha">
        <span class="transporte-label">Custo médio / unidade</span>
        <span class="transporte-valor">${custoMedioUnidade === null ? "-" : formatarMoeda(custoMedioUnidade)}</span>
      </div>
      <p class="transporte-nota">Total mensal via API de Faturamento do Mercado Livre — sem detalhamento por remessa individual disponível.</p>
    </div>
  </div>

  ${topProdutos.length > 0 ? `
  <div class="painel-box tabela-box catalogo-box">
    <h2>${icone("tendencia")} Top 5 produtos — últimos 30 dias</h2>
    <table>
      <thead><tr><th>#</th><th>Produto</th><th>Qtd. vendida</th><th>Receita líquida</th></tr></thead>
      <tbody>${topProdutos.map((p, i) => `
        <tr>
          <td>${i + 1}</td>
          <td>${escapeHtml(p.nome)}</td>
          <td>${p.qtd}</td>
          <td>${formatarMoeda(p.receita)}</td>
        </tr>`).join("")}</tbody>
    </table>
  </div>` : ""}

  <div class="painel-box catalogo-box">
    <h2>${icone("caixa")} Catálogo</h2>
    <div class="catalogo-grade">
      <div class="catalogo-item">
        <div class="catalogo-valor">${contagemStatus.active}</div>
        <div class="catalogo-label">Ativos</div>
      </div>
      <div class="catalogo-item">
        <div class="catalogo-valor">${contagemStatus.paused}</div>
        <div class="catalogo-label">Pausados</div>
      </div>
      <div class="catalogo-item">
        <div class="catalogo-valor">${contagemStatus.closed}</div>
        <div class="catalogo-label">Fechados</div>
      </div>
      ${contagemStatus.outros > 0 ? `<div class="catalogo-item"><div class="catalogo-valor">${contagemStatus.outros}</div><div class="catalogo-label">Outros status</div></div>` : ""}
    </div>
  </div>

  <div class="painel-box catalogo-box">
    <h2>${icone("tendencia")} Full vs. Fora do Full — últimos 30 dias</h2>
    <div class="catalogo-grade">
      <div class="catalogo-item">
        <div class="catalogo-valor">${pctFull === null ? "-" : `${formatarNumero(pctFull, 0)}%`}</div>
        <div class="catalogo-label">Receita vindo do Full</div>
      </div>
      <div class="catalogo-item">
        <div class="catalogo-valor">${formatarMoeda(totalVendido.total)}</div>
        <div class="catalogo-label">Full (líquido)</div>
      </div>
      <div class="catalogo-item">
        <div class="catalogo-valor">${formatarMoeda(foraDoFull.total)}</div>
        <div class="catalogo-label">Fora do Full (bruto)</div>
      </div>
    </div>
    <p class="transporte-nota">Comparação aproximada: receita Full já é líquida (descontadas comissão/frete), fora do Full é valor bruto — não há detalhamento de taxas pra vendas fora do Full via API.</p>
  </div>

  ${quaseAptos.length > 0 ? `
  <div class="painel-box catalogo-box tabela-box">
    <h2>${icone("tendencia")} Quase aptos para o Full — candidatos em crescimento (score 40-59)</h2>
    <table>
      <thead><tr><th>Produto</th><th>Score</th><th>Regularidade</th><th>Vendas 30d</th></tr></thead>
      <tbody>${quaseAptos.map(a => `
        <tr>
          <td>${escapeHtml(a.titulo)}</td>
          <td>${a.score}</td>
          <td>${a.regularidade}%</td>
          <td>${a.vendas30}</td>
        </tr>`).join("")}</tbody>
    </table>
    <p class="transporte-nota">Ainda não entram na Central de Missões (score abaixo de 60) — vale observar se continuam subindo antes de decidir migrar pro Full.</p>
  </div>` : ""}

  <div class="painel-box tabela-box">
    <h2>Planejador — itens que precisam de decisão agora</h2>
    <table>
      <thead><tr><th>Produto</th><th>Estoque</th><th>Média/dia</th><th>Cobertura</th><th>Sugestão</th><th>Prioridade</th></tr></thead>
      <tbody>${linhasPlanejador}</tbody>
    </table>
    ${itensAtencao.length > LIMITE_PLANEJADOR ? `<p class="transporte-nota">Mostrando os ${LIMITE_PLANEJADOR} mais urgentes de ${itensAtencao.length}. <a href="/missoes?loja=${encodeURIComponent(lojaId)}">Ver todos na Central de Missões</a>.</p>` : ""}
  </div>

</div>
</body>
</html>`;
}

export async function handleDashboard(request, env) {
  const url = new URL(request.url);
  let lojaId = url.searchParams.get("loja");
  const recemConectado = url.searchParams.get("recem_conectado") === "1";

  // Com uma unica loja ativa, pula a tela de "escolha a loja" e vai direto pro painel - hoje so
  // a A2 Plasticos esta conectada, entao "/" sempre deveria abrir o painel de comando direto.
  // ?ver_todas=1 e' o escape hatch pro link "Ver todas as lojas" do proprio painel - sem ele, esse
  // link ficaria preso num redirecionamento circular de volta pro mesmo painel.
  if (!lojaId && url.searchParams.get("ver_todas") !== "1") {
    const lojasAtivas = await env.DB.prepare("SELECT loja_id FROM lojas WHERE ativo = 1").all();
    const lista = lojasAtivas.results || [];
    if (lista.length === 1) {
      return Response.redirect(`${url.origin}/?loja=${encodeURIComponent(lista[0].loja_id)}`, 302);
    }
  }

  const html = lojaId ? await renderLoja(env, lojaId, recemConectado) : await renderOverview(env);

  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}
