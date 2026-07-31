-- Corrige o indice unico de envios: uma remessa (inbound_id) pode conter varios produtos
-- diferentes na mesma caixa/remessa fisica. O indice anterior UNIQUE(loja_id, remessa) descartava
-- silenciosamente produtos diferentes que vieram na mesma remessa. O correto e um par
-- (produto_id, remessa) unico, nao so remessa.
DROP INDEX IF EXISTS ux_envios_loja_remessa;
CREATE UNIQUE INDEX IF NOT EXISTS ux_envios_loja_produto_remessa ON envios(loja_id, produto_id, remessa);
