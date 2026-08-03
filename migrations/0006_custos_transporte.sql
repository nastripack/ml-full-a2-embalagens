-- Fase 3 (2a fatia): custos de transporte por periodo, via API de Faturamento (agregado mensal,
-- sem detalhamento por coleta individual - a API publica nao expoe isso, so o total por tipo de
-- cobranca no mes). Upsert (nao insert-only puro) porque o periodo corrente muda ate fechar.
CREATE TABLE IF NOT EXISTS custos_transporte (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  loja_id TEXT NOT NULL,
  periodo TEXT NOT NULL,
  label TEXT NOT NULL,
  valor REAL NOT NULL,
  atualizado_em TEXT DEFAULT (datetime('now')),
  UNIQUE(loja_id, periodo, label)
);
CREATE INDEX IF NOT EXISTS idx_custos_transporte_loja ON custos_transporte(loja_id);
