-- Registro das lojas (contas PJ do Mercado Livre) conectadas ao ambiente multi-tenant
CREATE TABLE IF NOT EXISTS lojas (
  loja_id TEXT PRIMARY KEY,
  nickname TEXT,
  ativo INTEGER DEFAULT 1,
  criado_em TEXT DEFAULT (datetime('now'))
);

-- Cadastro mestre de produtos (estado atual, atualizado a cada sincronizacao), por loja
CREATE TABLE IF NOT EXISTS produtos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  loja_id TEXT NOT NULL,
  sku TEXT,
  mlb TEXT NOT NULL,
  inventory_id TEXT,
  ean TEXT,
  nome TEXT NOT NULL,
  categoria TEXT,
  marca TEXT,
  peso_gramas INTEGER,
  altura_cm REAL,
  largura_cm REAL,
  comprimento_cm REAL,
  tipo_envio TEXT,
  status TEXT,
  atualizado_em TEXT DEFAULT (datetime('now')),
  UNIQUE(loja_id, mlb)
);
CREATE INDEX IF NOT EXISTS idx_produtos_loja ON produtos(loja_id);

-- Historico de estoque: insert-only, nunca sobrescreve
CREATE TABLE IF NOT EXISTS estoque_historico (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  loja_id TEXT NOT NULL,
  produto_id INTEGER NOT NULL,
  data_hora TEXT NOT NULL DEFAULT (datetime('now')),
  estoque_full INTEGER,
  estoque_empresa INTEGER,
  reservado INTEGER,
  em_transito INTEGER,
  FOREIGN KEY (produto_id) REFERENCES produtos(id)
);
CREATE INDEX IF NOT EXISTS idx_estoque_loja ON estoque_historico(loja_id);

-- Historico de vendas: insert-only
CREATE TABLE IF NOT EXISTS vendas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  loja_id TEXT NOT NULL,
  pedido_id TEXT NOT NULL,
  produto_id INTEGER NOT NULL,
  data_hora TEXT NOT NULL,
  quantidade INTEGER NOT NULL,
  valor_bruto REAL,
  comissao REAL,
  tarifa REAL,
  frete REAL,
  valor_liquido REAL,
  UNIQUE(pedido_id, produto_id),
  FOREIGN KEY (produto_id) REFERENCES produtos(id)
);
CREATE INDEX IF NOT EXISTS idx_vendas_loja ON vendas(loja_id);

-- Historico de envios ao Full: insert-only
CREATE TABLE IF NOT EXISTS envios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  loja_id TEXT NOT NULL,
  produto_id INTEGER NOT NULL,
  data TEXT NOT NULL,
  remessa TEXT,
  transportadora TEXT,
  quantidade_enviada INTEGER,
  valor_mercadoria REAL,
  valor_transporte REAL,
  FOREIGN KEY (produto_id) REFERENCES produtos(id)
);
CREATE INDEX IF NOT EXISTS idx_envios_loja ON envios(loja_id);
-- Uma remessa pode conter varios produtos diferentes - a unicidade precisa incluir produto_id.
CREATE UNIQUE INDEX IF NOT EXISTS ux_envios_loja_produto_remessa ON envios(loja_id, produto_id, remessa);

-- Historico de performance do anuncio: insert-only
CREATE TABLE IF NOT EXISTS performance_historico (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  loja_id TEXT NOT NULL,
  produto_id INTEGER NOT NULL,
  data TEXT NOT NULL,
  visualizacoes INTEGER,
  impressoes INTEGER,
  conversao REAL,
  posicao INTEGER,
  FOREIGN KEY (produto_id) REFERENCES produtos(id)
);
CREATE INDEX IF NOT EXISTS idx_performance_loja ON performance_historico(loja_id);

-- Trilha de auditoria de toda sincronizacao
CREATE TABLE IF NOT EXISTS eventos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  loja_id TEXT,
  tipo TEXT NOT NULL,
  data_hora TEXT NOT NULL DEFAULT (datetime('now')),
  produto_id INTEGER,
  payload_json TEXT,
  origem TEXT
);
CREATE INDEX IF NOT EXISTS idx_eventos_loja ON eventos(loja_id);

-- Suporte tecnico ao OAuth (nao faz parte do modelo de negocio do PRS)
CREATE TABLE IF NOT EXISTS ml_auth (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  loja_id TEXT NOT NULL UNIQUE,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  atualizado_em TEXT DEFAULT (datetime('now'))
);
