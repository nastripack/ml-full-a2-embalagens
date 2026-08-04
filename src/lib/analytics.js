// Motor Analitico (PRS secao 8): fonte unica de indicadores. So le do banco historico (D1),
// nunca chama a API do Mercado Livre diretamente - mantem a camada de Integracao isolada (secao 6).

const COBERTURA_ALVO_DIAS = 30; // RB-001

function somaJanela(linhasDiaAtras, min, max) {
  return linhasDiaAtras
    .filter(l => l.dias_atras >= min && l.dias_atras < max)
    .reduce((soma, l) => soma + l.qtd, 0);
}

// Pesos da secao 8.2 do PRS: 7d=40%, 15d=30%, 30d=20%, 31-60d=10%.
export function mediaDiariaPonderada(linhasDiaAtras) {
  const media7 = somaJanela(linhasDiaAtras, 0, 7) / 7;
  const media15 = somaJanela(linhasDiaAtras, 0, 15) / 15;
  const media30 = somaJanela(linhasDiaAtras, 0, 30) / 30;
  const media31a60 = somaJanela(linhasDiaAtras, 30, 60) / 30;
  return 0.4 * media7 + 0.3 * media15 + 0.2 * media30 + 0.1 * media31a60;
}

// Agrupa em semanas (0-6, 7-13, ..., 49-55 dias atras) para suavizar o "zero-inflation"
// diario tipico de baixo volume, antes de medir volatilidade.
function totaisSemanais(linhasDiaAtras, numSemanas = 8) {
  const semanas = new Array(numSemanas).fill(0);
  for (const l of linhasDiaAtras) {
    const idx = Math.floor(l.dias_atras / 7);
    if (idx >= 0 && idx < numSemanas) semanas[idx] += l.qtd;
  }
  return semanas;
}

function coeficienteVariacao(valores) {
  const media = valores.reduce((a, b) => a + b, 0) / valores.length;
  if (media === 0) return 0;
  const variancia = valores.reduce((s, v) => s + (v - media) ** 2, 0) / valores.length;
  return Math.sqrt(variancia) / media;
}

// 4 estados da secao 8.1 do PRS: crescimento / estavel / desaceleracao / volatil.
export function classificarTendencia(linhasDiaAtras) {
  const media7 = somaJanela(linhasDiaAtras, 0, 7) / 7;
  const media30 = somaJanela(linhasDiaAtras, 0, 30) / 30;
  if (media7 === 0 && media30 === 0) return "sem_dados";

  // Variabilidade semana a semana (56 dias) tem prioridade sobre a direcao da tendencia:
  // um produto com vendas oscilando muito nao esta "estavel" mesmo que a media geral nao mude.
  const cv = coeficienteVariacao(totaisSemanais(linhasDiaAtras));
  if (cv > 1) return "volatil";

  if (media30 === 0) return "crescimento";
  const variacao = (media7 - media30) / media30;
  if (variacao > 0.2) return "crescimento";
  if (variacao < -0.2) return "desaceleracao";
  return "estavel";
}

export function coberturaEmDias(estoqueAtual, mediaDiaria) {
  if (estoqueAtual === null || estoqueAtual === undefined) return null;
  // Sem demanda (media diaria zero ou negativa): nao ha velocidade de consumo, entao a cobertura
  // e efetivamente infinita, independente do estoque estar zerado ou nao - nao ha urgencia de envio
  // para um produto que nao esta vendendo.
  if (mediaDiaria <= 0) return Infinity;
  return estoqueAtual / mediaDiaria;
}

// RB-002 (ruptura < 15 dias) e RB-003 (armazenagem > 30 dias) definem os limites das faixas.
export function classificarPrioridade(cobertura) {
  if (cobertura === null || cobertura === undefined) return "sem_dados";
  if (cobertura === Infinity) return "nao_enviar"; // tem estoque parado, sem saida
  if (cobertura < 7) return "critico";
  if (cobertura < 15) return "alto";
  if (cobertura < COBERTURA_ALVO_DIAS) return "medio";
  return "nao_enviar";
}

// RB-001: quantidade para atingir a cobertura-alvo de 30 dias.
export function sugerirQuantidadeEnvio(estoqueAtual, mediaDiaria, coberturaAlvoDias = COBERTURA_ALVO_DIAS) {
  if (mediaDiaria <= 0) return 0;
  const sugestao = Math.round(mediaDiaria * coberturaAlvoDias - (estoqueAtual ?? 0));
  return Math.max(0, sugestao);
}

