-- Migracao multi-tenant: adiciona loja_id as tabelas existentes e a tabela de registro de lojas.
-- Dados ja existentes (sincronizados antes desta migracao) pertencem a loja 1055727709 (A2 PLASTICOS).

CREATE TABLE IF NOT EXISTS lojas (
  loja_id TEXT PRIMARY KEY,
  nickname TEXT,
  ativo INTEGER DEFAULT 1,
  criado_em TEXT DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO lojas (loja_id, nickname) VALUES ('1055727709', 'A2 PLASTICOS');

ALTER TABLE produtos ADD COLUMN loja_id TEXT;
ALTER TABLE estoque_historico ADD COLUMN loja_id TEXT;
ALTER TABLE vendas ADD COLUMN loja_id TEXT;
ALTER TABLE envios ADD COLUMN loja_id TEXT;
ALTER TABLE performance_historico ADD COLUMN loja_id TEXT;
ALTER TABLE eventos ADD COLUMN loja_id TEXT;

UPDATE produtos SET loja_id = '1055727709' WHERE loja_id IS NULL;
UPDATE estoque_historico SET loja_id = '1055727709' WHERE loja_id IS NULL;
UPDATE vendas SET loja_id = '1055727709' WHERE loja_id IS NULL;
UPDATE envios SET loja_id = '1055727709' WHERE loja_id IS NULL;
UPDATE performance_historico SET loja_id = '1055727709' WHERE loja_id IS NULL;
UPDATE eventos SET loja_id = '1055727709' WHERE loja_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_produtos_loja ON produtos(loja_id);
CREATE INDEX IF NOT EXISTS idx_vendas_loja ON vendas(loja_id);
CREATE INDEX IF NOT EXISTS idx_envios_loja ON envios(loja_id);
CREATE INDEX IF NOT EXISTS idx_estoque_loja ON estoque_historico(loja_id);
CREATE INDEX IF NOT EXISTS idx_performance_loja ON performance_historico(loja_id);
CREATE INDEX IF NOT EXISTS idx_eventos_loja ON eventos(loja_id);
