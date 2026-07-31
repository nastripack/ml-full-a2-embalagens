# ML Full - A2 Embalagens

Copiloto operacional para Mercado Livre Full. Sincroniza produtos, vendas, estoque, remessas (envios) e visitas do Full de uma ou mais contas (multi-tenant) para um banco histórico, calcula indicadores (Motor Analítico) e exibe um dashboard executivo com Planejador Inteligente de Envios — visão individual por loja e uma visão comparativa entre lojas.

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
    mercadolivre.js    cliente da API do Mercado Livre (OAuth, items, orders, estoque, remessas, visitas)
    db.js              helpers de leitura/escrita no D1
    analytics.js       Motor Analitico: medias ponderadas, cobertura, prioridade, projecao (so le do D1)
    alertas.js          envio de e-mail via Resend em caso de falha
  routes/
    auth.js            /auth/login, /auth/callback
    sync.js            /sync - sincronizacao de rotina (rapida, janela curta, chamada pelo cron)
    backfill.js         /backfill-vendas, /backfill-remessas - historico profundo, manual, resumivel
    dashboard.js       /  - dashboard (visao geral, por loja, e Planejador de Envios)
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

## Backfill histórico (rodar uma vez por loja, para trazer até 12 meses)

O sync de rotina só cobre uma janela curta (últimos 7 dias de vendas, 60 dias de remessas). Para popular o histórico mais profundo pedido pelo usuário (idealmente 12 meses), rode manualmente e repetidamente até `concluido: true`:

```
/backfill-vendas?loja=<ID>&offset=0&paginas=5
/backfill-remessas?loja=<ID>&indice=0&lote=10
```

Cada chamada processa um lote pequeno e devolve `proximo_offset`/`proximo_indice` — chame de novo com esse valor até `concluido: true`. São dezenas de chamadas (a busca de pedidos não filtra por Full, ver abaixo), então o jeito prático é rodar num loop de shell com uma pequena pausa entre chamadas, não manualmente uma por uma.

**Resultado no ambiente de produção (A2 Plásticos, loja `1055727709`)**: `/backfill-vendas` completou 100% (4.781 pedidos verificados, 997 vendas Full inseridas, cobrindo os últimos 12 meses exatos, zero erros). `/backfill-remessas` completou mas com cobertura parcial (17 remessas em 11 produtos) — a quota do endpoint de remessas não se recupera rápido o suficiente pra rodar o backfill inteiro duas vezes seguidas sem gerar bastante `over_quota`. Pode rodar de novo mais tarde (`?indice=0`) pra capturar mais; o `INSERT OR IGNORE` garante que não duplica o que já foi salvo.

## Decisões e lições aprendidas (vale ler antes de mexer)

