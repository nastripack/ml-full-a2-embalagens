# ML Full - A2 Embalagens

Copiloto operacional para Mercado Livre Full. Sincroniza produtos, vendas, estoque e remessas (envios) do Full de uma ou mais contas (multi-tenant) para um banco histórico, e exibe um dashboard executivo — com visão individual por loja e uma visão comparativa entre lojas.

Baseado no PRS/SRS `PRS_SRS_Mercado_Livre_Full_v1.docx` (não incluído neste repositório).

## Arquitetura

- **Cloudflare Workers** (`src/index.js`) — roteador HTTP + cron trigger.
- **Cloudflare D1** (SQLite) — banco histórico, schema em `schema.sql`.
- **Mercado Livre API** — OAuth 2.0 (Authorization Code + Refresh Token) via um único aplicativo registrado em developers.mercadolivre.com.br, compartilhado por todas as lojas/contas PJ conectadas.
- **Resend** — envio de e-mail de alerta quando a sincronização automática falha.

### Estrutura

```
src/
  index.js             roteador principal + cron (scheduled)
  lib/
    mercadolivre.js    cliente da API do Mercado Livre (OAuth, items, orders)
    db.js              helpers de leitura/escrita no D1
    alertas.js          envio de e-mail via Resend em caso de falha
  routes/
    auth.js            /auth/login, /auth/callback
    sync.js            /sync - orquestra a sincronizacao (produtos Full, vendas, estoque, remessas)
    dashboard.js       /  - dashboard (visao geral e por loja)
migrations/            scripts de migracao ja aplicados em producao (nao reaplicar)
schema.sql             schema completo, usado apenas em instalacoes novas (wrangler d1 execute)
```

## Multi-tenant

O sistema aceita **múltiplas contas PJ do Mercado Livre no mesmo ambiente**. Não é preciso criar um novo Worker, banco ou app do Mercado Livre por cliente — basta a conta acessar `/auth/login` e autorizar com a própria conta do Mercado Livre. O `loja_id` (o `user.id` retornado pela API do ML) identifica cada conta em todas as tabelas.

- `full.nastripack.com.br/` — visão geral: lista de lojas conectadas, ranking de vendas (30 dias) e top produtos combinados entre todas as lojas.
- `full.nastripack.com.br/?loja=<ID>` — dashboard individual daquela loja.

## Setup (instalação nova, do zero)

1. `npm install`
2. Criar o aplicativo no Mercado Livre Developers (developers.mercadolivre.com.br → Minhas aplicações → Criar aplicação):
   - Redirect URI: `https://<seu-dominio>/auth/callback`
   - Fluxos OAuth: Authorization Code + Refresh Token (Client Credentials não é necessário)
   - Permissões mínimas usadas por este projeto: Usuários (leitura e escrita, obrigatório), Publicação e sincronização (leitura e escrita), Faturamento de uma venda (leitura), Métricas do negócio (leitura), Venda e envios de um produto (leitura)
3. Ajustar `wrangler.toml`: `ML_CLIENT_ID`, `ML_REDIRECT_URI`, nome do Worker, rota do domínio customizado.
4. `wrangler d1 create <nome-do-banco>` e colar o `database_id` retornado no `wrangler.toml`.
5. `wrangler d1 execute <nome-do-banco> --remote --file=./schema.sql`
6. Segredos (nunca vão para o código nem para o `wrangler.toml`):
   ```
   wrangler secret put ML_CLIENT_SECRET
   wrangler secret put RESEND_API_KEY
   ```
   **Importante:** cole os valores (botão direito no terminal), nunca digite na mão — segredos são strings aleatórias longas, fácil de errar um caractere digitando.
7. `wrangler deploy`

## Onboarding de uma nova loja (conta PJ) no ambiente já existente

Não precisa repetir o setup acima. Basta a pessoa responsável pela conta Mercado Livre acessar:

```
https://full.nastripack.com.br/auth/login
```

e autorizar com a própria conta. O sistema registra a loja automaticamente e redireciona para o dashboard dela. Rodar `/sync?loja=<ID>` (ou aguardar o cron horário) para a primeira sincronização.

## Decisões e lições aprendidas (vale ler antes de mexer)

- **`logistic_type=fulfillment` é obrigatório** na busca de itens (`/users/{id}/items/search`). Sem esse parâmetro, a API retorna o catálogo inteiro do vendedor (chegamos a ver ~2,4 milhões de resultados para uma conta com só 95 produtos no Full).
- **Limite de subrequests do Worker**: a sincronização usa o endpoint multiget (`/items?ids=...`, até 20 por chamada) em vez de buscar item por item, e processa no máximo 5 páginas por execução (resumível via `?offset=`), para não estourar o limite de subrequests por invocação.
- **Segredos colados no terminal**: no `cmd.exe` do Windows, `Ctrl+V` no prompt do `wrangler secret put` pode falhar silenciosamente (insere um caractere de controle em vez do texto). Sempre usar clique com o botão direito para colar, e nunca digitar o valor manualmente.
- **A chave secreta do app no Mercado Livre pode aparecer diferente a cada vez que a tela é reaberta** — copie e use na mesma sessão, sem recarregar a página no meio do caminho.
- **Basic Auth / proteção de acesso ao dashboard**: decidido por enquanto **não implementar** (feito para ficar simples). Como o dashboard já mostra dados reais de vendas de múltiplas empresas, isso deve ser revisitado antes de expor o link amplamente.
- **Estoque**: `GET /inventories/{inventory_id}/stock/fulfillment` (o `inventory_id` vem no payload do item, campo `item.inventory_id`) retorna `total`, `available_quantity` e `not_available_quantity`. Sem chamada extra por multiget — é uma chamada por produto.
- **Remessas ao Full**: `GET /stock/fulfillment/operations/search` com `type=INBOUND_RECEPTION`, `seller_id`, `inventory_id`, `date_from`/`date_to` (obrigatórios, formato ISO com `Z`, intervalo máximo de 60 dias). Esse endpoint tem uma **quota própria e restrita** (erro `"over_quota"` mesmo com poucas chamadas em sequência) — por isso a sincronização processa no máximo 8 produtos por execução, com uma pausa de ~1,2s entre chamadas, revezando (round-robin) os produtos há mais tempo sem checar. Com o cron horário, todos os produtos acabam cobertos ao longo do dia.
- **Custo de transporte das remessas (`valor_transporte`, `transportadora`)**: a API do Mercado Livre **não fornece** esse dado no endpoint de remessas — só quantidade e data. Fica como lacuna conhecida; precisará de entrada manual ou outra fonte quando a Fase 2/RF-016 (consolidação de custos de transporte) for implementada.

## Status (Fase 1 completa)

- [x] OAuth, multi-tenant, dashboard (individual + comparativo)
- [x] Sincronização automática (cron a cada 1 hora) com alerta por e-mail em falha
- [x] Produtos, vendas, **estoque** e **remessas (envios) ao Full** sincronizados — Banco Histórico completo conforme seção 7.1 do PRS
- [ ] Proteção de acesso ao dashboard (login/senha) — adiado de propósito
- [ ] Custo de transporte por remessa — não disponível via API do Mercado Livre, precisa de outra fonte
- [ ] Fase 2 do PRS: Motor Analítico, Planejador Inteligente de Envios, Projeção de Vendas
