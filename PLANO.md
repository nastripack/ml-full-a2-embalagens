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

## Próxima fase (não iniciada)
Fase 2 do roadmap do PRS: Motor Analítico (médias ponderadas, cobertura de estoque), Planejador Inteligente de Envios, Projeção de Vendas.
