# Docs — Backend Node.js + Fastify (padrão da empresa)

Documentação de arquitetura de referência para os projetos Node.js da empresa. Descreve **padrões e mecanismos** gerais; os fatos do serviço atual ficam em [`PROJECT.md`](./PROJECT.md). Exemplos usam `bookings` como recurso ilustrativo neutro.

> **Para começar, leia [`../CLAUDE.md`](../CLAUDE.md) primeiro.** É o documento mestre na raiz que Claude Code (e qualquer dev) deve ler antes de qualquer task.

---

## Índice

### Visão geral
- [`../CLAUDE.md`](../CLAUDE.md) — **Comece aqui.** Pilares, stack, estrutura, como Claude Code deve trabalhar.
- [`PROJECT.md`](./PROJECT.md) — **fatos deste serviço** (identidade, módulos, permissões, env/gateways, comandos, ARNs). Único arquivo que muda por projeto.

### Arquitetura
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — Vertical slice, controller+route fundidos, services como funções, gateways via `app.gateways`, transações, erros.
- [`CODING_STANDARDS.md`](./CODING_STANDARDS.md) — TypeScript strict, naming, erros tipados, env validation, segurança, Definition of Done.
- [`ERRORS.md`](./ERRORS.md) — **mecanismo** de erros (formato `SIGLA-TNNNN`, factory, envelope, i18n). Inventário = `catalog.ts`; siglas do projeto = `PROJECT.md`.

### Infraestrutura & Deploy
- [`DOCKER.md`](./DOCKER.md) — Dockerfile produção (distroless) e dev, `docker-compose.yml` com Postgres + LocalStack, Cognito em dev.
- [`DEPLOYMENT.md`](./DEPLOYMENT.md) — Pipeline AWS-nativo (CodeCommit → CodePipeline → CodeBuild → ECR → CodeDeploy), CDK, buildspec, appspec, rollback automático, aprovação manual.
- [`OPERATIONS.md`](./OPERATIONS.md) — Boot, graceful shutdown, migrations em produção, config por ambiente, runbooks.

### Integrações
- [`INTEGRATIONS.md`](./INTEGRATIONS.md) — Cognito (JWT verify), S3 (presigned URLs), SQS+SNS (com `sqs-consumer`), serviços HTTP internos, APIs externas, Cockatiel resilience.

### Qualidade
- [`TESTING.md`](./TESTING.md) — Vitest (unit/integration/e2e), Testcontainers, `fastify.inject`, gateways fakes via `app.gateways`.
- [`DATES.md`](./DATES.md) — Datas e timestamps: UTC ponta a ponta, `timestamptz`, ISO 8601, `z.string()` (sem `format`), precisão de milissegundos no cursor.
- [`PERFORMANCE.md`](./PERFORMANCE.md) — SLOs (p99 < 50ms), validação Zod e seu custo de perf, Fastify response schemas, pool tuning, prepared statements, profiling.
- [`OBSERVABILITY.md`](./OBSERVABILITY.md) — OTel + ADOT → X-Ray + CloudWatch, Pino com `trace_id`, healthchecks, dashboards, alarmes que disparam rollback.

### Por que essas escolhas?
- [`DECISIONS.md`](./DECISIONS.md) — ADRs explicando cada decisão (Node vs Bun, Fastify vs Nest, Zod vs TypeBox, Drizzle vs Prisma, EC2 vs ECS, CDK vs Terraform, etc).

---

## Stack — resumo

| Camada | Escolha |
|---|---|
| Runtime | Node.js 22 LTS |
| Package manager | pnpm 9 |
| Framework HTTP | Fastify 5 |
| Linguagem | TypeScript 5+ strict |
| Validação | Zod 4 + fastify-type-provider-zod |
| ORM | Drizzle + `pg` |
| Banco | PostgreSQL 16+ |
| Auth | AWS Cognito (JWT verify only) |
| Storage | AWS S3 |
| Filas | AWS SQS + SNS |
| HTTP client | undici |
| Resiliência | Cockatiel |
| Logs | Pino |
| Observabilidade | OpenTelemetry + ADOT → X-Ray + CloudWatch |
| Testes | Vitest + Testcontainers + MSW |
| Lint/Format | Biome |
| Build | tsup (esbuild) |
| Container | Docker (distroless) |
| Compute | EC2 |
| CI/CD | CodeCommit → CodePipeline → CodeBuild → ECR → CodeDeploy |
| IaC | AWS CDK (TypeScript) |
| Dev local | Docker Compose (Postgres + LocalStack) |

---

## SLOs

| Métrica | Alvo |
|---|---|
| p50 latência (CRUD simples) | < 5ms |
| p99 latência (CRUD simples) | < 50ms |
| Throughput (1 vCPU, leitura DB) | ≥ 20k req/s |
| Cold start (boot até ready) | < 2s |
| Disponibilidade | 99.9% |

---

## Fluxo de leitura sugerido

**Se você nunca viu o projeto:**
1. `CLAUDE.md` (~10 min)
2. `ARCHITECTURE.md` (~15 min)
3. `DOCKER.md` para subir local (~10 min)
4. Depois, conforme necessidade.

**Se você vai adicionar um endpoint novo:**
1. `ARCHITECTURE.md` § 3 (anatomia de um caso de uso) + § 9 (checklist)
2. `CODING_STANDARDS.md` § Definition of Done

**Se você vai integrar com algo externo:**
1. `INTEGRATIONS.md` (padrão do gateway)
2. `DECISIONS.md` se quiser entender escolhas

**Se algo está lento:**
1. `PERFORMANCE.md`
2. `OBSERVABILITY.md` (como instrumentar pra descobrir o gargalo)

**Se você vai fazer deploy:**
1. `DEPLOYMENT.md` (entender o pipeline)
2. `OPERATIONS.md` § Migrations + checklist
