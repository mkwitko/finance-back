---
name: b2b-reservas-backend
description: "Use this skill when working on the B2B Reservas backend — a Node.js 22 + Fastify 5 + TypeScript strict API. Triggers: tasks that mention or imply adding/modifying/debugging HTTP endpoints, controllers, services, repositories, Drizzle migrations, SQS workers, gateways, error handling, or any file under src/http/, src/workers/, src/gateways/, src/infra/, src/shared/. Also covers: Zod 4 schemas + fastify-type-provider-zod validation, Cognito JWT verify (ID token; identity from sub, roles from authorities.HOTEL_API) with persona-based permissions (HOTEL_API:* catalog, never action-fine permissions like BOOKING:CREATE), AWS integrations (S3 presigned URLs, SQS+SNS with outbox pattern, Cockatiel resilience), PostgreSQL with timestamptz (UTC end-to-end + ms-precision cursors), OpenTelemetry + ADOT → X-Ray + CloudWatch, Vitest + Testcontainers + MSW testing, error catalog (SIGLA-TNNNN codes with i18n in pt-BR/en-US/es-ES), AWS CDK deployment (CodePipeline → ECR → CodeDeploy), Docker multi-stage distroless. Activate when the user mentions Fastify, Zod, Drizzle, Cognito JWT verify, presigned URL, outbox, ERRORS.MOD.NAME(), config.permissions, req.user.permissions, requireUser, app.gateways, Testcontainers, or the B2B Reservas backend repo by name. Do NOT use this skill for frontend (React/Vite) tasks — that's a separate b2b-reservas-frontend skill."
---

# Backend Node.js + Fastify — Padrão da empresa

> **Skill entry point.** Carregue este arquivo antes de qualquer task no backend. Os `.md` em `./references/` são as referências detalhadas (padrões/mecanismos) — vá direto para elas quando precisar de profundidade.
>
> **Geral vs específico.** Esta skill é o **padrão geral** — vale para qualquer backend Node.js da empresa e usa `bookings` como exemplo ilustrativo neutro (não é um módulo real). O que é **fato deste serviço** (nome, módulos de domínio, catálogo de permissões, env/filas/buckets, comandos, ARNs) mora num único arquivo: [`references/PROJECT.md`](./references/PROJECT.md). Ao copiar a skill pra outro repo, troque só o PROJECT.md.

---

## 1. O padrão

API HTTP em **Node.js 22 + Fastify 5 + TypeScript strict**. Padrão de referência para os projetos Node.js da empresa — decisões conservadoras, justificadas e fáceis de copiar. Identidade do serviço atual (ambiente, serviços irmãos, módulos): [`references/PROJECT.md`](./references/PROJECT.md).

**Pilares não-negociáveis (nessa ordem de prioridade quando houver tradeoff):**

