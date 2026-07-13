# DECISIONS.md — ADRs (Architecture Decision Records)

> Por que escolhemos cada peça. Use isso quando perguntarem "por que não X?" — a resposta provavelmente está aqui. Decisões podem ser revisadas; quando forem, atualize a seção correspondente com data + motivo.

---

## ADR-001: Node.js 22, não Bun nem Deno

**Decisão:** Node.js 22 LTS.

**Por quê:**
- LTS até abril de 2027 — alinhado com ciclo de manutenção corporativo.
- Ecossistema mais maduro: drivers, observability, AWS SDK, todas as libs do projeto.
- Bun ainda imatura em corner cases (compatibilidade de algumas libs, débito de stack traces, integração com OTel não-trivial).
- Deno tem boa DX mas adoção menor; menos talento no mercado.

**Revisão:** Reavaliar Bun em 2027 quando Node 22 sair de LTS.

---

## ADR-002: pnpm, não npm nem yarn

**Decisão:** pnpm 9.

**Por quê:**
- Instalação 2-3x mais rápida (store global + hardlinks).
- Lockfile determinístico e legível.
- Workspaces nativos com isolamento real (sem hoist surpresa).
- Strict por padrão: módulos não declarados em `dependencies` não são acessíveis.

**Não afeta produção.** A imagem Docker final só carrega `node_modules` resolvido — Node não sabe nem se importa que pnpm gerou aquilo. pnpm é ferramenta de **build time**, não de runtime.

---

## ADR-003: Fastify, não Express, Hono ou Nest

**Decisão:** Fastify 5.

**Por quê:**
- ~2x throughput de Express em benchmarks reais.
- Schema-first nativo com pipeline de validação + serialização **plugável** — trocamos os compilers default por `validatorCompiler`/`serializerCompiler` do `fastify-type-provider-zod` (ver ADR-004).
- Plugin system encapsulado — sem global pollution.
- TypeScript de primeira classe.

**Não Hono:** focado em edge runtimes (Cloudflare Workers, Bun). Em Node tradicional, Fastify é melhor.

**Não NestJS:** decorators + DI container são overhead conceitual sem ganho de performance. Estamos buscando o oposto: menos indireção, mais explícito.

**Não Express:** projeto inteiro em modo manutenção, sem schema integrado, performance inferior.

---

## ADR-004: Zod 4, não TypeBox nem class-validator

**Decisão:** Zod 4 (`import { z } from 'zod/v4'`) como linguagem de validação HTTP, plugado no Fastify via `fastify-type-provider-zod` (`validatorCompiler` + `serializerCompiler`).

**Por quê:**
- **Uma única linguagem de validação ponta a ponta.** O frontend já valida com Zod (React Hook Form + resolver Zod, validação de env). Adotar Zod no backend dá **um só modelo mental** para schemas em todo o stack — sem traduzir entre dois dialetos de schema (TypeBox no back, Zod no front).
- **DX e inferência de tipos superiores.** `z.infer<typeof X>` e a API fluente (`z.object({ x: z.string() })`) são mais ergonômicas; o autocomplete e as mensagens de erro do Zod são melhores no dia a dia.
- **Zod 4 fechou boa parte do gap.** A v4 trouxe ganhos grandes de performance sobre a v3 **e** export de JSON Schema de primeira classe (`z.toJSONSchema()`), então os schemas continuam alimentando OpenAPI/Swagger — agora via `jsonSchemaTransform` do type provider, sem manter schema duplicado.
- **Caminhos compilados de validação e serialização.** O `fastify-type-provider-zod` fornece `validatorCompiler` (validação) e `serializerCompiler` (serialização de resposta) — o Fastify não cai no `JSON.stringify` genérico.

**Trade-off honesto (performance):** a validação em runtime do Zod é **mais lenta** que os validadores JIT-compilados do TypeBox+Ajv. **Não escolhemos Zod por ser mais rápido** — ele não é. Aceitamos o custo porque: (a) Zod 4 é dramaticamente mais rápido que Zod 3 e o `serializerCompiler` cobre a serialização de resposta; (b) validação **raramente é o gargalo de p99** — o custo dominante é DB/rede; (c) para os SLOs do projeto (ver [`PERFORMANCE.md`](./PERFORMANCE.md)) a diferença fica dentro da margem em endpoints realistas. O ganho de ter **uma linguagem só** compartilhada com o frontend supera o custo.

