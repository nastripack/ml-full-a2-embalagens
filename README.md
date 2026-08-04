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
    analytics.js       Motor Analitico: medias ponderadas, cobertura, prioridade, projecao, indice de saude (so le do D1)
    regras.js            Motor de Regras (Fase 3): interpreta os indicadores do Motor Analitico e gera missoes
    alertas.js          envio de e-mail via Resend em caso de falha
    sessao.js           token de sessao assinado (HMAC) + helpers de cookie, usado pela contracapa de login
  routes/
    auth.js            /auth/login, /auth/callback (OAuth do Mercado Livre - vincular uma loja)
    login.js           /login - contracapa de acesso ao site (e-mail+senha, separado do OAuth acima)
    sync.js            /sync - sincronizacao de rotina (rapida, janela curta, chamada pelo cron)
    backfill.js         /backfill-vendas, /backfill-remessas - historico profundo, manual, resumivel
    dashboard.js       /  - dashboard (visao geral, por loja, Planejador de Envios, resumo executivo, busca)
    missoes.js          /missoes - Central de Missoes (Fase 3): lista, marca executada/ignorada
    pesquisa.js          /pesquisa - Pesquisa Global de SKU: busca por SKU/MLB/nome, painel completo
    aptos.js             /aptos-full - Aptos para o Full: anuncios fora do Full com potencial de migracao
    saude.js           /saude - pagina operacional: status das sincronizacoes, nao e o dashboard de negocio
migrations/            scripts de migracao ja aplicados em producao (nao reaplicar)
schema.sql             schema completo, usado apenas em instalacoes novas (wrangler d1 execute)
scripts/backup-semanal.sh   export manual do D1 (mesma logica do workflow do GitHub Actions)
.github/workflows/backup-semanal.yml   backup automatico semanal do D1
backups/                    dumps SQL do D1, gerados automaticamente (nao editar a mao)
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

## Login e proteção de acesso (contracapa)

O dashboard (`full.nastripack.com.br`) fica atrás de uma "contracapa" em um subdomínio separado, `full2.nastripack.com.br`, com uma caixa central de e-mail + senha. É uma credencial única compartilhada (não multiusuário) — pensada para um micro-SaaS interno, sempre acessado do computador da empresa.

- **Como funciona**: `full2.nastripack.com.br` só serve a tela de login (`GET`/`POST /login`). Ao acertar e-mail/senha (comparados com os secrets `LOGIN_EMAIL`/`LOGIN_SENHA`), gera um cookie de sessão assinado (HMAC-SHA256, `src/lib/sessao.js`) com `Domain=.nastripack.com.br` — funciona nos dois subdomínios — e redireciona para `full.nastripack.com.br`. Qualquer requisição em `full.nastripack.com.br` sem cookie de sessão válido (inclusive `/sync`, `/saude`, `/backfill-*`, `/auth/login`) redireciona para a contracapa; o `scheduled()` do cron não passa por essa checagem, porque não usa `fetch()`.
- **Duração da sessão**: 400 dias (teto real que os navegadores aceitam para duração de cookie) — não expira "de verdade", mas depois desse prazo pede login de novo uma vez. `GET/POST /logout` limpa o cookie e funciona em qualquer host.
- **Setup**: além dos secrets já existentes, configurar:
  ```
  wrangler secret put SESSION_SECRET
  wrangler secret put LOGIN_EMAIL
  wrangler secret put LOGIN_SENHA
  ```
  E adicionar a rota do domínio customizado `full2.nastripack.com.br` no `wrangler.toml` (mesmo Worker e binding D1 de `full`, não é um projeto novo).
- **Simplificação de propósito**: senha guardada em texto simples num secret do Worker (sem hash) — aceitável para uma credencial única de admin, não escalaria para multiusuário real.

## Backup automático e saúde do sistema

