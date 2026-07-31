# Plano e histórico de decisões

> Este arquivo é uma cópia do plano de implementação usado durante o desenvolvimento com o Claude Code. Serve como registro histórico das decisões tomadas, para que qualquer sessão nova (em qualquer máquina) consiga se situar rapidamente. Para o estado atual resumido, veja o `README.md`.

# Plano — Sistema Mercado Livre Full (A2 Embalagens)

## Contexto
O usuário forneceu o PRS/SRS completo (`PRS_SRS_Mercado_Livre_Full_v1.docx`) descrevendo um "copiloto operacional" para Mercado Livre Full: banco histórico, motor analítico, motor de regras, camada de IA e interface (Dashboard Executivo, Central de Missões, Planejador de Envios, Projeção de Vendas, etc.).

Decisões já confirmadas pelo usuário:
- Stack: **Cloudflare Workers + D1** (mesma stack do projeto `nastripack-email-leads`).
- Pasta do projeto: **`C:\ml-full-a2-embalagens`** (nova pasta).
- Domínio: `nastripack.com.br` já gerenciado no Cloudflare → subdomínio alvo **`full.nastripack.com.br`**.
- Credenciais Mercado Livre: usuário ainda não tem — precisa criar aplicativo em developers.mercadolivre.com.br.

## Passo imediato (antes do plano de código)
Antes de desenhar a implementação em detalhe, é preciso garantir as credenciais da API do Mercado Livre, pois elas definem client_id/redirect URI usados no fluxo OAuth do código.

**Ação:** usar Claude in Chrome (navegador real do usuário, já logado em developers.mercadolivre.com.br) para:
1. Navegar até "Minhas aplicações" / "Criar aplicação" no menu do usuário.
2. Preencher: nome do app, descrição, escopos (`read`, `write`, `offline_access`), Redirect URI = `https://full.nastripack.com.br/auth/callback`.
3. Confirmar os valores com o usuário **antes** de clicar em criar/enviar (ação irreversível de criação de app + redirect URI fixo).
4. Após criação, reportar ao usuário o **App ID (Client ID)** obtido; o **Client Secret** deve ser tratado como segredo — não printar em texto simples desnecessariamente, orientar o usuário a guardá-lo com segurança (será usado depois como variável de ambiente/secret no Cloudflare Worker).

Nenhuma alteração de código ou infraestrutura será feita nesta etapa — é só a criação do aplicativo no painel do Mercado Livre.

## Status da etapa de credenciais (concluída)
- App criado em developers.mercadolivre.com.br: **"A2 Embalagens - Copiloto ML Full"**.
- **Client ID (App ID): `426032379212172`**.
- Client Secret: gerado, revelado na tela para o usuário guardar com segurança (não foi capturado em texto pelo assistente). Configurado como secret do Worker via `wrangler secret put`.
- Redirect URI configurada: `https://full.nastripack.com.br/auth/callback`.
- Fluxos OAuth: Authorization Code + Refresh Token (Client Credentials removido, PKCE não usado — client confidencial).
- Permissões concedidas: Usuários (leitura e escrita, fixo), Publicação e sincronização (leitura e escrita), Faturamento de uma venda (leitura), Métricas do negócio (leitura), Venda e envios de um produto (leitura). Sem acesso: Comunicações, Publicidade, Promoções. Nenhum tópico de webhook ativado.

Verificação do ambiente Cloudflare:
- `wrangler` autenticado via OAuth como `andrenastri@gmail.com`, conta `Andrenastri@gmail.com's Account` (id `77af7b099c76e9b8f1b2c613ae8a8b21`).
- D1 existentes na conta: `nastripack-email-leads-db` e `nastripack-remarketing` — nenhum conflito de nome com `ml-full-a2-embalagens-db`.

## Fase 1 — Fundação

Objetivo (roadmap do PRS, seção 20): estrutura do projeto, autenticação OAuth com o Mercado Livre, sincronização inicial de dados (Produtos, Vendas/Pedidos, Envios) para o Banco Histórico em D1, e um Dashboard Executivo básico. Motor Analítico, Motor de Regras e IA ficam para as Fases 2–3.