**Não class-validator:** decorators + reflect-metadata + classes acoplam validação a model. Zod é functional, separado.

---

## ADR-005: Drizzle ORM, não Prisma nem TypeORM

**Decisão:** Drizzle + pacote `pg`.

**Por quê:**
- Compila pra SQL direto. Sem query engine separado (Prisma roda binary Rust adjacente — overhead de IPC).
- TypeScript-first com inferência real (`$inferSelect`, `$inferInsert`).
- API próxima de SQL — devs com Java/JPA pegam rápido.
- Suporta queries cruas tipadas quando necessário.

**Não Prisma:** mais "framework" (CLI, schema custom, generated client). Migrations menos flexíveis. Performance de query engine pior em alguns cenários.

**Não TypeORM:** decorators, herança, magia. Tipos fracos. Bugs históricos.

**Não Kysely:** próximo, mas Drizzle tem ecossistema maior, migrations integradas, e a empresa precisa de **um único padrão**.

---

## ADR-006: OpenTelemetry + ADOT, não X-Ray SDK direto

**Decisão:** OTel SDK no app + ADOT Collector exportando pra X-Ray e CloudWatch.

**Por quê:**
- **Vendor-neutral.** Se a empresa adotar Datadog/Grafana/New Relic amanhã, trocamos config do Collector — código não muda.
- AWS X-Ray SDK é legado; a própria AWS recomenda OTel via ADOT pra novos projetos.
- Auto-instrumentation OTel para Fastify, pg, undici, aws-sdk é melhor mantida.
- Logs/traces/métricas no mesmo SDK, com correlação automática.

**Não Sentry sozinho:** focado em erros; falta métricas e traces de forma unificada.

**Não Datadog direto:** vendor lock-in + custo. Se vier um dia, ADOT já manda pra lá.

---

## ADR-007: Pino, não Winston nem Bunyan

**Decisão:** Pino.

**Por quê:**
- Logger mais rápido do ecossistema Node (~5x Winston).
- JSON nativo, ideal pra CloudWatch Logs / ELK / Datadog.
- Integração nativa com Fastify.
- Redact built-in.
- Bindings via formatter (injetamos `trace_id` automaticamente).

**Não Winston:** lento, multi-transport sync que bloqueia.

**Não console.log + pretty:** sem nível, sem estrutura, parsing horrível em queries de log.

---

## ADR-008: SQS, não Redis BullMQ nem RabbitMQ

**Decisão:** AWS SQS (filas) + SNS (fan-out).

**Por quê:**
- Managed. Sem operar broker.
- DLQ nativa.
- Integração natural com IAM, CloudWatch, Lambda.
- Escala "infinita" (do ponto de vista do app).

**Não BullMQ/Redis:** Redis vira gargalo. Persistência de mensagens problemática em outage.

**Não RabbitMQ/Kafka:** overkill operacional. Adote quando precisar de ordering estrito por chave + replay (Kafka), throughput de 100k+ msg/s sustentado, ou roteamento complexo (Rabbit).

---

## ADR-009: AWS Cognito (JWT-only), nunca senha local

**Decisão:** Cognito é a fonte da verdade da identidade. App apenas **verifica JWT** via JWKS.

**Por quê:**
- Cognito já é o IdP do ambiente B2B Reservas.
- Não ter senha no banco elimina classe inteira de incidentes (vazamento, hash desatualizado, regulamentação).
- Acoplamento mínimo: Cognito mudar provider/configuração não afeta o app além do gateway.

**Local existe?** Sim, tabela `users` referenciando `cognito_sub`. Mas sem senha, sem credencial.