- **`logistic_type=fulfillment` é obrigatório** na busca de itens (`/users/{id}/items/search`). Sem esse parâmetro, a API retorna o catálogo inteiro do vendedor (chegamos a ver ~2,4 milhões de resultados para uma conta com só 95 produtos no Full).
- **Limite de subrequests do Worker**: a sincronização usa o endpoint multiget (`/items?ids=...`, até 20 por chamada) em vez de buscar item por item, e processa no máximo 5 páginas por execução (resumível via `?offset=`), para não estourar o limite de subrequests por invocação.
- **Segredos colados no terminal**: no `cmd.exe` do Windows, `Ctrl+V` no prompt do `wrangler secret put` pode falhar silenciosamente (insere um caractere de controle em vez do texto). Sempre usar clique com o botão direito para colar, e nunca digitar o valor manualmente.
- **A chave secreta do app no Mercado Livre pode aparecer diferente a cada vez que a tela é reaberta** — copie e use na mesma sessão, sem recarregar a página no meio do caminho.
- **Basic Auth / proteção de acesso ao dashboard**: decidido por enquanto **não implementar** (feito para ficar simples). Como o dashboard já mostra dados reais de vendas de múltiplas empresas, isso deve ser revisitado antes de expor o link amplamente.
- **Estoque**: `GET /inventories/{inventory_id}/stock/fulfillment` (o `inventory_id` vem no payload do item, campo `item.inventory_id`) retorna `total`, `available_quantity` e `not_available_quantity`. Sem chamada extra por multiget — é uma chamada por produto.
- **Remessas ao Full**: `GET /stock/fulfillment/operations/search` com `type=INBOUND_RECEPTION`, `seller_id`, `inventory_id`, `date_from`/`date_to` (obrigatórios, formato ISO com `Z`, intervalo máximo de 60 dias). Esse endpoint tem uma **quota própria e restrita** (erro `"over_quota"` mesmo com poucas chamadas em sequência) — por isso a sincronização processa no máximo 8 produtos por execução, com uma pausa de ~1,2s entre chamadas, revezando (round-robin) os produtos há mais tempo sem checar. Com o cron horário, todos os produtos acabam cobertos ao longo do dia.
- **Custo de transporte das remessas (`valor_transporte`, `transportadora`)**: a API do Mercado Livre **não fornece** esse dado no endpoint de remessas — só quantidade e data. Fica como lacuna conhecida; precisará de entrada manual ou outra fonte quando o RF-016 (consolidação de custos de transporte) for implementado.
- **Visitas/performance**: `GET /items/visits?ids={um_item}&date_from=YYYY-MM-DD&date_to=YYYY-MM-DD` — só aceita 1 item por chamada (nada de multiget aqui). Não existe impressões nem posição de busca via API pública; `conversao` não é gravada na sincronização — é calculada sob demanda pelo Motor Analítico (cruzando visitas com vendas do mesmo período), pra não ficar um número desatualizado guardado no banco.
- **Cobertura de estoque quando não há vendas**: um SKU sem nenhuma venda no histórico tem "cobertura infinita" por definição (não faz sentido calcular ruptura pra algo que não vende) — isso o classifica automaticamente como "não enviar", nunca como crítico, mesmo com estoque zerado. Só entra como prioridade (crítico/alto/médio) quem tem histórico de vendas real e está com a cobertura ficando curta. Produtos sem histórico continuam sendo sincronizados normalmente a cada hora; assim que começarem a vender, entram no Planejador sozinhos, sem precisar mexer no código.
- **O Worker tem um teto de duração por requisição** (observado empiricamente por volta de 180 segundos — a Cloudflare mata a execução e devolve "error code: 1101"). Por isso o sync de rotina (`/sync`, rodado pelo cron a cada hora) usa uma **janela curta de vendas (7 dias)** — rápido o bastante pra nunca chegar perto do limite — e o histórico profundo (até 12 meses) é responsabilidade das rotinas de backfill separadas (`/backfill-vendas`, `/backfill-remessas`), que são resumíveis via `?offset=`/`?indice=` e feitas pra rodar em vários lotes pequenos, não numa chamada só. **Nunca aumente a janela de vendas do sync de rotina sem medir o tempo de execução antes.**
- **`/orders/search` não tem filtro de Full**: só `/users/{id}/items/search` aceita `logistic_type=fulfillment`. A busca de pedidos sempre traz **todos** os pedidos da loja (Full ou não) — o filtro pro Full é feito depois, no código, checando se o MLB do item já existe na tabela `produtos` (que só tem itens Full). Pra uma loja com catálogo grande, isso significa paginar por muitos pedidos irrelevantes até achar os do Full — aceitável para um backfill único, mas é por isso que o sync de rotina usa janela curta.
- **Uma remessa pode ter vários produtos**: o índice único de `envios` era `UNIQUE(loja_id, remessa)` e descartava silenciosamente produtos diferentes que vieram na mesma remessa física. Corrigido para `UNIQUE(loja_id, produto_id, remessa)` (ver `migrations/0004_fix_envios_unique.sql`). Se algum dia for mexer em unicidade de tabelas de histórico, pense sempre "isso pode se repetir legitimamente para uma combinação diferente de campos?" antes de restringir por um campo só.

## Status (Fase 2 completa)

- [x] Fase 1: OAuth, multi-tenant, Banco Histórico completo (produtos, vendas, estoque, remessas), dashboard, cron + alerta por e-mail
- [x] Fase 2: sincronização de visitas/performance, Motor Analítico (`lib/analytics.js`: médias ponderadas por janela, tendência, cobertura, risco, sugestão de envio, projeção de vendas), Planejador Inteligente de Envios no dashboard
- [ ] Proteção de acesso ao dashboard (login/senha) — adiado de propósito
- [ ] Custo de transporte por remessa — não disponível via API do Mercado Livre, precisa de outra fonte
- [ ] Fase 3 do PRS: Motor de Regras (alertas configuráveis) e camada de IA (diagnósticos e recomendações em linguagem natural)