export function projetarVendas(mediaDiaria, horizonteDias) {
  return Math.round(mediaDiaria * horizonteDias);
}

// Nivel de confianca simples: baseado em quantos dos ultimos 30 dias tiveram venda registrada.
export function calcularNivelConfianca(linhasDiaAtras) {
  const diasComVenda = new Set(linhasDiaAtras.filter(l => l.dias_atras < 30 && l.qtd > 0).map(l => l.dias_atras)).size;
  const proporcao = diasComVenda / 30;
  if (proporcao >= 0.5) return "alta";
  if (proporcao >= 0.2) return "media";
  return "baixa";
}

const RANK_PRIORIDADE = { critico: 0, alto: 1, medio: 2, sem_dados: 3, nao_enviar: 4 };

// Indice de saude da operacao (secao 8, "Indice de saude da operacao"): 100 menos a proporcao de
// produtos em risco real (ruptura ou armazenagem com demanda de verdade). Produtos sem demanda
// (cobertura infinita, "nao_enviar" por falta de giro) nao contam contra a saude - nao sao um
// problema, so nao precisam de envio. Produtos "sem_dados" (sem estoque sincronizado) ficam de fora
// da base de calculo, por nao termos indicador confiavel pra eles ainda.
export function calcularIndiceSaude(planejador) {
  const relevantes = planejador.filter(p => p.prioridade !== "sem_dados");
  if (relevantes.length === 0) return null;

  const emRisco = relevantes.filter(p =>
    p.prioridade === "critico" || p.prioridade === "alto" ||
    (p.prioridade === "nao_enviar" && p.cobertura !== Infinity)
  ).length;

  return Math.round(100 * (1 - emRisco / relevantes.length));
}

// Monta a lista do Planejador Inteligente de Envios (secao 12.4) para todos os produtos Full de uma loja.
// So considera anuncios "active": um anuncio pausado ou fechado nao pode ser vendido agora, entao
// recomendar "enviar X unidades" ou qualquer acao de reposicao/armazenagem pra ele nao faz sentido
// pratico - achado real na auditoria (51 de 95 produtos nao ativos, 2 fechados ja geravam missao).
export async function listarPlanejadorEnvios(db, lojaId) {
  const produtos = await db.prepare("SELECT id, mlb, nome FROM produtos WHERE loja_id = ? AND status = 'active'").bind(lojaId).all();

  const vendasRows = await db.prepare(
    `SELECT produto_id, CAST(julianday('now') - julianday(data_hora) AS INTEGER) as dias_atras, SUM(quantidade) as qtd
     FROM vendas
     WHERE loja_id = ? AND data_hora >= datetime('now', '-60 days')
     GROUP BY produto_id, dias_atras`
  ).bind(lojaId).all();

  const vendasPorProduto = {};
  for (const linha of vendasRows.results || []) {
    if (!vendasPorProduto[linha.produto_id]) vendasPorProduto[linha.produto_id] = [];
    vendasPorProduto[linha.produto_id].push(linha);
  }

  const estoqueRows = await db.prepare(
    `SELECT e.produto_id, e.estoque_full
     FROM estoque_historico e
     INNER JOIN (
       SELECT produto_id, MAX(data_hora) as ultima FROM estoque_historico WHERE loja_id = ? GROUP BY produto_id
     ) m ON m.produto_id = e.produto_id AND m.ultima = e.data_hora`
  ).bind(lojaId).all();

  const estoquePorProduto = {};
  for (const linha of estoqueRows.results || []) {
    estoquePorProduto[linha.produto_id] = linha.estoque_full;
  }

  const resultado = [];
  for (const produto of produtos.results || []) {
    const linhas = vendasPorProduto[produto.id] || [];
    const estoqueAtual = estoquePorProduto[produto.id];
    if (estoqueAtual === undefined) continue; // estoque ainda nao sincronizado pra esse produto

    const mediaDiaria = mediaDiariaPonderada(linhas);
    const cobertura = coberturaEmDias(estoqueAtual, mediaDiaria);
    const prioridade = classificarPrioridade(cobertura);

    resultado.push({
      produtoId: produto.id,
      mlb: produto.mlb,
      nome: produto.nome,
      estoqueAtual,
      mediaDiaria,
      cobertura,
      tendencia: classificarTendencia(linhas),
      prioridade,
      sugestaoEnvio: sugerirQuantidadeEnvio(estoqueAtual, mediaDiaria),
      projecoes: {
        d7: projetarVendas(mediaDiaria, 7),
        d15: projetarVendas(mediaDiaria, 15),
        d30: projetarVendas(mediaDiaria, 30),
        d60: projetarVendas(mediaDiaria, 60)
      },
      confianca: calcularNivelConfianca(linhas)
    });
  }

  // Desempate por cobertura dentro da mesma prioridade: entre dois itens igualmente criticos, quem
  // tem menos dias de estoque rompe primeiro e precisa aparecer no topo. Sem isso a ordem entre eles
  // era a da consulta ao banco, ou seja, arbitraria.
  resultado.sort((a, b) => {
    const porPrioridade = RANK_PRIORIDADE[a.prioridade] - RANK_PRIORIDADE[b.prioridade];
    if (porPrioridade !== 0) return porPrioridade;
    const coberturaA = a.cobertura === null || a.cobertura === undefined ? Infinity : a.cobertura;
    const coberturaB = b.cobertura === null || b.cobertura === undefined ? Infinity : b.cobertura;
    if (coberturaA === coberturaB) return 0; // evita Infinity - Infinity = NaN no comparador
    return coberturaA - coberturaB;
  });
  return resultado;
}

