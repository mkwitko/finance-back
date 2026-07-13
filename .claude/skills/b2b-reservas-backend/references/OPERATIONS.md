# OPERATIONS.md — Operação em Produção

> Como o serviço se comporta em produção: boot, shutdown, resiliência, migrations. O **deploy** (pipeline AWS) é coberto em [`DEPLOYMENT.md`](./DEPLOYMENT.md); aqui foca em runtime.

---

## 1. Lifecycle

### 1.1 Boot

Ordem (em `src/server.ts`):

1. **OTel SDK start** (via `--import ./dist/instrumentation.js`)
2. Parse de `env` via Zod (fail fast em qualquer var inválida)
3. Connect ao Postgres (pool init com health probe)
4. `buildApp()` — Fastify + plugins + rotas
5. Start workers SQS (se aplicável)
6. `app.listen({ port, host: "0.0.0.0" })`
7. Registra signal handlers (SIGTERM, SIGINT)
8. Loga `server.ready { port, version, env }`

Se qualquer passo falha → processo morre com exit code != 0. CodeDeploy detecta health check falhando e aborta o deploy.

### 1.2 Graceful Shutdown

Tempo limite total: **30s** (alinhado com ALB drain timeout).

```ts
// src/server.ts
const SHUTDOWN_TIMEOUT = 30_000;
const READINESS_DRAIN = 5_000;

let shuttingDown = false;
export let isReady = true;

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  isReady = false; // /health/ready agora responde 503

  app.log.info({ signal }, "shutdown.start");

  const force = setTimeout(() => {
    app.log.error("shutdown.timeout — forcing exit");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT);

  try {
    // 1. Espera ALB drenar (tira instância do target group)
    await sleep(READINESS_DRAIN);

    // 2. Para workers (terminam trabalho em andamento, não pegam novo):
    //    consumers SQS + o relay do outbox. Param antes do pool.end() pois
    //    o relay ainda escreve published_at no DB ao fechar o lote atual.
    for (const consumer of consumers) {
      await consumer.stop({ abort: false });
    }
    await outboxRelay.stop();
    app.log.info("shutdown.workers_stopped");

    // 3. Fecha Fastify (espera em-vôo)
    await app.close();
    app.log.info("shutdown.fastify_closed");

    // 4. Fecha pool do DB
    await pool.end();
    app.log.info("shutdown.db_closed");

    // 5. Flush OTel
    await otelSdk?.shutdown();
    app.log.info("shutdown.otel_closed");

    clearTimeout(force);
    app.log.info("shutdown.complete");
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, "shutdown.error");
    process.exit(1);
  }
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
```

### 1.3 Sinal SIGTERM no container

Docker envia SIGTERM no `docker stop`. CodeDeploy chama `docker stop --time=35` no script `stop.sh`, dando 35s para shutdown completar antes do SIGKILL.

> Em containers, Node deve ser **PID 1**. Distroless já cuida disso. Se usar wrapper (PM2-runtime), garanta que sinais propaguem.

### 1.4 Readiness durante shutdown

`/health/ready` consulta `isReady`. ALB para de mandar tráfego antes do app fechar conexões em-vôo.

```ts
app.get("/health/ready", { logLevel: "silent" }, async (_req, reply) => {
  if (!isReady) return reply.code(503).send({ status: "draining" });
  try {
    await db.execute(sql`select 1`);
    return { status: "ok" };
  } catch (err) {
    return reply.code(503).send({ status: "degraded", reason: "db" });
  }
});
```

---

## 2. Resiliência (Cockatiel) — recap

Policies são construídas por `createHttpPolicy({ retries?, timeoutMs? })` em `src/infra/resilience/policies.ts` (retry + timeout + circuit breaker via `wrap`), aplicadas dentro de cada gateway. Detalhes em [`INTEGRATIONS.md`](./INTEGRATIONS.md). Erros marcados com `nonRetryable()` (4xx, respostas inválidas) não são re-tentados nem contam para o breaker.

**Recomendado (ainda não conectado):** ligar os eventos do Cockatiel (`onBreak`/`onReset`/`onFailure`) a counters OTel no ponto de construção da policy, para então:

CloudWatch Alarm: `policy_breaks > 0` por 5 min → alerta → potencialmente dispara rollback do CodeDeploy se ocorrer durante janela de deploy.

---

## 3. Migrations em produção

