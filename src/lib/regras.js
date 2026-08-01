// Motor de Regras (PRS secao 9): centraliza limiares e politicas, interpreta os indicadores
// que ja vem prontos do Motor Analitico (analytics.js) e gera missoes. Nao calcula tendencia
// nem indicador nenhum - so aplica regras sobre o que ja foi calculado.
//
// A "camada de IA" (secao 10) e o texto das missoes abaixo: gerado por template a partir de
// numeros reais, nao por chamada a um LLM (decisao do usuario) - ainda assim satisfaz a regra
// da secao 10.2 de nunca consultar a API do Mercado Livre diretamente, porque nem existe como
// camada separada aqui.

import { listarPlanejadorEnvios } from "./analytics.js";

const QUEDA_VALOR_LIQUIDO_ALERTA = 0.10; // RB-004: queda >= 10% no liquido por unidade
// Vendas registradas antes desta data tem comissao zerada (bug corrigido em 01/08/2026, ver README) -
// excluidas da comparacao de valor liquido para nao gerar falso alerta de "queda de preco".
const DATA_CORTE_COMISSAO = "2026-08-01";

function arredonda(n, casas = 2) {
  return Math.round(n * 10 ** casas) / 10 ** casas;
}

function textoTendencia(tendencia) {
  return {
    crescimento: "tendência de crescimento",
    estavel: "tendência estável",
    desaceleracao: "tendência de desaceleração",
    volatil: "vendas voláteis",
    sem_dados: "sem histórico suficiente"
  }[tendencia] || tendencia;
}

// Monta as missoes "atuais" (o que deveria estar aberto agora) a partir do Planejador -
// nao grava nada ainda, so decide o que e verdade neste momento.
function situacoesAtuais(planejador) {
  const situacoes = [];

  for (const p of planejador) {
    // Produto com demanda quase nula (ex: 1 venda em 60 dias) e estoque zerado calcula cobertura
    // baixa e cai em "critico"/"alto", mas a quantidade sugerida arredonda pra 0 - nao ha reposicao
    // de verdade a fazer aqui, entao nao vira missao (uma missao sem acao real nao e uma missao).
    if ((p.prioridade === "critico" || p.prioridade === "alto") && p.sugestaoEnvio === 0) continue;

    if (p.prioridade === "critico" || p.prioridade === "alto") {
      // RB-002 / RB-010: ruptura ou reposicao prioritaria (a mesma missao cobre os dois -
      // cobertura baixa e' a situacao, crescimento so reforca a prioridade que ja vem do Planejador).
      situacoes.push({
        produtoId: p.produtoId,
        tipo: "reposicao",
        prioridade: p.prioridade,
        situacao: `${p.nome}: cobertura de ${Math.round(p.cobertura)} dias, ${textoTendencia(p.tendencia)}. Risco de ruptura.`,
        motivo: `Média diária de ${arredonda(p.mediaDiaria)} un/dia com estoque atual de ${p.estoqueAtual} un cobre só ${Math.round(p.cobertura)} dias (alvo: 30 dias).`,
        impacto: `Enviar ${p.sugestaoEnvio} unidades para recompor a cobertura-alvo de 30 dias.`
      });
    } else if (p.prioridade === "nao_enviar" && p.cobertura !== Infinity) {
      // RB-003: armazenagem - tem demanda real, mas estoque de sobra.
      situacoes.push({
        produtoId: p.produtoId,
        tipo: "armazenagem",
        prioridade: "medio",
        situacao: `${p.nome}: estoque parado, cobertura de ${Math.round(p.cobertura)} dias (acima do alvo de 30).`,
        motivo: `Estoque atual de ${p.estoqueAtual} unidades, no ritmo de vendas atual (${arredonda(p.mediaDiaria)} un/dia), vai durar ${Math.round(p.cobertura)} dias.`,
        impacto: "Considerar pausar novos envios deste produto até a cobertura normalizar."
      });
    } else if (p.prioridade === "nao_enviar" && p.cobertura === Infinity && p.estoqueAtual > 0) {
      // RB-009: sem giro relevante, mas com estoque parado no Full (custo de armazenagem sem retorno).
      situacoes.push({
        produtoId: p.produtoId,
        tipo: "baixa_relevancia",
        prioridade: "baixo",
        situacao: `${p.nome}: sem vendas registradas nos últimos 60 dias, com ${p.estoqueAtual} unidades paradas no Full.`,
        motivo: "Produto sem giro no período analisado.",
        impacto: "Revisar relevância do anúncio (preço, imagens, concorrência) ou considerar remover do Full."
      });
    }
  }

  return situacoes;
}

