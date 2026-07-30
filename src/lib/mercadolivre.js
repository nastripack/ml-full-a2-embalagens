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

  const refreshed = await refreshToken(env, row.refresh_token);
  const expiresAtNovo = new Date(Date.now() + refreshed.expires_in * 1000).toISOString();
  await db.prepare(
    "UPDATE ml_auth SET access_token = ?, refresh_token = ?, expires_at = ?, atualizado_em = datetime('now') WHERE loja_id = ?"
  ).bind(refreshed.access_token, refreshed.refresh_token, expiresAtNovo, lojaId).run();

  return refreshed.access_token;
}

async function apiGet(accessToken, path) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Authorization": `Bearer ${accessToken}` }
  });
  if (!res.ok) throw new Error(`Erro na API do Mercado Livre (${path}): ${res.status} ${await res.text()}`);
  return res.json();
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

const MAX_PAGINAS_PEDIDOS = 10; // 10 x limit 50 = ate 500 pedidos por execucao, com folga do limite de subrequests

export async function getOrdersSearch(accessToken, sellerId, fromDate) {
  const limit = 50;
  let offset = 0;
  let todos = [];
  for (let pagina = 0; pagina < MAX_PAGINAS_PEDIDOS; pagina++) {
    const params = new URLSearchParams({
      seller: sellerId,
      "order.date_created.from": fromDate,
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
