export async function upsertLoja(db, lojaId, nickname) {
  await db.prepare(
    `INSERT INTO lojas (loja_id, nickname) VALUES (?, ?)
     ON CONFLICT(loja_id) DO UPDATE SET nickname = excluded.nickname`
  ).bind(lojaId, nickname).run();
}

export async function upsertProduto(db, lojaId, item) {
  const existente = await db.prepare("SELECT id FROM produtos WHERE loja_id = ? AND mlb = ?").bind(lojaId, item.id).first();

  const dims = parseDimensions(item.shipping?.dimensions);

  if (existente) {
    await db.prepare(
      `UPDATE produtos SET sku = ?, nome = ?, categoria = ?, tipo_envio = ?, status = ?, inventory_id = ?,
       peso_gramas = ?, altura_cm = ?, largura_cm = ?, comprimento_cm = ?, atualizado_em = datetime('now')
       WHERE loja_id = ? AND mlb = ?`
    ).bind(
      item.seller_custom_field || null,
      item.title,
      item.category_id || null,
      item.shipping?.logistic_type || null,
      item.status || null,
      item.inventory_id || null,
      dims.peso_gramas,
      dims.altura_cm,
      dims.largura_cm,
      dims.comprimento_cm,
      lojaId,
      item.id
    ).run();
    return existente.id;
  }

  const inserted = await db.prepare(
    `INSERT INTO produtos (loja_id, sku, mlb, inventory_id, nome, categoria, tipo_envio, status, peso_gramas, altura_cm, largura_cm, comprimento_cm)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    lojaId,
    item.seller_custom_field || null,
    item.id,
    item.inventory_id || null,
    item.title,
    item.category_id || null,
    item.shipping?.logistic_type || null,
    item.status || null,
    dims.peso_gramas,
    dims.altura_cm,
    dims.largura_cm,
    dims.comprimento_cm
  ).run();

  return inserted.meta.last_row_id;
}

function parseDimensions(dimensions) {
  // Formato do Mercado Livre: "altura x largura x comprimento, peso"
  if (!dimensions) return { peso_gramas: null, altura_cm: null, largura_cm: null, comprimento_cm: null };
  const match = /^(\d+)x(\d+)x(\d+),(\d+)$/.exec(dimensions);
  if (!match) return { peso_gramas: null, altura_cm: null, largura_cm: null, comprimento_cm: null };
  const [, altura, largura, comprimento, peso] = match;
  return {
    altura_cm: Number(altura) / 10,
    largura_cm: Number(largura) / 10,
    comprimento_cm: Number(comprimento) / 10,
    peso_gramas: Number(peso)
  };
}

export async function inserirVenda(db, lojaId, produtoId, pedido, item) {
  const valorBruto = item.unit_price * item.quantity;
  // sale_fee vem dentro de cada order_item, nao no nivel do pedido (bug anterior lia pedido.sale_fee,
  // que nao existe, e sempre resultava em comissao 0 - corrigido a partir de agosto/2026).
  const comissao = item.sale_fee || 0;
  const valorLiquido = valorBruto - comissao;

  await db.prepare(
    `INSERT OR IGNORE INTO vendas (loja_id, pedido_id, produto_id, data_hora, quantidade, valor_bruto, comissao, valor_liquido)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    lojaId,
    String(pedido.id),
    produtoId,
    pedido.date_created,
    item.quantity,
    valorBruto,
    comissao,
    valorLiquido
  ).run();
}

// Vendas de anuncios fora do Full (PRS 12.8) - mesmo order_item ja buscado no sync, sem chamada
// extra de API. Usa mlb+titulo direto do payload do pedido, ja que nao ha produtoId (produto nao
// esta cadastrado em `produtos`, que so tem itens Full).
export async function inserirVendaForaFull(db, lojaId, pedido, item) {
  const valorBruto = item.unit_price * item.quantity;
  await db.prepare(
    `INSERT OR IGNORE INTO vendas_fora_full (loja_id, pedido_id, mlb, titulo, data_hora, quantidade, valor_bruto)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    lojaId,
    String(pedido.id),
    item.item.id,
    item.item.title || null,
    pedido.date_created,
    item.quantity,
    valorBruto
  ).run();
}

export async function inserirEstoque(db, lojaId, produtoId, stock) {
  await db.prepare(
    `INSERT INTO estoque_historico (loja_id, produto_id, estoque_full, reservado)
     VALUES (?, ?, ?, ?)`
  ).bind(lojaId, produtoId, stock.total ?? null, stock.not_available_quantity ?? null).run();
}

export async function inserirEnvio(db, lojaId, produtoId, operacao) {
  const inboundId = operacao.external_references?.find(r => r.type === "inbound_id")?.value;
  const remessa = inboundId || String(operacao.id);

  await db.prepare(
    `INSERT OR IGNORE INTO envios (loja_id, produto_id, data, remessa, quantidade_enviada)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(
    lojaId,
    produtoId,
    operacao.date_created,
    remessa,
    operacao.detail?.available_quantity ?? null
  ).run();
}

// impressoes e posicao nao sao expostas pela API publica do Mercado Livre; conversao e calculada
// depois pelo Motor Analitico (cruzando com vendas), nao gravada aqui para nao ficar desatualizada.
export async function inserirPerformance(db, lojaId, produtoId, visits) {
  await db.prepare(
    `INSERT INTO performance_historico (loja_id, produto_id, data, visualizacoes)
     VALUES (?, ?, date('now'), ?)`
  ).bind(lojaId, produtoId, visits?.total_visits ?? null).run();
}

export async function upsertCustoTransporte(db, lojaId, periodo, label, valor) {
  await db.prepare(
    `INSERT INTO custos_transporte (loja_id, periodo, label, valor)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(loja_id, periodo, label) DO UPDATE SET valor = excluded.valor, atualizado_em = datetime('now')`
  ).bind(lojaId, periodo, label, valor).run();
}

// Conta quantas sincronizacoes seguidas falharam (da mais recente para tras) na trilha de eventos.
// Serve para alertar por e-mail so quando o problema persiste, em vez de a cada instabilidade
// transitoria da API do Mercado Livre - que e frequente e se resolve sozinha na rodada seguinte.
export async function contarFalhasConsecutivas(db, lojaId) {
  const linhas = await db.prepare(
    `SELECT tipo FROM eventos
     WHERE loja_id = ? AND tipo IN ('sincronizacao_concluida', 'sincronizacao_falhou')
     ORDER BY data_hora DESC, id DESC
     LIMIT 10`
  ).bind(lojaId).all();

  let consecutivas = 0;
  for (const linha of linhas.results || []) {
    if (linha.tipo !== "sincronizacao_falhou") break;
    consecutivas++;
  }
  return consecutivas;
}

export async function registrarEvento(db, lojaId, tipo, produtoId, payload, origem) {
  await db.prepare(
    "INSERT INTO eventos (loja_id, tipo, produto_id, payload_json, origem) VALUES (?, ?, ?, ?, ?)"
  ).bind(lojaId, tipo, produtoId ?? null, JSON.stringify(payload), origem).run();
}
