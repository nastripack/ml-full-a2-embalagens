const TOKEN_URL = "https://api.mercadolibre.com/oauth/token";
const API_BASE = "https://api.mercadolibre.com";

export function buildAuthorizationUrl(env) {
  const url = new URL("https://auth.mercadolivre.com.br/authorization");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", env.ML_CLIENT_ID);
  url.searchParams.set("redirect_uri", env.ML_REDIRECT_URI);
  return url.toString();
}

export async function exchangeCodeForToken(env, code) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: env.ML_CLIENT_ID,
      client_secret: env.ML_CLIENT_SECRET,
      code,
      redirect_uri: env.ML_REDIRECT_URI
    })
  });
  if (!res.ok) throw new Error(`Falha ao trocar code por token: ${res.status} ${await res.text()}`);
  return res.json();
}

async function refreshToken(env, refresh_token) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: env.ML_CLIENT_ID,
      client_secret: env.ML_CLIENT_SECRET,
      refresh_token
    })
  });
  if (!res.ok) throw new Error(`Falha ao renovar token: ${res.status} ${await res.text()}`);
  return res.json();
}

// Retorna um access_token valido para a loja, renovando via refresh_token se necessario.
export async function getValidAccessToken(db, env, lojaId) {
  const row = await db.prepare("SELECT * FROM ml_auth WHERE loja_id = ?").bind(lojaId).first();
  if (!row) throw new Error(`Nenhuma autenticacao encontrada para a loja ${lojaId}`);

  const expiresAt = new Date(row.expires_at).getTime();
  const margemMs = 60 * 1000;
  if (Date.now() < expiresAt - margemMs) {
    return row.access_token;
  }

  try {
    const refreshed = await refreshToken(env, row.refresh_token);
    const expiresAtNovo = new Date(Date.now() + refreshed.expires_in * 1000).toISOString();
    await db.prepare(
      "UPDATE ml_auth SET access_token = ?, refresh_token = ?, expires_at = ?, atualizado_em = datetime('now') WHERE loja_id = ?"
    ).bind(refreshed.access_token, refreshed.refresh_token, expiresAtNovo, lojaId).run();

    return refreshed.access_token;
  } catch (err) {
    // O refresh_token do Mercado Livre e' de uso unico: se duas chamadas concorrentes tentarem
    // renovar ao mesmo tempo (ex: cron + /sync manual sobrepostos), a segunda falha porque a primeira
    // ja invalidou o refresh_token usado. Antes de desistir, reconsulta o banco (com pequenas esperas,
    // pra dar tempo da outra chamada terminar de gravar) - se ela ja atualizou com sucesso nesse meio
    // tempo, usa o token dela em vez de propagar um erro evitavel.
    for (let tentativa = 0; tentativa < 3; tentativa++) {
      if (tentativa > 0) await esperar(300);
      const rowAtualizado = await db.prepare("SELECT * FROM ml_auth WHERE loja_id = ?").bind(lojaId).first();
      if (rowAtualizado && rowAtualizado.access_token !== row.access_token) {
        const expiresAtAtualizado = new Date(rowAtualizado.expires_at).getTime();
        if (Date.now() < expiresAtAtualizado - margemMs) {
          return rowAtualizado.access_token;
        }
      }
    }
    throw err;
  }
}

const MAX_TENTATIVAS = 3;
const ESPERA_BASE_MS = 1000;
const TETO_RETRY_AFTER_MS = 5000; // nao deixa a API pedir uma espera longa demais pro tempo de execucao do Worker

function esperar(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 429 (quota) e 5xx da API do Mercado Livre sao transitorios e vem em rajadas curtas - o endpoint de
// remessas em especial devolve 429 direto. Sem retry, uma unica resposta dessas derrubava a chamada,
// e no caso do searchUserItems derrubava a sincronizacao inteira daquela hora (ver PLANO.md).
async function apiGet(accessToken, path, tentativa = 1) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Authorization": `Bearer ${accessToken}` }
  });
  if (res.ok) return res.json();

  const transitorio = res.status === 429 || res.status >= 500;
  if (transitorio && tentativa < MAX_TENTATIVAS) {
    const retryAfterS = Number(res.headers.get("Retry-After"));
    const espera = Number.isFinite(retryAfterS) && retryAfterS > 0
      ? Math.min(retryAfterS * 1000, TETO_RETRY_AFTER_MS)
      : ESPERA_BASE_MS * 2 ** (tentativa - 1);
    await esperar(espera);
    return apiGet(accessToken, path, tentativa + 1);
  }

  throw new Error(`Erro na API do Mercado Livre (${path}): ${res.status} ${await res.text()}`);
}