- **`full.nastripack.com.br/saude`** — página operacional (não é o dashboard de negócio): mostra, por loja, se a última sincronização foi recente (verde) ou está atrasada há mais de 2h (vermelho, sinal de que o cron pode ter parado), e uma tabela com as últimas 30 sincronizações (duração, quantidades, erros). Link "Saúde do sistema" no topo da visão geral.
- **Backup semanal do D1**: `.github/workflows/backup-semanal.yml` roda toda segunda 9h (horário de Brasília) **no GitHub Actions** — não depende de nenhum computador específico estar ligado. Exporta o banco inteiro, mantém só os 8 backups mais recentes (~2 meses) na pasta `backups/`, e commita/envia sozinho. Precisa dos secrets `CLOUDFLARE_API_TOKEN` (permissão Account → D1 → Edit) e `CLOUDFLARE_ACCOUNT_ID` configurados em Settings → Secrets and variables → Actions do repositório. Pode disparar manualmente a qualquer momento pela aba Actions → "Backup semanal do D1" → "Run workflow".
- Pra rodar um backup avulso de uma máquina com `wrangler`/`git` já autenticados: `bash scripts/backup-semanal.sh`.

## Motor de Regras e Central de Missões (Fase 3, primeira fatia)

- **`src/lib/regras.js`** (Motor de Regras, PRS seção 9): interpreta os indicadores já calculados pelo Motor Analítico (`listarPlanejadorEnvios`) e aplica políticas — não calcula tendência nem indicador nenhum. Roda automaticamente ao final de cada `/sync?loja=X` (rotina e cron), sem chamada de API externa.
- **Regras implementadas**: cobertura crítica/alta com quantidade real a enviar → missão `reposicao` (RB-002/010); estoque parado com demanda real e cobertura > 30 dias → `armazenagem` (RB-003); produto sem giro nos últimos 60 dias com estoque parado → `baixa_relevancia` (RB-009); queda ≥10% no valor líquido por unidade (7 dias recentes vs 31-60 dias atrás) → `precificacao` (RB-004, só considera vendas a partir de 01/08/2026 por causa do bug de comissão corrigido nessa data).
- **Camada de "IA" (PRS seção 10) é texto por template**, não chamada a LLM (decisão do usuário) — as frases de cada missão são montadas a partir dos números reais do produto, no formato do exemplo do PRS.
- **`full.nastripack.com.br/missoes?loja=X`** (Central de Missões, PRS seção 12.3): lista as missões abertas por prioridade, com situação/motivo/impacto e botões para marcar `executada` ou `ignorada` (RF-020/RB-008 — fica registrado o histórico da decisão, não é aprendizado adaptativo de verdade).
- **Índice de Saúde da Operação** (`calcularIndiceSaude` em `analytics.js`) e o bloco de "Resumo executivo" aparecem no dashboard individual, junto com o link pra Central de Missões.
- **Bug real encontrado e corrigido antes de fechar esta fatia**: produtos com demanda quase nula (ex: 1 venda em 60 dias) e estoque zerado geravam missão "Crítico" recomendando "enviar 0 unidades" — contraditório. Corrigido: uma missão de reposição só é criada se a quantidade sugerida for maior que zero.
- **Deixado de propósito para depois**: desconto de ruptura recente na projeção (RB-005). `Aptos para o Full` (12.8) e `Pesquisa Global de SKU` (12.2) também ficam para uma próxima fatia.

## Gastos com Transporte (Fase 3, segunda fatia)

- **Fonte 100% automática via API** (sem upload de planilha, por decisão do usuário): `src/lib/mercadolivre.js` tem `getBillingPeriods`/`getBillingSummary`, que consultam `/billing/integration/monthly/periods` e `.../summary/details` (grupo `ML`, **`document_type=BILL` é obrigatório** nos dois — a API retorna erro 422 sem esse parâmetro, mesmo não estando claro na documentação pública).
- **`custos_transporte`** (nova tabela, upsert por `loja_id+periodo+label`): grava **todos** os tipos de cobrança retornados pela API a cada sync, não só transporte — é um subproduto útil (dá pra ver outras tarifas do Mercado Livre no mesmo lugar).
- **Rótulo confirmado em produção**: `"Custo do serviço de coleta Full"` — testado e validado batendo em centavos (R$ 139,50) com o total apurado manualmente na investigação anterior (17 coletas somadas na tela "Tarifas e cancelamentos").
- **Limitação conhecida (aceita pelo usuário)**: a API só dá o **total agregado por mês**, sem detalhamento por coleta individual. Não dá pra saber quanto custou uma remessa específica, só o total do período.
- **Seção "Gastos com Transporte (Coleta Full)"** no dashboard individual: custo do mês mais recente com dado disponível (pode não ser o mês corrente, se ainda não houve cobrança lançada), variação % vs. o mês anterior (quando há histórico dos dois), e custo médio por unidade enviada (cruzando com `envios` **do mesmo período do custo exibido** — importante não misturar meses diferentes nessa conta).

