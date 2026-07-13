# PROJECT.md — Fatos específicos deste projeto

> **Único arquivo que muda por projeto.** O resto da skill (SKILL.md + demais `references/*.md`) é o **padrão geral da empresa** — descreve *padrões e mecanismos*, válidos para qualquer backend Node.js da casa, e aponta pra cá quando precisa de um valor concreto. Ao copiar a skill para outro repositório, troque **este** arquivo; os outros ficam intactos.
>
> Regra de ouro: se um fato é **verdade só deste serviço** (nome, módulos de domínio, catálogo de permissões, inventário de erros, nomes de env/fila/bucket, comandos, ARNs), ele mora aqui — não espalhado nas referências gerais. A fonte da verdade executável continua sendo o **código** (`catalog.ts`, `env.ts`, `package.json`); este arquivo é o índice navegável.

---

## 1. Identidade

| Campo | Valor |
|---|---|
| Repositório | `rfp-backend` |
| Ambiente | **B2B Reservas** |
| Serviços irmãos | `b2b-users` (auth/Cognito), `agencies` (dados de empresa/chain), `hospitality` (hotel/v1) |
| `OTEL_SERVICE_NAME` | `rfp-project` |
| Região AWS | `sa-east-1` |
| Repo ECR | `951349605228.dkr.ecr.us-west-2.amazonaws.com/rfp-api` (conta `951349605228`, região ECR `us-west-2`) |
| Namespace CloudWatch | `B2BReservas/MyAppApi` |
| Prefixo SSM | `/myapp/<env>/` |

**Ambientes e URLs** (fornecido pela empresa):

| Ambiente | Backend (público, Cognito) | Backend (privado/VPN) | Frontend | Bucket front |
|---|---|---|---|---|
| Homolog | `https://rfp-api-homolog-gw.b2breservas.com.br` | — | `https://rfp-homolog.b2breservas.com.br` | `b2b-rfp-frontend-homolog` |
| Prod | `https://rfp-api-gw.b2breservas.com.br` | `https://rfp-api.privateb2breservas.in/health` (VPN) | `https://rfp.b2breservas.com.br` | `b2b-rfp-frontend-prod` |

Args do `deploy-docker-ecr-processor.sh`: `h` = homolog, `p`/`p2` = prod (mapeamento `p` vs `p2` ainda não confirmado).

