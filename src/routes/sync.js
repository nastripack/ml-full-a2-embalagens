import {
  getValidAccessToken, getItemsMultiget, searchUserItems, getOrdersSearch,
  getStockFulfillment, getInboundReceptions, getItemVisits
} from "../lib/mercadolivre.js";
import { upsertProduto, inserirVenda, inserirEstoque, inserirEnvio, inserirPerformance, registrarEvento } from "../lib/db.js";
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
    const pagina = await searchUserItems(accessToken, lojaId, offset);
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
        if (!produtoId) continue; // produto ainda nao sincronizado nesta rodada
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
    try {
      const visits = await getItemVisits(accessToken, produto.mlb, desdeData, ateData);
      await inserirPerformance(db, lojaId, produto.id, visits);
      resumo.performance_atualizada++;
    } catch (err) {
      resumo.erros.push(`performance ${produto.mlb}: ${err.message}`);
    }
  }

  resumo.tempos_ms.performance = Date.now() - inicio;

  // 5. Motor de Regras: interpreta os indicadores ja calculados e atualiza a Central de Missoes.
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