### Estrutura do projeto (segue o padrão de `nastripack-email-leads`)
```
C:\ml-full-a2-embalagens\
  package.json
  wrangler.toml
  schema.sql
  src/
    index.js
    lib/mercadolivre.js
    lib/db.js
    routes/auth.js
    routes/sync.js
    routes/dashboard.js
```

### Banco Histórico — entidades da seção 7.1 do PRS
- `produtos`, `estoque_historico`, `vendas`, `envios`, `performance_historico`, `eventos` (insert-only onde aplicável, conforme regra da seção 7.2), `ml_auth` (suporte técnico do OAuth).

### Fluxo OAuth e sincronização (seções 6, 11 do PRS)
1. `GET /auth/login` → redireciona para autorização do Mercado Livre.
2. `GET /auth/callback?code=...` → troca code por token, grava em `ml_auth`.
3. `lib/mercadolivre.js` centraliza refresh automático do token — nenhuma outra parte do código chama a API do ML diretamente (camada de Integração isolada, seção 6 do PRS).
4. `routes/sync.js` implementa o fluxo da seção 11: busca itens/pedidos novos, grava no Banco Histórico, monta resumo executivo.
5. `routes/dashboard.js` serve o Dashboard Executivo básico (seção 12.1).

## Status atual (Fase 1 em produção)
- Worker no ar em `full.nastripack.com.br` e `ml-full-a2-embalagens.andrenastri.workers.dev`.
- D1 `ml-full-a2-embalagens-db` criado e com schema aplicado (`database_id`: `9a3b708a-1f7f-459a-970e-c59734240f2b`).
- Login OAuth funcionando (loja `1055727709`, nickname "A2 PLASTICOS").
- Bug corrigido: `searchUserItems` precisa do filtro `&logistic_type=fulfillment` (sem ele, `/users/{id}/items/search` retornava o catálogo inteiro do vendedor, ~2,4 milhões de itens, não só o Full).
- Sincronização real: 95 produtos do Full, 7 vendas (60 dias), R$ 834,80 líquidos.
- Endurecimento pós-Fase 1: cron horário de sincronização automática, alerta por e-mail via Resend quando a sincronização falhar, paginação de pedidos corrigida (até 10 páginas). Proteção por senha (Basic Auth) foi **descartada por pedido do usuário** — tratar depois, numa etapa própria.

## Mudança de direção: arquitetura multi-tenant (múltiplas lojas no mesmo ambiente)

### Contexto
O objetivo final: `full.nastripack.com.br` hospedando **4 ou 5 contas PJ Full diferentes no mesmo ambiente**, cada uma vendo seu próprio dashboard individual, **mais uma visão comparativa entre lojas** (quem vende mais, quais produtos) — o que o PRS já previa (RNF-004, Fase 4 "Consolidação de múltiplas lojas e comparativos interlojas").

O aplicativo único no Mercado Livre Developers (`client_id 426032379212172`) já suporta isso nativamente — um app, vários vendedores autorizando via OAuth cada um com a própria conta. Não é preciso criar um app novo por cliente, nem duplicar o Worker/D1/subdomínio.

### O que mudou no código
1. **Schema**: `loja_id` em `produtos`, `estoque_historico`, `vendas`, `envios`, `performance_historico`, `eventos`. Unicidade de `produtos` = `UNIQUE(loja_id, mlb)`. Nova tabela `lojas` (registro de contas conectadas). Migrado via `migrations/0002_multi_tenant.sql` (dados existentes preservados, atribuídos à loja `1055727709`).
2. **`src/lib/db.js`**: todas as funções recebem `lojaId`. Nova função `upsertLoja`.
3. **`src/routes/auth.js`**: registra a loja em `lojas` e redireciona para `/?loja=<id>` (cada PJ cai direto no próprio dashboard ao logar).
4. **`src/routes/dashboard.js`**: com `?loja=X` mostra o dashboard individual; sem o parâmetro mostra a visão geral (lojas conectadas + ranking de vendas 30 dias + top produtos combinados).

### Pendente de propósito
- Controle de acesso ao site (login/senha próprio) — adiado a pedido do usuário.
- Motor Analítico/comparativos mais sofisticados (tendência, projeção) — Fase 2.

