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

export function classificarTendencia(linhasDiaAtras) {
  const media7 = somaJanela(linhasDiaAtras, 0, 7) / 7;
  const media30 = somaJanela(linhasDiaAtras, 0, 30) / 30;
  if (media7 === 0 && media30 === 0) return "sem_dados";
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

// Monta a lista do Planejador Inteligente de Envios (secao 12.4) para todos os produtos Full de uma loja.
export async function listarPlanejadorEnvios(db, lojaId) {
  const produtos = await db.prepare("SELECT id, mlb, nome FROM produtos WHERE loja_id = ?").bind(lojaId).all();

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
      projecao30Dias: projetarVendas(mediaDiaria, 30),
      confianca: calcularNivelConfianca(linhas)
    });
  }

  resultado.sort((a, b) => RANK_PRIORIDADE[a.prioridade] - RANK_PRIORIDADE[b.prioridade]);
  return resultado;
}