**Módulos de domínio reais:** `rfp` (agregado principal, com filhos sob `children/`; **leitura creator-side** `GET /rfp/:id/hotels/:hotelAlphaId/proposal` (`rfp/routes/get-hotel-proposal/`, persona `WEB_USER`, escopada por company via `rfpReadScope` → 404 `RFP-T0001` fora de escopo) — a proposta negociada de um hotel na RFP: `hotel_policy` **ativa** (404 `RFP-T0014` se nenhuma) + preços `hotel_room_type` (FIXED `{value}`/`{formula}` → `resultValue`+`original`; DYNAMIC combina a base da view × markup `price` via `applyFormula` (`+ - * /`, `percent` /100, `/0`→base), expondo `resultValue`+`original`+`calculated`) + `rfp_policy`/payments (só `active`) + amenities por categoria (catálogo `hotelDb` por `amenityId` numérico) + `hotelDefaultPolicy` (`vw_hotel_default_policy`: description/minMaxLos/bookingWindow/paymentMethod/pet/currency/guestPolicy) + `hotelInfo` (`vw_hotel_info` — hotel+company+person ativos: images/type/about/taxpayerId/corporateName/contatos principais); objetos enriquecidos sempre presentes, campos null quando ausentes), `rfp-hospitality` (surface hotel-facing do RFP, consumida pelo sistema **hospitality** e separada por consumidor: `hotel-response`, `list-rfp-by-hotel`, `list-rfp-status-by-hotel`, `get-rfp-by-hotel` (`GET /rfp/by-hotel/:id?hotelAlphaIds=` — agregado escopado pelos hotéis do caller: cada cidade traz só os hotéis informados e cidades sem nenhum somem (participants/policy completos), 404 se a RFP não mira nenhum; sem escopo de company, IDOR-aceito como a lista); reusa repo/schema/presenter do `rfp` via `@/`; registrado antes de `rfpRoutes` p/ os estáticos `/rfp/by-hotel[/status]` vencerem `/rfp/:id`), `policy` (módulo HTTP `rfp-hospitality/policy/`, tabela `hotel_policy`; registrado por `rfpHospitalityRoutes`; políticas de tarifa ligadas a uma RFP via FK local `rfp_id` — cliente passa o `uuid` público da RFP, resolvido p/ o FK; escopada a exatamente um hotel **xor** chain (alphaId externo, sem FK; checado no service + check `policy_hotel_xor_chain_check`); colunas jsonb **tipadas** (Zod, request+response): a shape é autorada pelo sistema externo de hotel (`rate_policy`), então modelamos os campos conhecidos de cada uma (inferidos de payloads reais) como objetos **loose** (`z.looseObject`, extra keys preservadas) — drift é seguro (chaves extras desconhecidas passam intactas na validação de entrada e na serialização de saída via `serializerCompiler`, sem 500); numéricos são `z.number()` (nunca `z.number().int()`, p/ não dar 500 num float do hotel) e strings de domínio ficam `z.string()` (não literais). Subárvore i18n `LocaleText` (`PT_BR`/`EN_US`/`ES_ES`) reusada em `description`/`healthProtocolText`/`guestProtocolText`. As shapes nomeadas vivem em `policy.schema.ts` e alimentam tanto `CreatePolicyBody` (campo opcional; omisso → null) quanto `PolicyResponse` (`shape | null`, null até setado). No DB as colunas seguem **abertas** (`unknown`) — a tipagem vive só na borda HTTP. `mealPlan` (enum) e identidade/auditoria também tipados; `POST /policy` cria em lote uma policy por `hotelAlphaIds[]`/`hotelChainAlphaIds[]` (sempre DRAFT+active; `name` **não é do cliente** — derivado sempre dos selling points (POS) da RFP: `Tarifa Negociada - <names dos POS juntados por ", " em ordem de alphaId>`, lido do nosso DB (`rfp_selling_point`), degrada p/ `Tarifa Negociada` se a RFP não tem POS; um `name` enviado no body é descartado pelo Zod (o `z.object` default remove chaves não declaradas)), `GET /policy?rfpId=&hotelAlphaId=` resolve a policy efetiva do RFP+hotel: se há policy local (match exato, chains excluídas) retorna ela(s); senão faz fallback p/ a **default policy do hotel no `hotelDb`** (`hotel.uuid`→`hotel_id`→`hotel_rate_policy` default+active→`rate_policy`), mapeada na mesma shape unificada (`source: 'local'|'hotelDefault'`; campos só-locais `rfpId`/`type` ficam null no hotelDefault); 404 `POL-T0002` se nenhuma das duas; personas `HOTEL_ADMIN`/`HOTEL_CHAIN_ADMIN`), `rooms` (sob `rfp-hospitality/rooms/`; quartos+preços de um RFP+hotel — preços autorados só do nosso lado na tabela local `hotel_room_type` (chave `rfp_id`+`hotelAlphaId`+`roomTypeAlphaId`, upsert via índice único parcial); `GET /rooms?rfpId=&hotelAlphaId=` retorna `{mode, rooms[], rates[]}` dirigido por `rfp_policy.tariff_types`: `DYNAMIC` preenche `rates` (os `hotel_rate` `OTHER_RATE` do hotel, cada um com 1 `price` formula; **rates vencidas são omitidas** — `end_date` estritamente anterior a hoje UTC é filtrado no service `get-rooms`, `end_date` nulo = sem expiração); `FIXED` preenche `rooms` (**todos** os `room_type` ativos do hotel, sem filtro de classification, com preços por ocupação `sgl/dbl/tpl/qpl`); um RFP que carrega **os dois** preenche ambos (`mode: 'BOTH'`); sem `DYNAMIC` nem `FIXED` (ex. só `NET`/`COMISSIONED`, ou vazio) cai no fallback `rooms`. `mode` ∈ `ROOMS|DYNAMIC|BOTH`; lado não preenchido é array vazio; as duas leituras ao `hotelDb` correm em paralelo; preço nunca vem do hotelDb, vem preenchido do nosso DB se já existir; `PUT /rooms` upsert em lote (só os itens enviados); preços tipados estritos `{value}` xor `{formula}`; ambos escopam o lookup da RFP pela visibilidade do caller (`rfpReadScope` no GET, `rfpWriteScope` no PUT) → 404 `RFP-T0001` se RFP inexistente **ou fora do escopo** (sem escrita de preço cross-tenant); `hotelAlphaId` ainda não validado contra hotéis do caller (mesmo IDOR-aceito das leituras by-hotel); personas `HOTEL_ADMIN`/`HOTEL_CHAIN_ADMIN`), `users` (dono da identidade), `companies`, `hotel-wishlist` (captura de lead: `name`/`responsible_name`/`mail`/`cellphone`; só `POST /hotel-wishlist`, gate `WEB_USER`), `obt`, `amenities`, e os lookups **read-only servidos dos DBs externos** (via gateways `agencyDb`/`hotelDb`, ver §5): `cities`, `countries`, `states`, `esg-policies`, `meal-plans`, `hotels` (`GET /hospitality/cities/:cityId/hotels`, `:cityId` = **uuid** público da cidade — resolvido p/ o `city_id` numérico via tabela `city` no `hotelDb` e casado contra `address_principal -> 'location' ->> 'id'`; uuid inexistente ⇒ página vazia; paginado por cursor; com `?rfpId=` rankeia por fit ao RFP — os hotéis ativos da cidade são lidos da view via fetch **cacheado por cidade** (`createTtlCache`, ~60s, RFP-independent) e o **score é calculado em JS** (`scoring.ts` `scoreHotel`, fonte única — antes era duplicado em SQL), com pré-filtro que **descarta hotéis 0-fit** (nenhum match) quando o RFP exige ao menos uma dimensão; ordena+pagina pelo keyset composto `(score desc, hotel_id asc)` em memória; ver `docs/superpowers/specs/2026-06-10-hotel-score-js-cache-design.md` (fórmula: `2026-06-08-hotel-rfp-score-design.md`); e `GET /hospitality/hotels/rate-stats?hotelAlphaIds=&roomTypes=&rateType=` — min/max/avg das rates por tipo de quarto (SGL/DBL/TPL/QPL) por hotel + geral, lendo a view `rfp_view.vw_hotel_rate_value` no `hotelDb` (unpivot+extração `value`/`formula.resultValue` embutidos na view); persona hotel, IDOR-aceito); e `GET /hospitality/hotels/search?name=&limit=&cursor=` — busca hotéis ativos por **nome** (ILIKE substring sobre `vw_hotel_by_city`, sem view nova; keyset por `hotel_id`), persona `WEB_USER`; cada item traz name/classification/address + quartos (`vw_hotel_room_type`) + amenities agrupadas por categoria (catálogo `hotelDb` via `readByIds`, 1 batch por página); data-path coberto por unit do service, e2e cobre só auth/validação). **Não existe módulo `bookings`** — `bookings` é só o **exemplo ilustrativo** usado nas referências gerais pra ensinar os padrões (agregado neutro). Ao ler um doc geral, mapeie `bookings`/`create-booking` para o seu recurso real.

