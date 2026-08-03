-- Fase 3: Aptos para o Full (PRS 12.8). Vendas de anuncios que NAO estao no Full aparecem em
-- /orders/search mas eram descartadas (produto nao existe em `produtos`, que so tem itens Full).
-- Tabela separada (nao mistura com `produtos`) para nao quebrar nenhuma suposicao implicita de
-- "produtos = Full" espalhada pelo Planejador/Missoes/dashboard. Dado vem de graca do order_item
-- que ja e buscado hoje, sem chamada de API extra.
CREATE TABLE IF NOT EXISTS vendas_fora_full (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  loja_id TEXT NOT NULL,
  pedido_id TEXT NOT NULL,
  mlb TEXT NOT NULL,
  titulo TEXT,
  data_hora TEXT NOT NULL,
  quantidade INTEGER NOT NULL,
  valor_bruto REAL,
  UNIQUE(loja_id, pedido_id, mlb)
);
CREATE INDEX IF NOT EXISTS idx_vendas_fora_full_loja ON vendas_fora_full(loja_id);