## Cinco ações pós-Fase 3 (auditoria da Fase 2 + módulos do PRS)

1. **Cron paralelo**: `scheduled()` (`src/index.js`) rodava todas as lojas em sequência num `for` — risco real de estourar o teto de execução do Worker com várias lojas conectadas. Trocado por `Promise.allSettled`, rodando todas em paralelo (I/O-bound, esperando resposta da API do ML). Cada falha continua isolada e dispara alerta por e-mail individualmente.
2. **Pedidos cancelados**: `getOrdersSearch`/`getOrdersSearchPage` (`src/lib/mercadolivre.js`) agora passam `order.status=paid` pra API — evita contar pedidos cancelados/não pagos como venda. Vale só daqui pra frente, sem expurgar vendas já gravadas.
3. **Inteligência de Precificação completa** (PRS 12.9): a missão de queda de valor líquido (`src/lib/regras.js`) agora também calcula impacto financeiro mensal estimado e sugere um novo preço pra preservar a margem anterior, usando o preço bruto e a taxa de tarifa atual (ambos já disponíveis na mesma consulta).
4. **Aptos para o Full** (PRS 12.8): vendas de anúncios fora do Full — antes descartadas — agora são gravadas em `vendas_fora_full` (dado que já vem de graça no `order_item`, sem chamada de API extra). `listarAptosParaFull` (`src/lib/analytics.js`) calcula um score 0-100 (regularidade + crescimento + estabilidade) por MLB, exposto em `/aptos-full?loja=X`. **Sem custo do produto cadastrado, não é possível calcular capital necessário em R$** — a tela mostra só a quantidade sugerida em unidades. **Bug corrigido após testar com dado real**: produtos com uma única venda isolada há mais de 60 dias recebiam score moderado (45) porque "sem dado" era lido como "estabilidade máxima" no cálculo do coeficiente de variação — corrigido para exigir pelo menos alguma venda nos últimos 60 dias.
5. **Pesquisa Global de SKU** (PRS 12.2): `/pesquisa?loja=X&q=texto` busca por SKU/MLB/nome e mostra um painel completo do produto (identificação, indicador de saúde, estoque, análise da IA/missões, envios, vendas, performance), reaproveitando dados e funções já existentes. Simulação de envio fica fora de escopo.

Formatação de números/moeda/data também foi corrigida nesta etapa: `toFixed(2)` produzia formato americano (`10002.69`) e datas apareciam em ISO (`2026-08-03`) — `formatarMoeda`/`formatarNumero`/`formatarData` (`dashboard.js`) agora usam `toLocaleString('pt-BR')` e reformatação de string em todas as telas.

## Auditoria completa do projeto (Planejador × anúncios inativos, sessão)

- **Só anúncios `active` entram no Planejador**: `listarPlanejadorEnvios` (`src/lib/analytics.js`) considerava os 95 produtos Full, mas **51 deles não estavam ativos** (49 pausados + 2 fechados). Havia 2 missões de "armazenagem" abertas para anúncios **fechados**, recomendando ação sobre algo que não pode mais ser vendido. Como Planejador, Motor de Regras e Índice de Saúde partem todos dessa mesma função, o filtro corrige os três de uma vez. Confirmado em produção: as 2 missões indevidas foram auto-resolvidas no sync seguinte.
- **Comparação de assinatura em tempo constante** (`src/lib/sessao.js`): a verificação do HMAC do cookie usava `!==` direto, que sai no primeiro caractere diferente e vaza por tempo de resposta quantos caracteres da assinatura estavam corretos. Trocado por `compararEmTempoConstante`, que sempre percorre a string inteira.

