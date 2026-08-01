-- Fase 3: Central de Missoes (Motor de Regras). Cada linha e uma situacao detectada
-- pelo Motor de Regras para um produto - fica aberta ate a situacao deixar de existir
-- (auto-resolvida) ou o usuario marcar como executada/ignorada (RF-020/RB-008).
CREATE TABLE IF NOT EXISTS missoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  loja_id TEXT NOT NULL,
  produto_id INTEGER,
  tipo TEXT NOT NULL,
  prioridade TEXT NOT NULL,
  situacao TEXT NOT NULL,
  motivo TEXT NOT NULL,
  impacto_estimado TEXT,
  status TEXT NOT NULL DEFAULT 'aberta',
  criado_em TEXT DEFAULT (datetime('now')),
  resolvido_em TEXT,
  FOREIGN KEY (produto_id) REFERENCES produtos(id)
);
CREATE INDEX IF NOT EXISTS idx_missoes_loja ON missoes(loja_id);
-- Indice unico parcial: so uma missao aberta por (loja, produto, tipo) por vez,
-- evita duplicar a cada sincronizacao horaria.
CREATE UNIQUE INDEX IF NOT EXISTS ux_missoes_aberta ON missoes(loja_id, produto_id, tipo) WHERE status = 'aberta';