**Em dev:** modo dev aceita JWT HS256 com chave compartilhada (rejeitado em qualquer outro NODE_ENV). Veja [`DOCKER.md`](./DOCKER.md#cognito-em-dev-problema-e-solução).

---

## ADR-010: Vitest, não Jest nem node:test

**Decisão:** Vitest.

**Por quê:**
- 2-3x mais rápido que Jest em workloads típicos.
- ESM nativo (sem o pesadelo `transform`/`jest-config` em projetos modernos).
- API quase 100% compatível com Jest — migração trivial.
- Workspaces nativos (separamos unit/integration/e2e).
- TypeScript via SWC, configuração via Vite — DX excelente.

**Não Jest:** lento, problemas com ESM, hot reload ruim.

**Não node:test:** built-in é OK para projetos pequenos; falta ecossistema (matchers, snapshots, coverage opinions, mocking) para uso corporativo.

---

## ADR-011: Biome, não ESLint + Prettier

**Decisão:** Biome.

**Por quê:**
- Lint + format em uma ferramenta. Sem conflito de regras.
- Escrito em Rust. ~10x mais rápido que ESLint+Prettier combinados.
- Configuração mínima.
- Suporte first-class a TypeScript.

**Trade-off:** menos plugins que ESLint. Para o que precisamos (TS strict + estilo consistente), Biome cobre.

**Não Rome:** descontinuado (Biome é o fork mantido).

---

## ADR-012: undici, não axios nem node-fetch

**Decisão:** undici (built-in no Node 18+).

**Por quê:**
- Built-in. Zero deps.
- Cliente HTTP/1.1 mais rápido do ecossistema.
- Pool e dispatcher configuráveis por upstream.
- Streaming nativo.

**Não axios:** sync XHR-style, sem pool real, deps pesadas.

**Não node-fetch:** wrapper sobre `http` core, menos performático.

---

## ADR-013: EC2 + CodeDeploy, não ECS, Fargate, ou Lambda

**Decisão:** EC2 com containers Docker rodando via CodeDeploy.

**Por quê:**
- A empresa **já usa EC2** para os outros serviços Java. Padronização operacional.
- Controle total sobre processo, sysctls, threading.
- Sem cold starts.
- Custo previsível (vs Fargate por vCPU/RAM).
- ALB + ASG + CodeDeploy = blue/green nativo com rollback automático.

**Não ECS/Fargate:** seria opção válida — economiza operação de OS. Reavaliar se time decidir padronizar fora de EC2. Os docs ficam praticamente iguais (só muda `appspec.yml`).

**Não Lambda:** modelo errado pra API stateful com pool de conexão DB. Cold start + limite de conexão DB = anti-padrão.

**Não Kubernetes:** complexidade operacional desproporcional ao tamanho do time/projeto.

---

## ADR-014: AWS CDK (TypeScript), não Terraform nem CloudFormation puro

**Decisão:** AWS CDK em TypeScript.

**Por quê:**
- **Mesma linguagem do projeto.** Devs editam infra sem trocar de contexto.
- Constructs de alto nível encapsulam best practices (ex: `ApplicationLoadBalancer` + targets + listeners já vem configurados).
- Saída é CloudFormation — auditável, gerenciado pela AWS.
- Diff/preview nativo (`cdk diff`).

**Não Terraform:** ótimo, mas linguagem HCL adicional + state file próprio (mais um lugar pra dar problema). Se a empresa padronizou em Terraform, troca-se — docs ficam quase iguais.

**Não CloudFormation YAML puro:** verbose demais. Sem laços/composição.

**Não Pulumi:** próximo do CDK; preferimos CDK por ser nativo AWS.

---

## ADR-015: Vertical Slice + sem DI container

**Decisão:** Pasta por caso de uso (`src/http/api/bookings/create-booking/`), com controller + service + schema fundidos em arquivos simples. Sem DI container.

**Por quê (vertical slice):**
- Tudo de um caso de uso fica junto. Adicionar/remover/refatorar feature mexe em uma pasta só.
- Reduz acoplamento horizontal (controller layer, service layer, etc — mudança numa "camada" exigiria mexer em N arquivos espalhados).
- Familiar pra quem vem de Spring Boot moderno (Spring também migrou pra esse modelo).

**Por quê (sem DI container):**
- Em TypeScript funcional, "container" só serve pra trocar dependência em teste. Resolvemos isso de forma mais simples:
  - Singletons importados (`db`, `logger`) — globais por natureza.
  - Gateways externos via `app.gateways` decorator do Fastify — sobrescritíveis em teste.
- Sem `@Injectable`, sem `reflect-metadata`, sem ordem de imports importar.

**Por quê (controller + route num arquivo):**
- Fastify já é route-based. Separar em dois arquivos só duplicava boilerplate.
- 95% dos handlers são finos. Quando crescer, dá pra extrair sem refactor estrutural.

**Por quê (service como função, sem `.execute`):**
- `class XService { execute() }` veio do Java pra DI funcionar. Em TS, função exportada é igualmente testável e tem menos cerimônia.
- `await createUser(input)` lê mais natural que `await new CreateUserService(deps).execute(input)`.

**Trade-off:** quem vem de Spring Boot ortodoxo estranha. Mitigado pelo ARCHITECTURE.md explicar o "porquê" extensamente.

---

## ADR-016: TypeScript strict + sem `any`

**Decisão:** `strict: true`, `noUncheckedIndexedAccess`, sem `any`, `as` casual proibido.

**Por quê:**
- Maioria dos bugs em runtime que Node produz vem de `null`/`undefined` ou tipo errado. Strict elimina classe inteira.
- Custo upfront pequeno; payback enorme.

**Trade-off:** mais código defensivo. Tempo de onboarding levemente maior pra quem vem de JS dinâmico.

---

## ADR-017: Tests em 3 níveis (unit / integration / e2e) + Testcontainers

**Decisão:** Vitest com workspaces. Unit mockado. Integração contra Postgres real (Testcontainers). E2E via `fastify.inject` + gateways fakes.

**Por quê:**
- Mockar Drizzle é teatro: o que se testa não é o comportamento real do SQL.
- Testcontainers dá Postgres real em ~5s no CI. Confiável.
- E2E via `fastify.inject` é rápido (sem TCP) e isolado.
- Gateways via `app.gateways` deixam e2e fáceis de configurar.

**Trade-off:** integração mais lenta que unit. Mitigamos paralelizando workers Vitest e compartilhando container.

---

## ADR-018: Distroless + non-root + multi-stage Docker

**Decisão:** `gcr.io/distroless/nodejs22-debian12:nonroot` na imagem final.

**Por quê:**
- Sem shell, sem coreutils, sem pacotes — superfície de ataque mínima.
- Imagem final ~80MB vs ~300MB de `node:slim`.
- `nonroot` por padrão (UID 65532).

**Trade-off:** sem shell pra debug em produção. Mitigamos com logs estruturados ricos + traces. Em emergência, criar imagem `*-debug` com `busybox` pode resolver casos extremos.

---

## ADR-019: LocalStack pra dev, não AWS real

**Decisão:** Dev local usa LocalStack (S3, SQS, SNS) via Docker Compose. Cognito mockado por flag.

**Por quê:**
- Zero custo de AWS calls em dev.
- Funciona offline.
- Reset rápido (`docker compose down -v`).
- Parity boa o suficiente — APIs S3/SQS/SNS são estáveis.

**Não funciona pra:** Cognito (LocalStack Pro só), KMS, alguns features de RDS. Para esses, usamos mocks no app (Cognito) ou Postgres direto (RDS).

---

## ADR-020: Aprovação manual entre staging e prod

**Decisão:** Pipeline vai automático até staging. Stage `ApproveProd` pausa esperando clique no console AWS.

**Por quê:**
- Time pequeno, baixa frequência de deploy. Continuous Deployment puro é overkill.
- Aprovação manual força revisão consciente em prod.
- SNS notifica o aprovador (potencial integração com Slack).
- Reduz risco em momento crítico.

**Quando reavaliar:** quando tivermos múltiplos deploys/dia em staging E observabilidade madura o suficiente pra confiar em auto-promote.

---

## ADR-021: in-place deploy + healthcheck rigoroso (não blue/green real em EC2 inicialmente)

**Decisão:** Começar com **in-place rolling deploy** em EC2 (uma instância de cada vez, com healthcheck no ALB drenar e rotacionar). Migrar para blue/green real (duas ASGs + ALB swap) quando o SLA exigir.

**Por quê inicialmente in-place:**
- Mais simples de configurar e debugar.
- Downtime por instância é ~3-5s; ALB rota tráfego para as outras durante isso.
- CodeDeploy faz isso nativamente.

**Por quê migrar pra blue/green real depois:**
- Zero downtime real.
- Rollback instantâneo (volta o target group).
- Necessário quando picos críticos não toleram nem 3s de degradação parcial.

Esse ADR pode mudar cedo — assim que a empresa tiver volume + SLA explícito, blue/green real.

---

## ADR-022: Padrão persona para permissões, sem ações finas

**Decisão:** Todo claim de permissão é uma **persona** — descreve *quem o usuário é* (`HOSPITALITY:HOTEL_ADMIN`, `HOSPITALITY:BOOKING_VIEWER`). Rotas declaram **quais personas podem acessá-las**. Não modelamos permissões como ações (`BOOKING:CREATE`, `USERS:DELETE`).

**Por quê:**
- **Personas são estáveis; ações mudam.** "Admin de hotel" é um conceito de negócio que dura anos. "Criar reserva" pode virar "criar pré-reserva + confirmar" amanhã, e cada nova ação obrigaria atualizar User Pool e tokens de todo mundo.
- **Mantém o User Pool enxuto.** Com personas, o User Pool tem ~6 grupos. Com ações finas teríamos dezenas, multiplicadas por cada novo endpoint.
- **A lógica de negócio fica no endpoint.** "Quem pode criar reserva?" é uma regra de aplicação, não de identidade. O endpoint declara: `permissions: { any: [HOTEL_ADMIN, HOTEL_CHAIN_ADMIN, SYS_ADMIN] }`. Mudou a regra? Mexe no endpoint, novo deploy. Sem touch no Cognito.
- **OR-lista é leitura natural.** "Pode criar reserva quem é admin de hotel OU admin de rede OU sys admin" — é a forma como pessoas pensam sobre autorização em sistemas B2B com hierarquia de papéis.
- **Frontend simétrico.** `useCan('HOSPITALITY:HOTEL_ADMIN')` (é admin?) lê melhor que `useCan('BOOKING:CREATE')` em telas onde a UI já é estruturada por persona (dashboards de admin, etc.).

**Trade-offs:**
- **Endpoints repetem listas similares.** Vários endpoints terão `any: [HOTEL_ADMIN, HOTEL_CHAIN_ADMIN, SYS_ADMIN]`. Aceito — é explícito e auditável. Helper `requireAdminOrAbove()` pode ser criado se a repetição doer.
- **Granularidade limitada.** Para "esse admin específico só pode confirmar, não criar", precisaríamos voltar pra ações finas. **Quando isso aparecer, criamos personas mais específicas** (`HOTEL_CONFIRMER` vs `HOTEL_CREATOR`), não voltamos a ações.

**Não confundir com autorização por linha** (ownership / tenant). Personas controlam acesso ao endpoint; quem-pode-ler-qual-recurso é checagem extra dentro do service (ex: `booking.tenantId !== user.tenantId → 404`). Esse ADR cobre apenas o gate de entrada.

**Quando reavaliar:** se aparecer endpoint cuja regra de acesso for genuinamente uma ação e não couber em nenhuma persona razoável (raro). Antes de quebrar o padrão, considere criar persona mais específica.

---

## Histórico de revisões

| Data | ADR | Mudança |
|---|---|---|
| 2026-05 | inicial | Versão original |
| 2026-06 | ADR-022 | Adicionado: padrão persona para permissões. |
| 2026-07 | ADR-004 | Revisto: validação HTTP migrada de TypeBox+Ajv para Zod 4 + `fastify-type-provider-zod` (linguagem única com o frontend). |