## Robustez da sincronização automática (fim dos e-mails de falha diários)

Motivo: a caixa de entrada recebia vários e-mails "[ML Full A2] Falha na sincronizacao" por dia. A investigação (feita sobre o dump real do D1 em `backups/`) mostrou que **não era um bug de dado, era falta de tolerância a falha transitória** na camada de integração.

**O que a trilha de eventos mostrou** (31/07 a 03/08): em 9 horas de cron o sync abortou sem gravar **nenhum** evento no banco — inclusive às 13:01 UTC de 03/08, que é exatamente o horário do primeiro e-mail recebido (10:01 BRT). As falhas vinham em rajadas de horas consecutivas (3h, 5h, 1h), o padrão típico de throttling/instabilidade da API do Mercado Livre. Além disso, 83 respostas HTTP 429 foram registradas no endpoint de remessas dentro de syncs que completaram.

**As três causas, e o que mudou:**

1. **`apiGet` (`src/lib/mercadolivre.js`) não tinha retry nenhum** — qualquer 429 ou 5xx isolado derrubava a chamada na hora. Agora tem retry com backoff exponencial (até 3 tentativas, 1s e 2s), respeitando o cabeçalho `Retry-After` quando presente e **limitando essa espera a 5s** para não comer o tempo de execução do Worker. Só repete o que é transitório (429 e 5xx); um 4xx real (403, 404) continua falhando de imediato, sem mascarar erro de programação.
2. **`searchUserItems` era a única chamada de API fora de `try/catch`** (`src/routes/sync.js`, etapa 1). Um 429 ali derrubava a sincronização inteira daquela hora — as etapas de vendas, estoque, visitas e faturamento nem chegavam a rodar, e como a exceção subia antes do primeiro `registrarEvento`, **não sobrava rastro nenhum no banco**: a página `/saude` continuava verde mostrando a última rodada boa. Agora a falha é registrada em `resumo.erros` e o sync segue; as etapas seguintes não dependem dessa lista (os produtos já estão no banco das rodadas anteriores).
3. **Todo erro virava e-mail imediatamente.** Agora uma falha total do sync grava o evento `sincronizacao_falhou` no D1 (aparece em `/saude`) e o e-mail só é disparado a partir de **3 falhas consecutivas** — ou seja, ~3h sem sincronizar, aí sim é problema de verdade. Falha isolada fica registrada, sem notificar. O contador (`contarFalhasConsecutivas`, `src/lib/db.js`) lê a própria trilha de eventos, sem estado extra.

**Teto de tempo de execução**: como o retry alonga a rodada, as etapas lentas (estoque/remessas, visitas, faturamento) agora param sozinhas em `LIMITE_EXECUCAO_MS` (130s), com folga para os ~180s em que a Cloudflare mata a execução. Melhor uma rodada incompleta — o cron roda de novo em 1h — do que uma execução morta que não grava nada. O valor foi calibrado sobre o `tempos_ms` real gravado no D1: uma rodada normal leva **entre 77s e 116s** (média 103s) e chega na etapa de faturamento por volta dos 95s — bem mais lenta do que parecia olhando só o intervalo entre os checkpoints, que mede a partir do primeiro checkpoint e não do início da rodada. Se essa medição mudar (mais produtos, mais lojas), **remeça antes de mexer nas janelas do sync**.

**`/saude` deixou de ser cega para falhas**: a tabela lista também as rodadas `sincronizacao_falhou`, com a mensagem de erro, e o contador de erros das rodadas concluídas mostra as mensagens ao passar o mouse.

## Decisões e lições aprendidas (vale ler antes de mexer)