1. **Performance** — p99 < 50ms em DB simples; ≥ 20k req/s em hardware modesto. SLOs exatos (e overrides do projeto): [`references/PROJECT.md`](./references/PROJECT.md#2-slos-do-projeto).
2. **Observabilidade** — todo request gera trace + métricas + log correlacionados.
3. **Testabilidade** — todo use-case com teste; integração contra Postgres real (Testcontainers).
4. **DX e padronização** — qualquer dev entende qualquer endpoint em < 5 min.

---

## 2. Stack (não substituir sem discussão)

| Camada | Escolha |
|---|---|
| Runtime | Node.js 22 LTS |
| Framework | Fastify 5 |
| Linguagem | TypeScript 5+ strict |
| Validação | Zod 4 + fastify-type-provider-zod |
| Banco | PostgreSQL 16+ |
| ORM | Drizzle + `pg` |
| Auth | AWS Cognito (JWT verify only — **nunca senha local**) |
| Logs | Pino |
| Observabilidade | OTel + ADOT → X-Ray + CloudWatch |
| Filas | AWS SQS + SNS |
| Storage | AWS S3 (presigned URLs) |
| HTTP client | undici |
| Resiliência | Cockatiel |
| Testes | Vitest + Testcontainers + MSW |
| Lint/Format | Biome |
| Build | tsup (esbuild) |
| Container | Docker multi-stage + distroless |
| Deploy | CodePipeline + CodeBuild + ECR + CodeDeploy (blue/green) |
| IaC | AWS CDK (TypeScript) |
| Dev local | Docker Compose (Postgres + LocalStack) |

Por que não Datadog, Prisma, Jest, ESLint, Express? → [`references/DECISIONS.md`](./references/DECISIONS.md).

---

## 3. Arquitetura — vertical slice

Cada operação (`create-user`, `update-booking`) é uma pasta auto-contida.

```
HTTP Request
    ↓
[Controller]   arquivo único: rota + schema + handler. Chama service.
    ↓
[Service]      função exportada direto. Regra de negócio pura.
    ↓
[Repository]   acesso a dados via Drizzle, compartilhado no recurso.
    ↓
[Schema]       Zod (HTTP) + Drizzle table (DB).
```

**Diferenças em relação a Spring Boot:**
- Sem route + controller separados. O "controller" é o arquivo que registra a rota.
- Services são **funções**, não classes. Sem `.execute`, sem `class XService`.
- Sem DI container. Singletons (`db`, `logger`) importados direto. Gateways externos (Cognito, S3, SQS) via decorator do Fastify (`app.gateways`) para permitir fake em teste.

Detalhes: [`references/ARCHITECTURE.md`](./references/ARCHITECTURE.md).

---

## 4. Como Claude Code deve trabalhar

### Antes de codar
1. **Navegue pela base via graphify, não grep.** Se `graphify-out/graph.json` existe, rode `graphify query "<pergunta>"` antes de qualquer busca textual. `graphify path "<A>" "<B>"` para relações, `graphify explain "<conceito>"` para foco. Use `graphify-out/wiki/index.md` para navegação ampla. `GRAPH_REPORT.md` apenas para revisão arquitetural ampla. Após modificar código, rode `graphify update .`.
2. **Identifique a camada.** Controller? service? gateway? infra? Regras diferentes.
3. **Procure padrão existente.** Se `create-user` existe, copie a estrutura para `create-booking`. **Consistência > criatividade.** `http/users/create-user/` é o template canônico.
4. **Releia o `.md` relevante** em `references/` (ver índice na seção 5).

### Ao escrever código
- **TypeScript strict.** Sem `any`. Sem `as` casual.
- **Zod é fonte da verdade.** Derive types via `z.infer<typeof Schema>` (import `import { z } from 'zod/v4'`).
- **Errors tipados.** Lance via catálogo: `throw ERRORS.AUTH.INVALID_TOKEN()` ou `throw ERRORS.<SIGLA>.NOT_FOUND({ ... })`. Nunca `new AppError(...)` direto. Códigos seguem `SIGLA-TNNNN` — o **mecanismo** está em [`references/ERRORS.md`](./references/ERRORS.md); o **inventário** é `src/shared/errors/catalog.ts` (não há doc a atualizar ao adicionar código).
- **Rotas autenticadas e com permissões.** Toda rota é autenticada por padrão. Opt-out: `config: { public: true }` (caso `/health`). Permissões obrigatórias por rota, **padrão persona** — declare quais personas podem acessar: `config: { permissions: { any: [PERMISSIONS.<SISTEMA>.<PERSONA>] } }`. Não declarar = 403 em runtime. **Nunca crie permissões com nome de ação** (`BOOKING:CREATE` é antipattern — ver [`references/INTEGRATIONS.md`](./references/INTEGRATIONS.md#25-autorização-permissões--padrão-persona)). Catálogo deste projeto: `src/shared/permissions/catalog.ts` (espelho em [`PROJECT.md` §3](./references/PROJECT.md#3-catálogo-de-permissões-personas)).
- **Logs estruturados.** `req.log.info({ userId }, "user.created")`. Nunca `console.log`.
- **Async sempre.** Nada de `fs.readFileSync` em path de request.
- **Chamadas externas via gateway.** Nunca importe `@aws-sdk/...` em service.

### Regra obrigatória de teste
**Todo use-case DEVE ter teste antes de ser considerado pronto.** Não declare uma task concluída sem:
- Service puro: teste unitário em Vitest.
- Endpoint: teste e2e via `fastify.inject`.
- Integração com DB: Testcontainers contra Postgres real.

Se você terminou o código mas não escreveu o teste, a task **não está pronta** — escreva o teste antes de reportar conclusão.

### Antes de declarar pronto
1. Teste escrito e passando (regra acima).
2. `pnpm typecheck` limpo.
3. `pnpm check` limpo.
4. Checklist completo em [`references/CODING_STANDARDS.md`](./references/CODING_STANDARDS.md) § "Definition of Done".

### Commits
**Nunca rode `git commit` sem aprovação explícita.** Após terminar a task: stage as mudanças, mostre `git status` + diff resumido, e **espere o usuário revisar e autorizar** antes de commitar. Aprovação é por commit, não por sessão — mesmo que o usuário tenha dito "commita" antes, confirme de novo no próximo commit.

### Em dúvida
1. Olhe um use-case existente (`http/users/create-user/`).
2. Releia o `.md` da área.
3. Pergunte: "isso preserva os 4 pilares da seção 1?"
4. Prefira **simples** + **performático**, nessa ordem.
5. **Não invente padrões novos sozinho.** Arquitetura corporativa; consistência > otimização local. Se nada na base resolve, pergunte antes de criar.

---

## 5. Índice de docs (`references/`)

- [`references/PROJECT.md`](./references/PROJECT.md) — **fatos deste serviço** (identidade, módulos, catálogo de permissões, env/gateways, comandos, ARNs). Único arquivo que muda por projeto.
- [`references/README.md`](./references/README.md) — resumo + fluxos de leitura
- [`references/ARCHITECTURE.md`](./references/ARCHITECTURE.md) — vertical slice, gateways, transações, erros
- [`references/CODING_STANDARDS.md`](./references/CODING_STANDARDS.md) — strict, naming, Definition of Done
- [`references/DOCKER.md`](./references/DOCKER.md) — Dockerfile, compose, LocalStack
- [`references/DEPLOYMENT.md`](./references/DEPLOYMENT.md) — pipeline AWS, CDK, rollback
- [`references/OPERATIONS.md`](./references/OPERATIONS.md) — boot, shutdown, migrations, runbooks
- [`references/INTEGRATIONS.md`](./references/INTEGRATIONS.md) — Cognito, S3, SQS+SNS, Cockatiel, **catálogo de permissões persona**
- [`references/ERRORS.md`](./references/ERRORS.md) — **mecanismo** de erros (`SIGLA-TNNNN`, factory, envelope, i18n); inventário em `catalog.ts`
- [`references/TESTING.md`](./references/TESTING.md) — Vitest, Testcontainers, `fastify.inject`
- [`references/DATABASE.md`](./references/DATABASE.md) — convenção de tabela (PK bigint + uuid público, created_by/updated_by, singular, bootstrap SYSTEM)
- [`references/DATES.md`](./references/DATES.md) — UTC, timestamptz, ISO 8601, precisão de ms no cursor
- [`references/PERFORMANCE.md`](./references/PERFORMANCE.md) — SLOs, schemas, pool, profiling
- [`references/OBSERVABILITY.md`](./references/OBSERVABILITY.md) — OTel, X-Ray, alarmes, dashboards
- [`references/DECISIONS.md`](./references/DECISIONS.md) — ADRs (por que cada escolha de stack)

---

## 6. Comandos

Scripts completos em `package.json`. Os comandos e gotchas **deste projeto** (dev/dev:reset/dev:native, start+OTel, migrations em prod, deploy:prod) vivem em [`references/PROJECT.md` §7](./references/PROJECT.md#7-comandos-e-gotchas-deste-projeto).