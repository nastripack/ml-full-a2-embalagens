import {
  getValidAccessToken, getItemsMultiget, searchUserItems, getOrdersSearch,
  getStockFulfillment, getInboundReceptions, getItemVisits, getBillingPeriods, getBillingSummary
} from "../lib/mercadolivre.js";
import { upsertProduto, inserirVenda, inserirVendaForaFull, inserirEstoque, inserirEnvio, inserirPerformance, registrarEvento, upsertCustoTransporte } from "../lib/db.js";
import { gerarMissoes } from "../lib/regras.js";

// Janela curta e rapida para o sync de rotina (cron horario) - so precisa pegar o que e novo desde a
// ultima execucao. O historico profundo (ate 12 meses) e responsabilidade do backfill separado
// (/backfill-vendas), que roda uma unica vez sem competir com o tempo de execucao do cron.
const JANELA_VENDAS_DIAS = 7;
const JANELA_REMESSAS_DIAS = 60; // limite rigido do endpoint stock/fulfillment/operations/search (confirmado via erro real da API)
const JANELA_VISITAS_DIAS = 365; // sem limite de 60 dias neste endpoint (testado e confirmado)
const MAX_PAGINAS_POR_EXECUCAO = 5; // 5 paginas x (1 search + 3 multiget) = ~20 subrequests, com folga do limite do Worker
const MAX_ITENS_ESTOQUE_POR_EXECUCAO = 8; // limitado pelo quota proprio e mais restrito do endpoint de remessas
const PAUSA_ENTRE_REMESSAS_MS = 1200;
const MAX_ITENS_PERFORMANCE_POR_EXECUCAO = 15; // /items/visits so aceita 1 item por chamada
// Teto de seguranca: a Cloudflare mata a execucao perto de 180s (erro 1101, ja observado neste
// projeto). Com o retry da camada de API, uma rajada de 429 pode alongar bastante a rodada, entao
// as etapas lentas param sozinhas antes de chegar perto do limite - e melhor uma rodada incompleta
// (o cron roda de novo em 1h) do que uma execucao morta que nao grava nada.
// Calibrado sobre a medicao real de `tempos_ms` no D1: uma rodada normal termina entre 77s e 116s
// (media 103s), chegando na etapa de faturamento por volta dos 95s. 130s deixa ~35s de folga para
// os retries antes de comecar a cortar etapa, e no pior caso (ultima iteracao entrando no limite,
// com retry cheio nas duas chamadas) a rodada ainda fecha por volta de 165s, abaixo do teto.
const LIMITE_EXECUCAO_MS = 130000;