- **API de Faturamento exige `document_type=BILL`** em `/billing/integration/monthly/periods` e em `.../summary/details` — sem esse parâmetro, os dois retornam erro 422 `MISSING_PARAMETER_ERROR`, algo que não estava claro na documentação pública consultada antes de implementar. Só foi descoberto testando ao vivo em produção (registrado no erro devolvido pela própria API).
- **`sale_fee` (comissão) fica dentro de `order_items[]`, não no pedido**: `inserirVenda` lia `pedido.sale_fee` (campo que não existe nesse nível), então `comissao` era sempre 0 e `valor_liquido` guardado era, na prática, igual a `valor_bruto` — em todas as 1.002 vendas sincronizadas até 31/07/2026. Corrigido para `item.sale_fee` (dentro de cada `order_item`). Por decisão do usuário, a correção vale **só a partir de agosto/2026** — os registros anteriores a essa data continuam com comissão zerada, sem backfill retroativo.
- **`/orders/search` precisa de `order.status=paid`**: sem esse parâmetro a sincronização contava qualquer pedido do período, incluindo cancelados e nunca pagos, inflando receita e a média diária do Planejador. Identificado na auditoria da Fase 2 e **corrigido** (ver "Cinco ações pós-Fase 3", item 2) — vale só daqui pra frente, as vendas já gravadas antes da correção não foram expurgadas.
- **`logistic_type=fulfillment` é obrigatório** na busca de itens (`/users/{id}/items/search`). Sem esse parâmetro, a API retorna o catálogo inteiro do vendedor (chegamos a ver ~2,4 milhões de resultados para uma conta com só 95 produtos no Full).
- **Limite de subrequests do Worker**: a sincronização usa o endpoint multiget (`/items?ids=...`, até 20 por chamada) em vez de buscar item por item, e processa no máximo 5 páginas por execução (resumível via `?offset=`), para não estourar o limite de subrequests por invocação.
- **Segredos colados no terminal**: no `cmd.exe` do Windows, `Ctrl+V` no prompt do `wrangler secret put` pode falhar silenciosamente (insere um caractere de controle em vez do texto). Sempre usar clique com o botão direito para colar, e nunca digitar o valor manualmente.
- **A chave secreta do app no Mercado Livre pode aparecer diferente a cada vez que a tela é reaberta** — copie e use na mesma sessão, sem recarregar a página no meio do caminho.
- **Proteção de acesso ao dashboard**: implementada como contracapa em subdomínio separado (`full2.nastripack.com.br`) com sessão via cookie assinado — ver seção "Login e proteção de acesso" acima. Adiada nas fases iniciais de propósito (ver histórico em `PLANO.md`), fechada antes de conectar mais lojas reais.
- **Estoque**: `GET /inventories/{inventory_id}/stock/fulfillment` (o `inventory_id` vem no payload do item, campo `item.inventory_id`) retorna `total`, `available_quantity` e `not_available_quantity`. Sem chamada extra por multiget — é uma chamada por produto.
- **Remessas ao Full**: `GET /stock/fulfillment/operations/search` com `type=INBOUND_RECEPTION`, `seller_id`, `inventory_id`, `date_from`/`date_to` (obrigatórios, formato ISO com `Z`, intervalo máximo de 60 dias). Esse endpoint tem uma **quota própria e restrita** (erro `"over_quota"` mesmo com poucas chamadas em sequência) — por isso a sincronização processa no máximo 8 produtos por execução, com uma pausa de ~1,2s entre chamadas, revezando (round-robin) os produtos há mais tempo sem checar. Com o cron horário, todos os produtos acabam cobertos ao longo do dia.
- **Custo de transporte das remessas (`valor_transporte`, `transportadora`)**: a API do Mercado Livre **não fornece** esse dado no endpoint de remessas — só quantidade e data. Fica como lacuna conhecida; precisará de entrada manual ou outra fonte quando o RF-016 (consolidação de custos de transporte) for implementado.
- **Visitas/performance**: `GET /items/visits?ids={um_item}&date_from=YYYY-MM-DD&date_to=YYYY-MM-DD` — só aceita 1 item por chamada (nada de multiget aqui). Não existe impressões nem posição de busca via API pública; `conversao` não é gravada na sincronização — é calculada sob demanda pelo Motor Analítico (cruzando visitas com vendas do mesmo período), pra não ficar um número desatualizado guardado no banco.
- **Cobertura de estoque quando não há vendas**: um SKU sem nenhuma venda no histórico tem "cobertura infinita" por definição (não faz sentido calcular ruptura pra algo que não vende) — isso o classifica automaticamente como "não enviar", nunca como crítico, mesmo com estoque zerado. Só entra como prioridade (crítico/alto/médio) quem tem histórico de vendas real e está com a cobertura ficando curta. Produtos sem histórico continuam sendo sincronizados normalmente a cada hora; assim que começarem a vender, entram no Planejador sozinhos, sem precisar mexer no código.
- **O Worker tem um teto de duração por requisição** (observado empiricamente por volta de 180 segundos — a Cloudflare mata a execução e devolve "error code: 1101"). Por isso o sync de rotina (`/sync`, rodado pelo cron a cada hora) usa uma **janela curta de vendas (7 dias)** — rápido o bastante pra nunca chegar perto do limite — e o histórico profundo (até 12 meses) é responsabilidade das rotinas de backfill separadas (`/backfill-vendas`, `/backfill-remessas`), que são resumíveis via `?offset=`/`?indice=` e feitas pra rodar em vários lotes pequenos, não numa chamada só. **Nunca aumente a janela de vendas do sync de rotina sem medir o tempo de execução antes.**
- **`/orders/search` não tem filtro de Full**: só `/users/{id}/items/search` aceita `logistic_type=fulfillment`. A busca de pedidos sempre traz **todos** os pedidos da loja (Full ou não) — o filtro pro Full é feito depois, no código, checando se o MLB do item já existe na tabela `produtos` (que só tem itens Full). Pra uma loja com catálogo grande, isso significa paginar por muitos pedidos irrelevantes até achar os do Full — aceitável para um backfill único, mas é por isso que o sync de rotina usa janela curta.
- **Uma remessa pode ter vários produtos**: o índice único de `envios` era `UNIQUE(loja_id, remessa)` e descartava silenciosamente produtos diferentes que vieram na mesma remessa física. Corrigido para `UNIQUE(loja_id, produto_id, remessa)` (ver `migrations/0004_fix_envios_unique.sql`). Se algum dia for mexer em unicidade de tabelas de histórico, pense sempre "isso pode se repetir legitimamente para uma combinação diferente de campos?" antes de restringir por um campo só.
- **Secrets do GitHub Actions também sofrem do mesmo problema de espaço/quebra de linha extra** ao colar (mesma causa dos secrets do `wrangler`, seção acima) — o erro nesse caso aparece como `Headers.set: "***" ... is an invalid header value` no log do workflow. Sempre copiar o token usando o botão de copiar da própria página (não selecionar o texto manualmente), e se precisar conferir, colar num editor de texto simples antes de colar no campo do secret.
- **Toda chamada à API do Mercado Livre precisa de retry, e nenhuma pode ficar fora de `try/catch`.** A API devolve 429/5xx em rajadas curtas que se resolvem sozinhas na rodada seguinte. Uma única chamada sem proteção (`searchUserItems`) foi suficiente para derrubar 9 sincronizações em 4 dias e encher a caixa de entrada de alertas. Ao adicionar uma etapa nova no sync, pergunte sempre: "se esta chamada falhar, o resto da sincronização ainda faz sentido?" — se sim, ela tem que estar em `try/catch` acumulando em `resumo.erros`, nunca deixando a exceção subir.
- **Erro que aborta antes do primeiro `registrarEvento` é invisível.** O sync só gravava evento a partir do primeiro checkpoint, então uma falha na etapa 1 não deixava rastro no D1 — a página `/saude` seguia verde enquanto o cron falhava de hora em hora. Diagnosticar isso só foi possível procurando **buracos** na sequência horária de eventos do dump do D1 (`backups/`), não lendo os erros gravados. Se for instrumentar uma rotina nova, registre a falha também, não só o sucesso.
- **Alerta que dispara em toda falha transitória vira ruído e esconde o problema real.** O alerta por e-mail agora exige 3 falhas consecutivas; falha isolada fica só em `/saude`. Vale a mesma regra para qualquer notificação nova: alerte sobre condição persistente, não sobre evento isolado.
- **Hora exibida no site ficava em UTC, 3h à frente de Brasília.** A formatação pt-BR anterior corrigiu a data (DD/MM/AAAA) mas não a hora — `datetime('now')` do SQLite/D1 sempre grava em UTC, e a tela mostrava esse valor cru. Corrigido em `formatarData` (`src/routes/dashboard.js`): desloca -3h (Brasil não tem horário de verão desde 2019, fixo o ano todo) só quando o valor tem hora de verdade (colunas `data_hora`); campos só-data (`envios.data`, `performance_historico.data`, gravados com `date('now')`) continuam sem deslocamento, porque não têm componente de hora pra converter com segurança.
- **Tarefa agendada precisa rodar em infraestrutura que não depende de uma máquina específica.** A primeira tentativa foi um Agendador de Tarefas do Windows local — só funciona se aquele computador específico estiver ligado e logado no horário, o que não serve quando quem cuida da operação usa outra máquina. GitHub Actions (ou outro runner na nuvem) é a escolha certa pra qualquer automação que precisa rodar "sempre", independente de quem está com o notebook ligado.

