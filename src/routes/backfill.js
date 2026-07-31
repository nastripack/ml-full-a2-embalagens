// Rotina de backfill historico de remessas (INBOUND_RECEPTION), executada manualmente uma unica
// vez por loja - NAO faz parte do cron de rotina. O endpoint stock/fulfillment/operations/search
// tem limite rigido de 60 dias por chamada e quota propria restrita, entao aqui varremos os ultimos
// 12 meses em blocos de 60 dias, um produto/bloco por vez, com pausa generosa entre chamadas.
// E resumivel via ?indice= para nao depender de uma unica requisicao HTTP muito longa.

import { getValidAccessToken, getInboundReceptions, getOrdersSearchPage } from "../lib/mercadolivre.js";
import { inserirEnvio, inserirVenda, registrarEvento } from "../lib/db.js";

const DIAS_POR_BLOCO = 60;
const TOTAL_DIAS_BACKFILL = 365;
const NUM_BLOCOS_EXTRAS = Math.ceil((TOTAL_DIAS_BACKFILL - DIAS_POR_BLOCO) / DIAS_POR_BLOCO); // blocos alem do que o sync de rotina ja cobre (60 dias)
const PAUSA_MS = 1500;
const LOTE_PADRAO = 10;

function esperar(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isoDiasAtras(dias) {
  return new Date(Date.now() - dias * 24 * 60 * 60 * 1000).toISOString();
}

export async function handleBackfillRemessas(request, env) {
  const url = new URL(request.url);
  const lojaId = url.searchParams.get("loja");
  if (!lojaId) {
    return new Response("Parametro 'loja' obrigatorio, ex: /backfill-remessas?loja=123456789", { status: 400 });
  }
  const indiceInicial = Number(url.searchParams.get("indice") || 0);
  const lote = Number(url.searchParams.get("lote") || LOTE_PADRAO);

  const db = env.DB;
  const accessToken = await getValidAccessToken(db, env, lojaId);

  const produtos = await db.prepare(
    "SELECT id, mlb, inventory_id FROM produtos WHERE loja_id = ? AND inventory_id IS NOT NULL ORDER BY id"
  ).bind(lojaId).all();
  const listaProdutos = produtos.results || [];

  const tarefas = [];
  for (const p of listaProdutos) {
    for (let bloco = 1; bloco <= NUM_BLOCOS_EXTRAS; bloco++) {
      tarefas.push({ produto: p, bloco });
    }
  }

  const total = tarefas.length;
  const fim = Math.min(indiceInicial + lote, total);
  let processadas = 0;
  let remessasEncontradas = 0;
  const erros = [];

  for (let i = indiceInicial; i < fim; i++) {
    const { produto, bloco } = tarefas[i];
    const ateDiasAtras = DIAS_POR_BLOCO + (bloco - 1) * DIAS_POR_BLOCO;
    const desdeDiasAtras = Math.min(DIAS_POR_BLOCO + bloco * DIAS_POR_BLOCO, TOTAL_DIAS_BACKFILL);
    const ateBloco = isoDiasAtras(ateDiasAtras);
    const desdeBloco = isoDiasAtras(desdeDiasAtras);

    try {
      if (i > indiceInicial) await esperar(PAUSA_MS);
      const remessas = await getInboundReceptions(accessToken, lojaId, produto.inventory_id, desdeBloco, ateBloco);
      for (const remessa of remessas) {
        await inserirEnvio(db, lojaId, produto.id, remessa);
        remessasEncontradas++;
      }
      processadas++;
    } catch (err) {
      erros.push(`${produto.mlb} bloco ${bloco} (${ateDiasAtras}-${desdeDiasAtras}d): ${err.message}`);
    }
  }

  const concluido = fim >= total;
  if (concluido) {
    await registrarEvento(db, lojaId, "backfill_remessas_concluido", null, { total }, "backfill_manual");
  }

  return new Response(JSON.stringify({
    processadas,
    remessas_encontradas: remessasEncontradas,
    indice_atual: fim,
    total_tarefas: total,
    concluido,
    proximo_indice: concluido ? null : fim,
    erros
  }, null, 2), { headers: { "Content-Type": "application/json; charset=utf-8" } });
}

// Backfill historico de vendas (ate 12 meses), resumivel via ?offset=. O sync de rotina so olha os
// ultimos 7 dias (rapido); esta rotina separada popula o restante do historico sem competir com o
// tempo de execucao do cron.
const PAGINAS_POR_CHAMADA_VENDAS = 5;

export async function handleBackfillVendas(request, env) {
  const url = new URL(request.url);
  const lojaId = url.searchParams.get("loja");
  if (!lojaId) {
    return new Response("Parametro 'loja' obrigatorio, ex: /backfill-vendas?loja=123456789", { status: 400 });
  }
  const offsetInicial = Number(url.searchParams.get("offset") || 0);
  const paginasPorChamada = Number(url.searchParams.get("paginas") || PAGINAS_POR_CHAMADA_VENDAS);

  const db = env.DB;
  const accessToken = await getValidAccessToken(db, env, lojaId);
  const desde = isoDiasAtras(TOTAL_DIAS_BACKFILL);

  let offset = offsetInicial;
  let paginasProcessadas = 0;
  let vendasInseridas = 0;
  let total = 0;
  const erros = [];

  while (paginasProcessadas < paginasPorChamada) {
    let pagina;
    try {
      pagina = await getOrdersSearchPage(accessToken, lojaId, desde, offset);
    } catch (err) {
      erros.push(`offset ${offset}: ${err.message}`);
      break;
    }
    total = pagina.paging?.total ?? 0;
    if (!pagina.results || pagina.results.length === 0) break;

    for (const pedido of pagina.results) {
      for (const item of pedido.order_items || []) {
        const produtoExistente = await db.prepare("SELECT id FROM produtos WHERE loja_id = ? AND mlb = ?").bind(lojaId, item.item.id).first();
        if (!produtoExistente) continue; // produto ainda nao sincronizado
        await inserirVenda(db, lojaId, produtoExistente.id, pedido, item);
        vendasInseridas++;
      }
    }

    offset += pagina.results.length;
    paginasProcessadas++;
    if (offset >= total) break;
  }

  const concluido = offset >= total;
  if (concluido) {
    await registrarEvento(db, lojaId, "backfill_vendas_concluido", null, { total }, "backfill_manual");
  }

  return new Response(JSON.stringify({
    vendas_inseridas: vendasInseridas,
    offset_atual: offset,
    total_pedidos: total,
    concluido,
    proximo_offset: concluido ? null : offset,
    erros
  }, null, 2), { headers: { "Content-Type": "application/json; charset=utf-8" } });
}