---

## 2. SLOs do projeto

Os alvos da empresa (em [`README.md`](./README.md) / [`PERFORMANCE.md`](./PERFORMANCE.md)) valem como default. Este projeto **não os sobrescreve** hoje:

| Métrica | Alvo | Limite |
|---|---|---|
| p99 latência (CRUD simples) | < 50ms | 100ms |
| Throughput (1 vCPU, leitura DB) | ≥ 20k req/s | — |
| Cold start | < 2s | 5s |
| Disponibilidade | 99.9% | — |

---

## 3. Catálogo de permissões (personas)

O **padrão** persona está em [`INTEGRATIONS.md`](./INTEGRATIONS.md#25-autorização-permissões--padrão-persona) e [`DECISIONS.md`](./DECISIONS.md#adr-022-padrão-persona-para-permissões-sem-ações-finas). Os **valores** deste projeto vivem em `src/shared/permissions/catalog.ts` (SSOT) — abaixo só o espelho navegável:

- **Sistema:** `HOTEL_API` — espelha o claim `authorities.HOTEL_API` que o Cognito entrega. Parseado para `HOTEL_API:<role>`.
- **Personas:** `APP_USER`, `WEB_USER`, `HOTEL_ADMIN`, `HOTEL_CHAIN_ADMIN`, `SYS_ADMIN`, `SYS_INTERNAL` (role serviço-a-serviço; carregada por tokens internos — `authorities.HOTEL_API` pode vir como string escalar, não só array).

Adicionar/remover persona = editar `catalog.ts` (+ User Pool). **Não** replique a lista em docs gerais — eles falam só do padrão.

> Exemplos em referências usando `HOSPITALITY:*` ou `BOOKING_VIEWER` são **ilustrativos** (personas fictícias de exemplo), não o catálogo real.

---

## 4. Erros — módulos (siglas) ativos

O **mecanismo** (formato `SIGLA-TNNNN`, factory, envelope, i18n) está em [`ERRORS.md`](./ERRORS.md). O **inventário completo** é o código: `src/shared/errors/catalog.ts` + `src/shared/errors/i18n/<locale>.json`. **Adicionar um código não exige editar doc nenhum** — só `catalog.ts` + os 3 locales.

Siglas em uso neste projeto (conveniência; `catalog.ts` manda):

| Sigla | Domínio |
|---|---|
| `AUTH` | autenticação / autorização |
| `RFP` | agregado RFP |
| `POL` | políticas de tarifa (módulo `policy`) |
| `ORG` | ciclo de vida de empresa |
| `SES` | envio de e-mail (gateway SES) |
| `SYS` | cross-cutting / sistema |

(`BKG` aparece em exemplos de docs gerais — é a sigla do `bookings` ilustrativo, não usada aqui.)

---

## 5. Gateways e env concretos

O **padrão** de gateway está em [`ARCHITECTURE.md` §4](./ARCHITECTURE.md) e [`INTEGRATIONS.md`](./INTEGRATIONS.md). O conjunto **deste** projeto (tipo `Gateways` em `src/types/fastify.ts`, montado em `buildDefaultGateways()`):

| Gateway | Função | Env relevante |
|---|---|---|
| `cognito` | verify de JWT (ID token) | `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID`, `AUTH_DEV_BYPASS_TOKEN_EXP` |
| `ses` | envio de e-mail via AWS SESv2 (`sendEmail`; fire-and-forget no caller — falha vira `SES.SEND_FAILED`/502, caller faz catch+log) | `AWS_REGION`, `SES_FROM_EMAIL`, `AWS_ENDPOINT_URL` (localstack em dev) |
| `agencies` | empresa/chain HTTP + proxy `corporate-groups/.../additional-data` (serviço interno) | `AGENCIES_BASE_URL`, `INTERNAL_TOKEN_SECRET` (secret — list e write usam token ENRICH do caller sob `BOOKING_API`, que recebe `SYS_INTERNAL` + a role extra `CUSTOMER_GROUP_ADMIN` via `EXTRA_SERVICE_ROLES`) |
| `hospitality` | hotel/v1 — agências atendidas + categorias de amenities + detalhe de hotel por alphaId (serviço interno) | `HOSPITALITY_BASE_URL`, `INTERNAL_TOKEN_SECRET` (secret — HS256 compartilhado, token REPLACE mintado por request com `iat` fresco) |
| `agencyDb` | **leitura read-only** do DB externo da agencies via views no schema `rfp_view` (Drizzle) | `AGENCY_DATABASE_URL` |
| `hotelDb` | **leitura read-only** do DB externo da hospitality via views no schema `rfp_view` (Drizzle) | `HOTEL_DATABASE_URL` |
| `companyContext` | resolve a empresa-raiz do caller a partir do `agencyDb` (`sub → system_user → main_company`, sobe até a raiz da chain); POS lazy | (usa `agencyDb`) |

Os gateways de serviços **internos** HTTP (agencies, hospitality) vivem sob `src/gateways/internal/` e compartilham a plumbing em `src/gateways/internal/shared/internal-client.ts` (`createInternalApiClient({ baseUrl, name })` — `getJson`/`postJson`/`postWriteJson`/`putJson`/`patchJson`/`deleteJson`; dois breakers `read`|`write`, sendo `putJson`/`postWriteJson`/`deleteJson` no breaker `write` sem retry). Primitivos de gateway sem rota HTTP ficam co-locados no gateway (ex. `hospitality/routes/rate-policies/` expõe `createDerivedPolicy`/`updatePolicyRules`/`createRate`/`createDerivedRate`/`createRateRoomTypes` + os primitivos de compensação `deactivateRate` (POST `.../rates/{id}/deactivate`, soft) e `deletePolicy` (DELETE `.../rate-policies/{id}`, hard) — sem controller proxy); a orquestração que os consome vive como vertical slice no módulo do lado que dispara a ação — ex. `src/http/api/rfp/routes/publish-policy/` (creator-side: publica a proposta aceita no sistema do hotel; `load-publish-context.ts` lê DB local + dedup do nome da policy derivada e da rate negociada contra os nomes já ativos no hotel — lidos por `hotel_uuid` das views `vw_hotel_rate_policy`/`vw_hotel_rate` — sufixo ` #N` a partir de `#2` quando colide; a descrição i18n da policy segue listando os POS, só o `name` muda; o service então faz os 5 writes não-idempotentes upstream sob um `try`, rastreando os ids de policy/rates criados, e em qualquer falha `rollback-publish.ts` desfaz em ordem reversa — desativa cada rate criada e **depois** deleta a policy (rates-antes-da-policy), best-effort; se uma compensação também falha, lança `RFP.PUBLISH_ROLLBACK_FAILED` (`RFP-T0020`) carregando os ids órfãos pra limpeza manual; senão o erro de publish original sobe com o estado externo limpo. O front chama publish **antes** de gravar a decisão ACCEPTED). Ver [`INTEGRATIONS.md` §5](./INTEGRATIONS.md#5-serviços-http-internos).

Os gateways de **leitura de DB externo** (`agencyDb`/`hotelDb`) vivem sob `src/gateways/external-db/`: pools `pg` read-only (`buildReadOnlyPool`, sessão forçada `default_transaction_read_only=on`) + Drizzle. **Sem acesso direto às tabelas dos serviços donos**: cada DB externo expõe views por caso de uso num schema dedicado `rfp_view` (só as colunas consumidas; filtros invariantes — `active`, type codes — embutidos, exceto `rfp_view.vw_user_company`, que mantém empresas inativas de propósito — o caller lê o flag e decide). O contrato é o DDL versionado em `src/gateways/external-db/{hotel,agency}/views.sql` (aplicado por role privilegiado/DBA **antes** do deploy; nosso role só precisa de `SELECT` nas views); `views.ts` espelha cada view via `pgSchema('rfp_view').view(...).existing()`. São aquecidos no boot (flag `warm`, ligada fora de `NODE_ENV=test`). Não há mais gateways `s3`/`sqs`/`sns`/`b2bUsers`/`datalake` no tipo `Gateways`.

Env completo + schema: `src/config/env.ts`. Var nova (required) precisa entrar **em todos** os setups de env (ver checklist em [`INTEGRATIONS.md` §8](./INTEGRATIONS.md)).

**Observabilidade — divergência do padrão geral.** O padrão da empresa ([`OBSERVABILITY.md`](./OBSERVABILITY.md), tabela stack da SKILL) é OTel + ADOT → X-Ray + CloudWatch. **Este serviço não usa X-Ray/ADOT**: o backend único é o **Sentry** (tracing + erros). `src/instrumentation.ts` (carregado via `--import` no boot) roda `Sentry.init` — só habilitado quando há `SENTRY_DSN` **e** `NODE_ENV` é `production`/`staging` (dev/test ficam silenciosos); `sendDefaultPii: false` (sem body/cookie/IP — os logs Pino já carregam o `payload` scrubbed pelo redact). O Sentry sobe o próprio OpenTelemetry, então o `trace_id`/`span_id` do logger (via `@opentelemetry/api`) continua correlacionando. O error-handler reporta **só 5xx** (bugs) ao Sentry via `captureException` (tags `code`+`route`, `user.id`=sub; 4xx não vão). `server.ts` dá `Sentry.close(2000)` no shutdown pra flushar. Env: `SENTRY_DSN` (secret, opcional — ausente = desabilitado), `SENTRY_RELEASE` (opcional, git SHA lido direto de `process.env`, não modelado no schema). O nome do serviço (campo `service` dos logs + nome do tracer/meter no Sentry) é a **constante** `SERVICE_NAME = 'rfp-api'` em `src/config/env.ts` — não é mais env (era `OTEL_SERVICE_NAME`); o deploy se distingue por `NODE_ENV`/`environment` do Sentry. `OTEL_EXPORTER_OTLP_ENDPOINT` também foi removido (export OTLP não é mais usado).

---

## 6. Identidade e bootstrap (específico)

O **padrão** (Cognito verify, gateway, lookup-vs-provision) está em [`INTEGRATIONS.md` §2](./INTEGRATIONS.md#2-autenticação--cognito). Os fatos deste projeto:

- **ID token, sem tenant.** O token real é um **ID token** (`token_use: "id"`): identidade = `sub`, username em `name`, roles em `authorities.HOTEL_API`. **Não há id de empresa/tenant no token.**
- **User vs empresa, resolvidos separados.** O **user** local é provisionado no 1º acesso por `sub` (`usersRepo.provisionCaller({ sub })`), em `GET /users/authenticated-user`; demais rotas fazem **lookup** (403 `AUTH-T0006` se não provisionado). A **empresa NÃO é mais provisionada/armazenada localmente**: é lida **ao vivo do DB externo da agencies** pelo gateway `companyContext` (`sub → system_user.main_company_id → company`, sobe até a raiz da chain). `GET /users/authenticated-user/company` expõe a empresa do caller (querystring `?address`/`?pos` opcionais).
- **`resolveCallerRoot`/`assertCallerRoot`** (em `users/user-company/company-context.ts`) validam a raiz: ausente → 403 `ORG.COMPANY_NOT_RESOLVED`; tipo que não é raiz de caller válida → 502 `SYS.BAD_GATEWAY`; raiz inativa → 403 `ORG.COMPANY_INACTIVE`. Tipos de caller: `CORPORATE_GROUP` | `AGENCY_CHAIN` | `TRAVEL_AGENCY`. As services de RFP usam `companyContext.resolve` para o scope (read/write) por persona.
- **gateway `agencies` HTTP** segue exigindo o token **CRU** em `Authorization` (sem `Bearer`) — senão 401 (`extractToken(req)` repassa). Hoje serve só o proxy de additional-data (`corporate-groups/:id/additional-data` GET/PATCH) e o oráculo `company-infos`; o bootstrap de empresa migrou para o `agencyDb`.

---

## 7. Comandos e gotchas (deste projeto)

Scripts completos em `package.json`. Cuidados:

- **`pnpm dev`** exige Docker (sobe Postgres + LocalStack). `pnpm dev:native` se Postgres já roda local.
- **`pnpm dev:reset` apaga o volume do DB** — não rode sem intenção.
- **`pnpm start`** requer `--import ./dist/instrumentation.js` (OTel); o script trata, mas lembre se invocar `node` direto.
- **`pnpm homolog` / `pnpm production`**: sobem o app local contra AWS homolog/prod real (compose dedicado + `docker/.env.{homolog,production}` gitignored). `production` aponta dados reais de cliente — ver [`DOCKER.md`](./DOCKER.md).
- **Migrations em prod**: ver [`OPERATIONS.md`](./OPERATIONS.md); não rodar `pnpm db:migrate` em prod manualmente.
- **`pnpm deploy:prod`** dispara PR de promoção; precisa aprovação manual no console AWS.
- **`pnpm aws:creds[:homolog]`** (`scripts/ses-creds.sh [arquivo]`): assume a `rfp-api-task-role` (profile `rfp-dev`) e grava as 3 creds temporárias (`AWS_ACCESS_KEY_ID`/`SECRET`/`SESSION_TOKEN`, expiram ~1h) no env file — `docker/.env` (default) ou `docker/.env.homolog`. Necessário só pra rodar o SES **real** localmente (gateway `ses`); em ECS a task role injeta as creds e o `SES_FROM_EMAIL` vem do env do deploy. Localmente também exige `SES_FROM_EMAIL` verificado (us-west-2) e `AWS_ENDPOINT_URL` ausente (senão LocalStack).
- **`scripts/deploy/deploy-docker-ecr-processor.sh <env> <profile>`** (build manual + push pra ECR, fornecido pela empresa): `<env>` ∈ `h`/`p`/`p2`, `<profile>` = nome do profile AWS. Faz só `docker build` + `docker push` pro repo `rfp-api` em `us-west-2` (tag `<env>.<yy-mm-dd-HHMM>`); **não** roda nada na EC2 (pull/run é etapa separada). Caminho normal continua sendo o pipeline (ver [`DEPLOYMENT.md`](./DEPLOYMENT.md)).

---

## 8. Status transitório

Estado atual que muda com o tempo (não é padrão, é fato de hoje):

- **Consumer SQS `booking-created` desabilitado** — comentado no boot (`server.ts`: `startBookingCreatedConsumer()` + `consumer.stop()`) até a subscription SNS→SQS + DLQ serem provisionadas. As três linhas relacionadas são descomentadas juntas.
- **Expiry de `rfp_hotel` sem schedule automático** — `POST /rfp/hotels/expire-overdue` faz o sweep de hotéis vencidos (`PENDING_HOTEL_RESPONSE`→`EXPIRED_HOTEL_RESPONSE` quando passou `created_at + days_until_offer`; `PENDING_RFP_CREATOR_RESPONSE`→`EXPIRED_RFP_CREATOR_RESPONSE` quando passou `awaiting_creator_since + days_until_decision`). Body opcional `{ rfpIds?: uuid[] }`: o front passa os ids que está exibindo (reconcilia junto de list/get, fora do hot path de leitura); o cron chama com body vazio `{}` (sweep global). Permissão `any: [WEB_USER, SYS_INTERNAL]` — um `WEB_USER` só expira hotéis de RFPs que ele pode escrever (filtro `rfpWriteScope`, evita IDOR cross-tenant); `SYS_INTERNAL` (o cron) varre global. Falta o **EventBridge Schedule diário (00:30)** que dispara o sweep global: adiado para PR de infra porque não há auth máquina-a-máquina inbound (prod valida ID token Cognito real; o único token `SYS_INTERNAL` hoje é o token mintado pelos gateways internos a partir de `INTERNAL_TOKEN_SECRET`, que é outbound). Definir o mecanismo de credencial do cron antes de provisionar o schedule.