## Status (Fase 3 quase completa)

- [x] Fase 1: OAuth, multi-tenant, Banco Histórico completo (produtos, vendas, estoque, remessas), dashboard, cron + alerta por e-mail
- [x] Fase 2: sincronização de visitas/performance, Motor Analítico (`lib/analytics.js`: médias ponderadas por janela, tendência, cobertura, risco, sugestão de envio, projeção de vendas), Planejador Inteligente de Envios no dashboard
- [x] Histórico de 12 meses (vendas 100%, remessas parcial por quota), página de saúde do sistema, backup semanal automático (GitHub Actions)
- [x] Proteção de acesso ao dashboard (contracapa `full2.nastripack.com.br` + sessão via cookie assinado)
- [x] Fase 3 (1ª fatia): Motor de Regras (`lib/regras.js`), Central de Missões (`/missoes`), Índice de Saúde da Operação e Resumo Executivo no dashboard
- [x] Fase 3 (2ª fatia): Gastos com Transporte (RF-016/12.10) — custo real de Coleta Full via API de Faturamento, 100% automático, sem upload
- [x] Cron paralelo (multi-loja), filtro de pedidos pagos, Inteligência de Precificação completa (12.9), Aptos para o Full (12.8), Pesquisa Global de SKU (12.2)
- [x] Formatação de números/moeda/data no padrão brasileiro em todas as telas
- [x] Auditoria completa: Planejador/Missões/Índice de Saúde só consideram anúncios `active`; comparação de assinatura da sessão em tempo constante
- [x] Robustez da sincronização: retry com backoff na camada de API, nenhuma chamada fora de `try/catch`, falha registrada no D1 e visível em `/saude`, alerta por e-mail só após 3 falhas seguidas, teto de tempo de execução nas etapas lentas
- [x] Planejador: desempate por cobertura dentro da mesma prioridade e indicação de "mostrando X de Y" na tabela
- [x] Comissão de 20% (André Filho) — **descartada por decisão do usuário**: sem marco fixo de custo/preço de venda cadastrado em nenhum lugar, não dá pra calcular margem real (não é só falta de API, é falta de dado)
- [ ] Cron paralelo ainda não testado com mais de 1 loja de verdade (só a A2 Plásticos está conectada) — a correção foi feita preventivamente, mas falta validar na prática quando a 2ª loja entrar
- [ ] RB-005 (descontar ruptura recente da projeção de vendas) e simulação de envio (12.2/12.4) — itens menores do PRS ainda não implementados
- [ ] Backfill de remessas com cobertura parcial (quota da API) — pode ser re-executado depois pra capturar mais histórico, não é urgente
- [ ] Colunas `vendas.tarifa`, `vendas.frete` e `estoque_historico.em_transito` existem no schema mas nunca são preenchidas — resolver exige inspecionar o payload real de `/inventories/{id}/stock/fulfillment` e do pedido em produção antes de escrever qualquer código, para não gravar campo inventado. Sem impacto em nenhuma tela hoje