// RB-004: queda relevante de valor liquido por unidade (7 dias recentes vs 31-60 dias atras).
async function situacoesPrecificacao(db, lojaId, produtosPorId) {
  const rows = await db.prepare(
    `SELECT produto_id,
            AVG(CASE WHEN dias_atras < 7 THEN valor_liquido * 1.0 / quantidade END) as recente,
            AVG(CASE WHEN dias_atras BETWEEN 31 AND 60 THEN valor_liquido * 1.0 / quantidade END) as anterior
     FROM (
       SELECT produto_id, valor_liquido, quantidade,
              CAST(julianday('now') - julianday(data_hora) AS INTEGER) as dias_atras
       FROM vendas
       WHERE loja_id = ? AND data_hora >= datetime('now', '-60 days') AND data_hora >= ? AND quantidade > 0
     )
     GROUP BY produto_id`
  ).bind(lojaId, DATA_CORTE_COMISSAO).all();

  const situacoes = [];
  for (const row of rows.results || []) {
    if (!row.recente || !row.anterior || row.anterior <= 0) continue; // dados insuficientes de um dos dois lados
    const queda = (row.anterior - row.recente) / row.anterior;
    if (queda < QUEDA_VALOR_LIQUIDO_ALERTA) continue;

    const produto = produtosPorId[row.produto_id];
    const nome = produto?.nome || `produto ${row.produto_id}`;
    situacoes.push({
      produtoId: row.produto_id,
      tipo: "precificacao",
      prioridade: "alto",
      situacao: `${nome}: valor líquido por unidade caiu ${arredonda(queda * 100)}% nos últimos 7 dias frente à média de 31-60 dias atrás.`,
      motivo: `Líquido médio recente de R$ ${arredonda(row.recente)} contra R$ ${arredonda(row.anterior)} anteriormente.`,
      impacto: "Verificar se houve mudança de tarifa/comissão do Mercado Livre ou se é necessário reajustar o preço."
    });
  }
  return situacoes;
}

export async function gerarMissoes(db, lojaId) {
  const planejador = await listarPlanejadorEnvios(db, lojaId);
  const produtosPorId = Object.fromEntries(planejador.map(p => [p.produtoId, p]));

  const situacoes = [
    ...situacoesAtuais(planejador),
    ...await situacoesPrecificacao(db, lojaId, produtosPorId)
  ];

  // Conta por diferenca antes/depois em vez de confiar em resultado.meta.changes do INSERT OR IGNORE,
  // que nao reflete de forma confiavel quando a linha e ignorada pelo indice unico parcial.
  const antes = await db.prepare("SELECT COUNT(*) as n FROM missoes WHERE loja_id = ? AND status = 'aberta'").bind(lojaId).first();

  for (const s of situacoes) {
    await db.prepare(
      `INSERT OR IGNORE INTO missoes (loja_id, produto_id, tipo, prioridade, situacao, motivo, impacto_estimado)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(lojaId, s.produtoId, s.tipo, s.prioridade, s.situacao, s.motivo, s.impacto).run();
  }

  const depois = await db.prepare("SELECT COUNT(*) as n FROM missoes WHERE loja_id = ? AND status = 'aberta'").bind(lojaId).first();
  const criadas = depois.n - antes.n;

  // Auto-resolve: missoes abertas cuja situacao nao esta mais na lista atual.
  const chavesAtuais = new Set(situacoes.map(s => `${s.produtoId}:${s.tipo}`));
  const abertas = await db.prepare(
    "SELECT id, produto_id, tipo FROM missoes WHERE loja_id = ? AND status = 'aberta'"
  ).bind(lojaId).all();

  let resolvidas = 0;
  for (const m of abertas.results || []) {
    if (!chavesAtuais.has(`${m.produto_id}:${m.tipo}`)) {
      await db.prepare(
        "UPDATE missoes SET status = 'resolvida', resolvido_em = datetime('now') WHERE id = ?"
      ).bind(m.id).run();
      resolvidas++;
    }
  }

  return { missoes_criadas: criadas, missoes_resolvidas: resolvidas, situacoes_ativas: situacoes.length };
}