## Fase 1 fechada por completo: estoque e remessas

Revisão própria identificou que a Fase 1 estava incompleta: as tabelas `estoque_historico` e `envios` existiam no schema mas nunca eram alimentadas. Como a Fase 2 (Planejador Inteligente de Envios) depende diretamente desses dados, foram implementadas antes de avançar:

- **Estoque**: `GET /inventories/{inventory_id}/stock/fulfillment` (o `inventory_id` vem no item, campo `inventory_id`, adicionado a `produtos` via migração `0003_estoque_envios.sql`). Uma chamada por produto, sem custo extra de multiget.
- **Remessas**: `GET /stock/fulfillment/operations/search?type=INBOUND_RECEPTION` — descoberto via busca na documentação oficial (não estava óbvio via tentativa e erro). Requer `seller_id`, `inventory_id`, `date_from`/`date_to` (máx. 60 dias). Tem quota própria bem restrita — a sincronização limita a 8 produtos por execução com pausa entre chamadas, revezando quais produtos checar a cada rodada (round-robin pelos que estão há mais tempo sem verificação).
- **Lacuna conhecida**: custo de transporte da remessa (`valor_transporte`) e transportadora não são fornecidos por nenhum endpoint da API do ML — ficará null até definirmos outra fonte (ou entrada manual).

Verificado em produção: 69 registros reais em `estoque_historico`, sem mais erros de quota após o ajuste.

## Fase 2 — Motor Analítico, Planejador de Envios, Projeção de Vendas (concluída)

Mesmo padrão da Fase 1: revisão própria encontrou que `performance_historico` (visitas/conversão) também nunca era alimentada, apesar de a seção 12.4 do PRS exigir isso pro Planejador priorizar corretamente. Fechado antes de considerar a fase completa.

- **Visitas**: `GET /items/visits?ids={1 item}&date_from=YYYY-MM-DD&date_to=YYYY-MM-DD` — descoberto via busca (a doc geral menciona multiget, mas essa conta/app aceita só 1 item por chamada). Sem quota especial observada. `conversao`, `impressoes` e `posicao` não são gravados (não existem via API pública ou seriam recalculados sob demanda).
- **Motor Analítico** (`src/lib/analytics.js`): média diária ponderada por janela (7d=40%, 15d=30%, 30d=20%, 31-60d=10%, seção 8.2), classificação de tendência, cobertura em dias, classificação de prioridade (crítico/alto/médio/não enviar conforme RB-001/002/003), sugestão de quantidade de envio, projeção de vendas para 30 dias.
- **Bug real encontrado e corrigido antes de fechar a fase**: produtos sem nenhuma venda no histórico (média diária = 0) estavam sendo classificados como "Crítico" só por terem estoque zerado — o que é sem sentido de negócio (não há urgência em reabastecer o que não vende). Corrigido em `coberturaEmDias`: quando não há demanda, a cobertura é tratada como infinita (classifica como "não enviar"), não zero. Validado em produção: caiu de 49 falsos "críticos" para 2 reais + 2 "médio" coerentes.
- **Planejador Inteligente de Envios**: nova seção no dashboard individual, tabela com Produto, Estoque Full, Média diária, Cobertura, Sugestão de envio, Projeção 30 dias, Prioridade — só mostra quem precisa de atenção real.

## Fechamento de pontas soltas da Fase 2 + janela histórica de 12 meses (concluído)

Pedido do usuário: máximo de histórico possível (idealmente 12 meses), e fechar 3 pontas soltas identificadas na revisão (tendência/confiança calculadas mas não exibidas; projeção só de 30 dias; faltava o estado "volátil" na tendência). Todos os 3 pontos implementados em `src/lib/analytics.js` e `src/routes/dashboard.js`.

**Descoberta importante sobre limites de cada fonte:**
- Vendas (`/orders/search`): sem limite de 60 dias — mas **não tem filtro de Full** (`logistic_type`/`tags=fulfillment` testados, nenhum funciona), então busca todos os pedidos da loja (~4.781 em 12 meses pra essa conta) e filtra depois no código (por MLB já cadastrado como Full).
- Remessas (`/stock/fulfillment/operations/search`): confirmado limite rígido de 60 dias por chamada + quota própria restrita.
- Visitas (`/items/visits`): testado com 365 dias, funciona sem erro.