export async function getUser(accessToken) {
  return apiGet(accessToken, "/users/me");
}

export async function getItem(accessToken, itemId) {
  return apiGet(accessToken, `/items/${itemId}`);
}

// Busca ate 20 itens por chamada (endpoint multiget do Mercado Livre), reduzindo subrequests.
export async function getItemsMultiget(accessToken, itemIds) {
  const resultados = [];
  for (let i = 0; i < itemIds.length; i += 20) {
    const lote = itemIds.slice(i, i + 20);
    const data = await apiGet(accessToken, `/items?ids=${lote.join(",")}`);
    for (const entry of data) {
      if (entry.code === 200) resultados.push(entry.body);
    }
  }
  return resultados;
}

// Filtra so os anuncios que estao no programa Full (logistic_type=fulfillment) -
// o objetivo desta plataforma e a operacao Full, nao o catalogo inteiro do vendedor.
export async function searchUserItems(accessToken, userId, offset = 0) {
  return apiGet(accessToken, `/users/${userId}/items/search?limit=50&offset=${offset}&logistic_type=fulfillment`);
}

const MAX_PAGINAS_PEDIDOS = 10; // 10 x limit 50 = ate 500 pedidos - o sync de rotina usa janela curta (7 dias), sem risco de estourar o tempo de execucao

export async function getOrdersSearch(accessToken, sellerId, fromDate) {
  const limit = 50;
  let offset = 0;
  let todos = [];
  for (let pagina = 0; pagina < MAX_PAGINAS_PEDIDOS; pagina++) {
    const params = new URLSearchParams({
      seller: sellerId,
      "order.date_created.from": fromDate,
      "order.status": "paid",
      sort: "date_desc",
      limit: String(limit),
      offset: String(offset)
    });
    const data = await apiGet(accessToken, `/orders/search?${params.toString()}`);
    todos = todos.concat(data.results || []);
    const total = data.paging?.total ?? 0;
    offset += (data.results || []).length;
    if ((data.results || []).length === 0 || offset >= total) break;
  }
  return { results: todos };
}

// Uma pagina por chamada, com offset explicito - usado pelo backfill historico resumivel,
// que precisa controlar quantas paginas processa por invocacao (nao pode rodar tudo de uma vez
// sem estourar o tempo de execucao do Worker).
export async function getOrdersSearchPage(accessToken, sellerId, fromDate, offset, limit = 50) {
  const params = new URLSearchParams({
    seller: sellerId,
    "order.date_created.from": fromDate,
    "order.status": "paid",
    sort: "date_desc",
    limit: String(limit),
    offset: String(offset)
  });
  return apiGet(accessToken, `/orders/search?${params.toString()}`);
}

export async function getShipment(accessToken, shipmentId) {
  return apiGet(accessToken, `/shipments/${shipmentId}`);
}

// Estoque atual no Full para um produto (por inventory_id).
export async function getStockFulfillment(accessToken, inventoryId) {
  return apiGet(accessToken, `/inventories/${inventoryId}/stock/fulfillment`);
}

// Historico de remessas recebidas no Full (operacoes do tipo INBOUND_RECEPTION) para um produto.
// date_from/date_to sao obrigatorios e o intervalo nao pode passar de 60 dias.
export async function getInboundReceptions(accessToken, sellerId, inventoryId, fromDate, toDate) {
  const params = new URLSearchParams({
    seller_id: sellerId,
    inventory_id: inventoryId,
    type: "INBOUND_RECEPTION",
    date_from: fromDate,
    date_to: toDate
  });
  const data = await apiGet(accessToken, `/stock/fulfillment/operations/search?${params.toString()}`);
  return data.results || [];
}

// Visitas de um item num periodo (so aceita 1 item por chamada). Datas no formato YYYY-MM-DD.
export async function getItemVisits(accessToken, itemId, fromDate, toDate) {
  const data = await apiGet(accessToken, `/items/visits?ids=${itemId}&date_from=${fromDate}&date_to=${toDate}`);
  return data[0] || null;
}

// Periodos de faturamento (grupo ML = Mercado Livre, nao Mercado Pago). Retorna so agregados
// mensais - nao ha endpoint publico com detalhamento por coleta/transacao individual.
export async function getBillingPeriods(accessToken) {
  const data = await apiGet(accessToken, "/billing/integration/monthly/periods?group=ML&document_type=BILL");
  return data.results || data || [];
}

// Resumo de cobrancas e bonificacoes de um periodo (agregado por tipo, nao por transacao).
export async function getBillingSummary(accessToken, periodKey) {
  return apiGet(accessToken, `/billing/integration/periods/key/${periodKey}/summary/details?group=ML&document_type=BILL`);
}