// Aptos para o Full (PRS secao 12.8): anuncios fora do Full com potencial comprovado de migracao,
// a partir de vendas_fora_full (populada pelo sync/backfill quando um order_item nao bate com
// nenhum produto do Full). Score 0-100 combina regularidade, crescimento e estabilidade -
// mesma logica de tendencia/volatilidade ja usada no Planejador, aplicada aqui por MLB.
export async function listarAptosParaFull(db, lojaId) {
  const rows = await db.prepare(
    `SELECT mlb, titulo, CAST(julianday('now') - julianday(data_hora) AS INTEGER) as dias_atras, SUM(quantidade) as qtd
     FROM vendas_fora_full
     WHERE loja_id = ? AND data_hora >= datetime('now', '-90 days')
     GROUP BY mlb, dias_atras`
  ).bind(lojaId).all();

  const porMlb = {};
  for (const linha of rows.results || []) {
    if (!porMlb[linha.mlb]) porMlb[linha.mlb] = { titulo: linha.titulo, linhas: [] };
    if (linha.titulo && !porMlb[linha.mlb].titulo) porMlb[linha.mlb].titulo = linha.titulo;
    porMlb[linha.mlb].linhas.push(linha);
  }

  const resultado = [];
  for (const [mlb, dados] of Object.entries(porMlb)) {
    const linhas = dados.linhas;
    const vendas30 = somaJanela(linhas, 0, 30);
    const vendas60 = somaJanela(linhas, 0, 60);
    const vendas90 = somaJanela(linhas, 0, 90);
    const vendas31a60 = somaJanela(linhas, 30, 60);

    // Sem venda nos ultimos 60 dias: nao ha potencial comprovado de verdade, so uma venda isolada
    // e antiga. Sem isso, cv=0 (sem dado) e' lido como "estabilidade maxima", inflando o score
    // artificialmente - mesmo tipo de bug de "zero-inflation" ja corrigido no Planejador (Fase 2).
    if (vendas60 === 0) continue;

    // Regularidade: proporcao de dias com venda nos ultimos 30 dias.
    const diasComVenda30 = new Set(linhas.filter(l => l.dias_atras < 30 && l.qtd > 0).map(l => l.dias_atras)).size;
    const regularidade = diasComVenda30 / 30;

    // Crescimento: janela recente (30d) vs anterior (31-60d), normalizado pra 0-1 (crescimento >= 100% satura em 1).
    const crescimento = vendas31a60 > 0 ? (vendas30 - vendas31a60) / vendas31a60 : (vendas30 > 0 ? 1 : 0);
    const crescimentoNormalizado = Math.max(0, Math.min(1, (crescimento + 1) / 2));

    // Estabilidade: inverso do coeficiente de variacao semanal (mesmo metodo de classificarTendencia).
    const cv = coeficienteVariacao(totaisSemanais(linhas, 8));
    const estabilidade = Math.max(0, 1 - Math.min(cv, 1));

    const score = Math.round(100 * (0.4 * regularidade + 0.3 * crescimentoNormalizado + 0.3 * estabilidade));
    const mediaDiaria30 = vendas30 / 30;
    const sugestaoInicial = Math.round(mediaDiaria30 * COBERTURA_ALVO_DIAS);

    resultado.push({
      mlb,
      titulo: dados.titulo || mlb,
      vendas30,
      vendas60,
      vendas90,
      regularidade: Math.round(regularidade * 100),
      score,
      sugestaoInicial
    });
  }

  resultado.sort((a, b) => b.score - a.score);
  return resultado;
}