**Bug real causado por mim mesmo e corrigido**: ao estender ingenuamente a janela de vendas do sync de rotina para 365 dias, o tempo de execução do Worker passou de ~90s para ~184s e passou a bater num teto de duração da Cloudflare (`error code: 1101`, observado empiricamente por volta de 180s). Diagnosticado instrumentando `sync.js` com timers por fase e checkpoints gravados no D1 a cada item processado (permite ver o progresso mesmo se a execução morrer no meio, já que o resultado só é serializado no fim). Também achei e removi uma escrita de evento por produto individual (95 escritas extras no D1 por sincronização) que não agregava valor real.

**Correção arquitetural**: sync de rotina (`/sync`, cron horário) voltou a usar janela curta (vendas: 7 dias) — rápido, nunca chega perto do limite. Histórico profundo (12 meses) passou a ser responsabilidade de duas rotinas novas e separadas, **resumíveis e manuais**, seguindo o mesmo padrão já usado para o backfill de remessas: `src/routes/backfill.js` agora tem `handleBackfillVendas` (paginado via `?offset=`) e `handleBackfillRemessas` (via `?indice=`, em blocos de 60 dias). Rodadas via loop de shell até `concluido: true`.

**Segundo bug encontrado durante o backfill de remessas**: o índice único de `envios` era `UNIQUE(loja_id, remessa)`, mas uma remessa física pode conter vários produtos diferentes — o segundo produto de uma mesma remessa era descartado silenciosamente pelo `INSERT OR IGNORE`. Corrigido para `UNIQUE(loja_id, produto_id, remessa)` via `migrations/0004_fix_envios_unique.sql`. O backfill de remessas foi refeito do zero após a correção.

**Resultado final do backfill**: 997 vendas cobrindo exatamente os últimos 12 meses (31/07/2025 a 30/07/2026), sem erros. Remessas: 17 registros salvos (11 produtos distintos) — cobertura parcial porque a segunda rodada do backfill (após corrigir o índice) foi rodada logo em seguida da primeira, sem tempo pra quota do endpoint se recuperar, gerando bastante erro `over_quota`. Pode ser refeito mais tarde (`/backfill-remessas?loja=1055727709&indice=0`) pra capturar o que ficou de fora — não é urgente, o cron de rotina já mantém os últimos 60 dias sempre atualizados.

## Auditoria de riscos + endurecimento operacional (concluído)

Usuário pediu uma revisão dos riscos/pontas soltas do projeto e sugestões fora do escopo original. Levantados: falta de proteção de acesso (adiada, ver seção Fase 1), custo de transporte não disponível via API (fica pra quando a Inteligência de Precificação da Fase 3 entrar), teto de duração do Worker (já documentado), falta de backup e de visibilidade operacional. Os dois últimos foram resolvidos agora:

- **Backup semanal do D1**: primeira tentativa foi um Agendador de Tarefas do Windows local nesta máquina — usuário corrigiu que essa não é a máquina que quem cuida da operação vai manter ligada. Trocado por **GitHub Actions** (`.github/workflows/backup-semanal.yml`), que roda na infraestrutura do GitHub independente de qualquer computador. Precisa dos secrets `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID`.
  - **Mesmo bug de sempre, em lugar novo**: o token colado no secret do GitHub veio com espaço/quebra de linha extra (mesma causa raiz dos problemas com `wrangler secret put` na Fase 1), causando erro `Headers.set: invalid header value`. Resolvido gerando um token novo e copiando com o botão de copiar da página do Cloudflare em vez de selecionar manualmente.
  - Testado via `workflow_dispatch` (disparo manual): sucesso, commit `65f71be` feito por `github-actions[bot]`.
- **Página `/saude`**: visão operacional simples (não é o dashboard de negócio) lendo a tabela `eventos` — mostra card verde/vermelho por loja (sincronizou nas últimas 2h ou não) e tabela com as últimas 30 sincronizações, duração e erros. Já existiam todos os dados, só faltava expor.

