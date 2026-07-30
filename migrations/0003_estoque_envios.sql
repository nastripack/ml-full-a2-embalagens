-- Adiciona inventory_id (necessario para consultar estoque e remessas Full por produto)
ALTER TABLE produtos ADD COLUMN inventory_id TEXT;

-- Evita duplicar a mesma remessa (operacao inbound_reception) em resincronizacoes
CREATE UNIQUE INDEX IF NOT EXISTS ux_envios_loja_remessa ON envios(loja_id, remessa);
