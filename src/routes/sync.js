import { getValidAccessToken, getItemsMultiget, searchUserItems, getOrdersSearch } from "../lib/mercadolivre.js";
import { upsertProduto, inserirVenda, registrarEvento } from "../lib/db.js";

const JANELA_VENDAS_DIAS = 60;
const MAX_PAGINAS_POR_EXECUCAO = 5; // 5 paginas x (1 search + 3 multiget) = ~20 subrequests, com folga do limite do Worker

export async function runSyncForLoja(env, lojaId, offsetInicial = 0) {
  const db = env.DB;
  const accessToken = await getValidAccessToken(db, env, lojaId);

  const resumo = { skus_atualizados: 0, vendas_analisadas: 0, erros: [] };

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
        await registrarEvento(db, lojaId, "produto_sincronizado", produtoId, { mlb: item.id }, "mercadolivre_api");
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

  // 2. Sincroniza vendas dos ultimos 60 dias (paginado)
  const desde = new Date(Date.now() - JANELA_VENDAS_DIAS * 24 * 60 * 60 * 1000).toISOString();
  try {
    const pedidos = await getOrdersSearch(accessToken, lojaId, desde);
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