## Login com contracapa (full2.nastripack.com.br) protegendo o dashboard (concluído)

Pedido do usuário: proteger o acesso com uma "contracapa" em subdomínio separado (`full2.nastripack.com.br`), caixa central de e-mail+senha; ao acertar, abre `full.nastripack.com.br`. Sessão sem expiração de propósito ("nunca fechar o login") — micro-SaaS interno, sempre acessado do computador da empresa.

**Ponto crítico identificado antes de implementar**: um redirecionamento simples de `full2` pra `full` não protege nada sozinho — sem checagem de sessão, dá pra pular a contracapa digitando o endereço direto. Por isso a implementação exige uma sessão de verdade (cookie assinado), não só uma tela seguida de redirect.

**Construído**:
1. `wrangler.toml`: segunda rota de domínio customizado, `full2.nastripack.com.br` (mesmo Worker, mesmo binding D1).
2. `src/lib/sessao.js`: `criarToken`/`verificarToken` com HMAC-SHA256 (`crypto.subtle`, secret `SESSION_SECRET`), formato `base64(email:expira).assinatura`, 400 dias (teto real aceito por navegadores para duração de cookie).
3. `src/routes/login.js`: `handleLoginPage` (GET, caixa central), `handleLoginSubmit` (POST, confere contra `LOGIN_EMAIL`/`LOGIN_SENHA`, gera cookie com `Domain=.nastripack.com.br` se bater), `handleLogout` (limpa cookie).
4. `src/index.js`: no início do `fetch()`, `full2.nastripack.com.br` serve só a tela de login; qualquer outro host checa o cookie de sessão antes de qualquer rota (`/`, `/auth/login`, `/auth/callback`, `/sync`, `/backfill-*`, `/saude`), redirecionando pra `full2` se inválido. `/logout` funciona em qualquer host. `scheduled()` não passa pelo `fetch()`, então o cron continua sem checagem de sessão (correto, não é uma requisição HTTP externa).

**Verificado em produção**: acesso direto a `full.nastripack.com.br/saude` sem cookie redireciona para `full2.nastripack.com.br/login`; credenciais erradas mostram "E-mail ou senha incorretos" sem criar cookie (confirmado via rede: POST retornou 401); credenciais corretas entram no dashboard e a sessão persiste entre visitas.

**Simplificado de propósito**: senha em texto simples num secret do Worker (sem hash) — aceitável para credencial única de admin, não escalaria para multiusuário real.

## Investigação: custo de transporte por remessa (RF-016) — achados antes da Fase 3

A A2 Embalagens **não usa transportadora própria** para reposição de estoque no Full — usa sempre a **Coleta Full** (serviço do próprio Mercado Livre), que sempre tem custo. Isso simplifica o problema do RF-016, mas o caminho não é a API:

- **API pública de Faturamento** (`/billing/integration/monthly/periods` → `/documents` → `/summary/details`) só retorna **totais agregados por tipo de cobrança no mês** (ex.: "Cargo por Mercado Envios"), sem granularidade por coleta individual (data/valor por remessa) — confirmado via documentação oficial. Não é utilizável para o que precisamos.
- O usuário encontrou manualmente no painel: `myaccount.mercadolivre.com.br/billing/cnc/charges-summary?searchTypes=CFCBE` → "Faturamento → Tarifas e cancelamentos", filtro "Custo do serviço de coleta Full" — mostra **cada coleta individualmente**, com data e valor (ex.: R$7,52, R$7,75, R$5,49...). Essa granularidade só existe nessa tela do painel interno, sem endpoint público equivalente.
- **Plano para a Fase 3**: se essa tela tiver exportação (CSV/Excel), a via de dados passa a ser **upload desse export**, casado por data com as remessas já sincronizadas em `envios` — muito mais simples de processar que PDF de DANFE (dado tabular estruturado). O upload de DANFE deixa de ser prioritário para custo (já que não há transportadora própria), mas continua útil como forma alternativa de conferência de produtos/quantidades por remessa, se algum dia precisar.
- **Confirmado**: em Faturamento → Resumo da fatura → aba "Relatórios", o relatório **"Faturamento do Mercado Livre"** (.xlsx) tem os dados. Testado com um export real (jul/2026): aba única `REPORT`, cabeçalho na linha 8, ~1.527 linhas no período. Colunas relevantes: `Data da tarifa`, `Número da tarifa` (identificador único da cobrança, serve pra deduplicar em reimportações), `Detalhe` (filtrar por `"Custo do serviço de coleta Full"`), `Valor da tarifa`. 17 linhas desse tipo encontradas no período testado, batendo com os valores vistos na tela "Tarifas e cancelamentos".
- **Limitação real encontrada**: nas linhas de "Custo do serviço de coleta Full", os campos que ligariam a uma remessa específica (`Número da venda`, `Número do envío`, `Código ML`) vêm **vazios** — só há data, número da tarifa e valor. Não existe um ID em comum com `envios.remessa`. Na Fase 3, o cruzamento com `envios` só poderá ser por **data** (agregado por dia/período), não por remessa individual — documentar isso como limitação conhecida no dashboard, não fingir uma precisão que os dados não sustentam.