function esperar(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function runSyncForLoja(env, lojaId, offsetInicial = 0) {
  const db = env.DB;
  const accessToken = await getValidAccessToken(db, env, lojaId);

  const resumo = { skus_atualizados: 0, vendas_analisadas: 0, estoque_atualizado: 0, remessas_encontradas: 0, performance_atualizada: 0, erros: [], tempos_ms: {} };
  const inicio = Date.now();

  // 1. Sincroniza produtos do Full - em lotes, com multiget, respeitando o limite de subrequests do Worker
  let offset = offsetInicial;
  let paginasProcessadas = 0;
  let produtoIdPorMlb = {};
  let totalDisponivel = 0;
  while (paginasProcessadas < MAX_PAGINAS_POR_EXECUCAO) {
    let pagina;
    try {
      pagina = await searchUserItems(accessToken, lojaId, offset);
    } catch (err) {
      // Esta era a unica chamada de API fora de try/catch: qualquer 429/5xx transitorio aqui
      // derrubava a sincronizacao inteira daquela hora, sem gravar nada no banco (invisivel na
      // pagina /saude) e disparando alerta por e-mail. As etapas seguintes nao dependem desta:
      // os produtos ja estao no banco das rodadas anteriores.
      resumo.erros.push(`produtos offset=${offset}: ${err.message}`);
      break;
    }
    totalDisponivel = pagina.paging?.total ?? 0;
    if (!pagina.results || pagina.results.length === 0) break;

    try {
      const itens = await getItemsMultiget(accessToken, pagina.results);
      for (const item of itens) {
        const produtoId = await upsertProduto(db, lojaId, item);
        produtoIdPorMlb[item.id] = produtoId;
        resumo.skus_atualizados++;
      }
    } catch (err) {
      resumo.erros.push(`pagina offset=${offset}: ${err.message}`);
    }

    offset += pagina.results.length;
    paginasProcessadas++;
    if (offset >= totalDisponivel) break;
  }
  if (offset < totalDisponivel) {
    resumo.aviso = `Sincronizados ate offset ${offset} de ${totalDisponivel} produtos. Chame de novo com offset=${offset} para continuar.`;
  }
  resumo.tempos_ms.produtos = Date.now() - inicio;
  await registrarEvento(db, lojaId, "sync_checkpoint_produtos", null, { ms: resumo.tempos_ms.produtos }, "worker_sync");

  const ate = new Date().toISOString();
  const desdeVendas = new Date(Date.now() - JANELA_VENDAS_DIAS * 24 * 60 * 60 * 1000).toISOString();
  const desdeRemessas = new Date(Date.now() - JANELA_REMESSAS_DIAS * 24 * 60 * 60 * 1000).toISOString();

  // 2. Sincroniza vendas do ultimo ano (paginado)
  try {
    const pedidos = await getOrdersSearch(accessToken, lojaId, desdeVendas);
    for (const pedido of pedidos.results || []) {
      for (const item of pedido.order_items || []) {
        const mlb = item.item.id;
        let produtoId = produtoIdPorMlb[mlb];
        if (!produtoId) {
          const produtoExistente = await db.prepare("SELECT id FROM produtos WHERE loja_id = ? AND mlb = ?").bind(lojaId, mlb).first();
          produtoId = produtoExistente?.id;
        }
        if (!produtoId) {
          // Anuncio fora do Full (PRS 12.8, "Aptos para o Full") - guarda a venda separada,
          // sem custo extra de API (o dado ja vem no order_item).
          await inserirVendaForaFull(db, lojaId, pedido, item);
          continue;
        }
        await inserirVenda(db, lojaId, produtoId, pedido, item);
        resumo.vendas_analisadas++;
      }
    }
  } catch (err) {
    resumo.erros.push(`pedidos: ${err.message}`);
  }
  resumo.tempos_ms.vendas = Date.now() - inicio;
  await registrarEvento(db, lojaId, "sync_checkpoint_vendas", null, { ms: resumo.tempos_ms.vendas }, "worker_sync");

  // 3. Estoque e remessas ao Full - so os produtos ha mais tempo sem checar (round-robin entre execucoes)
  const produtosParaChecar = await db.prepare(
    `SELECT p.id, p.mlb, p.inventory_id
     FROM produtos p
     LEFT JOIN (SELECT produto_id, MAX(data_hora) as ultima FROM estoque_historico GROUP BY produto_id) e ON e.produto_id = p.id
     WHERE p.loja_id = ? AND p.inventory_id IS NOT NULL
     ORDER BY e.ultima ASC
     LIMIT ?`
  ).bind(lojaId, MAX_ITENS_ESTOQUE_POR_EXECUCAO).all();

  let primeiro = true;
  for (const produto of produtosParaChecar.results || []) {
    if (Date.now() - inicio > LIMITE_EXECUCAO_MS) {
      resumo.erros.push("estoque/remessas: interrompido pelo teto de tempo de execucao");
      break;
    }
    try {
      const stock = await getStockFulfillment(accessToken, produto.inventory_id);
      await inserirEstoque(db, lojaId, produto.id, stock);
      resumo.estoque_atualizado++;

      if (!primeiro) await esperar(PAUSA_ENTRE_REMESSAS_MS);
      primeiro = false;
      const remessas = await getInboundReceptions(accessToken, lojaId, produto.inventory_id, desdeRemessas, ate);
      for (const remessa of remessas) {
        await inserirEnvio(db, lojaId, produto.id, remessa);
        resumo.remessas_encontradas++;
      }
    } catch (err) {
      resumo.erros.push(`estoque/remessas ${produto.mlb}: ${err.message}`);
    }
  }
  resumo.tempos_ms.estoque_remessas = Date.now() - inicio;

  // 4. Performance (visitas) - so os produtos ha mais tempo sem checar (round-robin entre execucoes)
  const desdeVisitas = new Date(Date.now() - JANELA_VISITAS_DIAS * 24 * 60 * 60 * 1000).toISOString();
  const desdeData = desdeVisitas.slice(0, 10);
  const ateData = ate.slice(0, 10);
  const produtosParaVisitas = await db.prepare(
    `SELECT p.id, p.mlb
     FROM produtos p
     LEFT JOIN (SELECT produto_id, MAX(data) as ultima FROM performance_historico GROUP BY produto_id) perf ON perf.produto_id = p.id
     WHERE p.loja_id = ?
     ORDER BY perf.ultima ASC
     LIMIT ?`
  ).bind(lojaId, MAX_ITENS_PERFORMANCE_POR_EXECUCAO).all();

  for (const produto of produtosParaVisitas.results || []) {
    if (Date.now() - inicio > LIMITE_EXECUCAO_MS) {
      resumo.erros.push("performance: interrompido pelo teto de tempo de execucao");
      break;
    }
    try {
      const visits = await getItemVisits(accessToken, produto.mlb, desdeData, ateData);
      await inserirPerformance(db, lojaId, produto.id, visits);
      resumo.performance_atualizada++;
    } catch (err) {
      resumo.erros.push(`performance ${produto.mlb}: ${err.message}`);
    }
  }

  resumo.tempos_ms.performance = Date.now() - inicio;

  // 5. Gastos com Transporte (Fase 3, PRS 12.10): busca os ultimos periodos de faturamento e grava
  // os totais por tipo de cobranca. A API publica so da agregado mensal, sem detalhamento por coleta
  // individual - grava TODOS os tipos de cobranca retornados, o dashboard filtra pelo rotulo
  // "Custo do serviço de coleta Full" (confirmado em producao, bate com o total apurado manualmente).
  try {
    if (Date.now() - inicio > LIMITE_EXECUCAO_MS) throw new Error("interrompido pelo teto de tempo de execucao");
    const periodos = await getBillingPeriods(accessToken);
    const recentes = (periodos || []).slice(0, 2);
    for (const periodo of recentes) {
      const key = periodo.key || periodo.id;
      if (!key) continue;
      const summary = await getBillingSummary(accessToken, key);

      const charges = summary?.bill_includes?.charges || summary?.charges || [];
      for (const charge of charges) {
        const label = charge.label || charge.type;
        const valor = Number(charge.amount ?? charge.value ?? 0);
        if (!label || !valor) continue;
        await upsertCustoTransporte(db, lojaId, String(key), label, valor);
      }
    }
  } catch (err) {
    resumo.erros.push(`faturamento: ${err.message}`);
  }
  resumo.tempos_ms.faturamento = Date.now() - inicio;

  // 6. Motor de Regras: interpreta os indicadores ja calculados e atualiza a Central de Missoes.
  // Sem chamada de API externa, so leitura/escrita no D1 - custo de tempo desprezivel.
  try {
    resumo.missoes = await gerarMissoes(db, lojaId);
  } catch (err) {
    resumo.erros.push(`motor de regras: ${err.message}`);
  }
  resumo.tempos_ms.missoes = Date.now() - inicio;

  await registrarEvento(db, lojaId, "sincronizacao_concluida", null, resumo, "worker_sync");

  return resumo;
}

export async function handleSync(request, env) {
  const url = new URL(request.url);
  const lojaId = url.searchParams.get("loja");
  if (!lojaId) {
    return new Response("Parametro 'loja' obrigatorio, ex: /sync?loja=123456789", { status: 400 });
  }
  const offsetInicial = Number(url.searchParams.get("offset") || 0);

  const resumo = await runSyncForLoja(env, lojaId, offsetInicial);

  return new Response(JSON.stringify(resumo, null, 2), {
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}