Veja seção em [`DEPLOYMENT.md`](./DEPLOYMENT.md#migrations-no-pipeline) para integração com pipeline.

Pontos críticos:

1. **Migration roda ANTES do deploy do app** — sempre. Step separado no pipeline.
2. **Idempotência** — `IF NOT EXISTS`, `IF EXISTS`.
3. **Estratégia 2-deploy para mudanças destrutivas:**
   - Deploy 1: app para de usar coluna X (mantém código compatível com coluna existindo)
   - Migration: `ALTER TABLE ... DROP COLUMN x`
   - Deploy 2: limpeza opcional
4. **Lock timeout curto** em migrations grandes:
   ```sql
   SET lock_timeout = '5s';
   ALTER TABLE ...
   ```
5. **Sem `DROP TABLE` ou `DROP COLUMN` sem 2-deploy** + backup verificado.

Script `scripts/migrate.ts`:

```ts
import "dotenv/config";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 1,
  statement_timeout: 60_000,
});
const db = drizzle(pool);

await migrate(db, { migrationsFolder: "./drizzle" });
await pool.end();
console.log("migrations applied");
```

---

## 4. Configuração por ambiente

| Var | dev | staging | prod |
|---|---|---|---|
| `NODE_ENV` | `development` | `staging` | `production` |
| `LOG_LEVEL` | `debug` | `info` | `info` |
| `DB_POOL_MAX` | 5 | 10 | 15-20 |
| `OTEL_SDK_DISABLED` | `true` (opcional) | `false` | `false` |

Variáveis sensíveis vêm de **SSM Parameter Store**. O script `start.sh` (CodeDeploy) lê todos os parâmetros sob `/myapp/<env>/` e injeta no container via `--env-file`.

---

## 5. Backup e Disaster Recovery

Responsabilidade do time de infra/RDS, mas o app **assume que:**
- DB pode estar read-only durante failover → endpoints de escrita falham temporariamente; tratamos como `ServiceUnavailableError` 503.
- Reconexão automática do pool `pg` é nativa.
- Workers SQS: mensagens não processadas durante falha ficam na fila; visibility timeout garante reentrega.

---

## 6. Runbooks (template)

Cada incidente recorrente vira runbook em `docs/runbooks/<slug>.md`:

```markdown
# Runbook: DB pool exhausted

## Symptoms
- Métrica `db_pool_connections_total{state="waiting"}` > 5 por 2 min
- Logs: `Error: timeout exceeded when trying to connect`

## Diagnosis
1. RDS Performance Insights ou:
   `SELECT state, count(*) FROM pg_stat_activity GROUP BY state;`
2. Queries longas:
   `state = 'active' AND now() - query_start > '30 seconds'`

## Mitigation
- Curto prazo: scale-out (mais instâncias EC2)
- Médio: kill queries lentas, investigar
- Longo: criar índice, refatorar query, considerar RDS Proxy

## Alarme
CloudWatch: `db_pool_waiting > 5` por 2 min → SNS → Slack
```

---

## 7. Feature Flags

Para mudanças arriscadas, esconda atrás de flag. Opções:
- **AWS AppConfig** (nativo, integra com SSM)
- Tabela `feature_flags` + cache 30s
- Unleash/LaunchDarkly (se a empresa adotar)

```ts
if (await flags.isEnabled("new-pricing-engine", { userId })) {
  // novo caminho
} else {
  // caminho antigo
}
```

Sempre com **kill switch** e métrica de adoção.

---

## 8. Versionamento da API

- Prefixo de versão na URL: `/v1/users`, `/v2/users`. Não use header de versão.
- Breaking change = nova versão. Mantenha v1 por pelo menos 6 meses após anunciar deprecation.
- Adições compatíveis (campo novo opcional) ficam na mesma versão.

---

## 9. Checklist operacional

Antes do primeiro deploy real, leia [`DEPLOYMENT.md#checklist-de-deploy`](./DEPLOYMENT.md#checklist-de-deploy).

Antes de cada deploy de prod:

- [ ] Staging testado manualmente
- [ ] Migrations revisadas (SQL inspecionado no PR)
- [ ] Smoke test passa em staging
- [ ] Rollback plan claro (feature flag desligável? migration backward-compatible?)
- [ ] CloudWatch alarms de rollback (5xx, p99) ativos
- [ ] SNS de aprovação tem destinatários corretos