## Auditoria da Fase 2 (pente-fino pedido pelo usuário)

Revisão completa de `analytics.js`, `dashboard.js`, `db.js`, `sync.js`, `mercadolivre.js` e `schema.sql` em busca de pontas soltas. Achados, em ordem de severidade:

1. **Bug crítico corrigido**: `inserirVenda` (`src/lib/db.js`) lia `pedido.sale_fee` para calcular a comissão, mas esse campo não existe no nível do pedido na API do Mercado Livre — vive em `order_items[].sale_fee`. Confirmado em produção: **1.002 de 1.002 vendas com comissão zerada**, ou seja, `valor_liquido` armazenado era, na prática, igual a `valor_bruto` desde o início do projeto (todo cartão de "Valor líquido" no dashboard superestimava a receita real). Corrigido para `item.sale_fee`. **Decisão do usuário**: corrigir só daqui pra frente (a partir de agosto/2026), sem backfill retroativo dos 1.002 registros já salvos com comissão zerada — ficam como estão, documentado aqui como limitação conhecida dos dados históricos anteriores a agosto/2026.
2. **Bug provável, não corrigido ainda**: `getOrdersSearch`/`getOrdersSearchPage` não filtram por `status` do pedido — pedidos cancelados/não pagos podem estar sendo contados como venda em `vendas`, inflando receita, ranking e a média diária ponderada do Planejador (o que subestimaria risco de ruptura). Não dá pra medir o impacto retroativamente porque `vendas` não guarda o status do pedido. Fica pendente de decisão do usuário.
3. **Risco arquitetural não testado**: `scheduled()` em `src/index.js` sincroniza todas as lojas em sequência numa única execução de cron. Funciona hoje com 1 loja só; com as 4-5 lojas planejadas, risco real de estourar o teto de duração do Worker (~180s) e as últimas lojas da lista pararem de sincronizar silenciosamente (o `try/catch` por loja não protege contra timeout da execução inteira). Resolver antes de conectar a segunda loja real.
4. **Melhorias baratas, não implementadas**: Planejador não tem ordenação secundária por `cobertura` dentro da mesma prioridade (ordem arbitrária entre itens igualmente críticos); tabela do Planejador corta em 20 itens sem indicar "mostrando X de Y"; colunas `vendas.tarifa`, `vendas.frete` e `estoque_historico.em_transito` existem no schema mas nunca são preenchidas (`em_transito` pode estar disponível na mesma chamada de `getStockFulfillment` que já fazemos, sem custo extra — vale checar o payload completo).

## Próxima fase (não iniciada)
Fase 3 do roadmap do PRS: Motor de Regras (políticas/alertas configuráveis) e camada de Inteligência Artificial (diagnósticos e recomendações em linguagem natural, consultando só o Banco Histórico + Motor Analítico + Motor de Regras — nunca a API do ML diretamente, seção 10.2 do PRS). Ao entrar nela, implementar também o upload do export de "Tarifas e cancelamentos" (custo de transporte por remessa, RF-016) conforme achados acima.
