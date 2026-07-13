# PERFORMANCE.md — Como manter o serviço rápido

> O objetivo é igualar (ou superar) latência/throughput dos serviços Java Spring Boot da empresa. **Performance não é opcional.**

---

## 1. Metas (SLO interno)

| Métrica | Alvo | Limite |
|---|---|---|
| p50 latência (CRUD simples) | < 5ms | 15ms |
| p99 latência (CRUD simples) | < 50ms | 100ms |
| Throughput (1 vCPU, healthcheck) | ≥ 50k req/s | — |
| Throughput (1 vCPU, leitura DB) | ≥ 20k req/s | — |
| Cold start (boot até ready) | < 2s | 5s |
| Memória residente (idle) | < 150MB | 300MB |

**P99 sob 50ms:** 99% dos requests respondem em menos de 50ms; 1% pode demorar mais. Sempre olhe percentis (p50, p95, p99), nunca média sozinha.

Meça via `pnpm bench`. Não merge degradação > 5% sem aprovação.

---

## 2. Validação (Zod 4) e o custo de performance

Validação roda em **todo request**, então vale ser honesto sobre o custo. A validação em runtime do Zod é **mais lenta** que os validadores JIT-compilados do Ajv (que era o stack anterior, TypeBox+Ajv). Escolhemos Zod mesmo assim — por linguagem única com o frontend e DX, não por velocidade (ver [`DECISIONS.md` ADR-004](./DECISIONS.md#adr-004-zod-4-não-typebox-nem-class-validator)). O que mantém isso dentro do orçamento de perf:

- **Zod 4 é dramaticamente mais rápido que Zod 3.** A v4 reduziu bastante o custo de `parse`; o gap para o Ajv-JIT existe, mas é muito menor do que era.
- **`serializerCompiler` do `fastify-type-provider-zod`** serializa a resposta a partir do schema Zod declarado — o caminho de saída não cai no `JSON.stringify` genérico.
- **Schemas enxutos.** Menos refinements caros, menos objetos aninhados profundos no hot path. Um schema magro valida rápido.

Para um endpoint que faz 5ms de DB, a validação é uma fração pequena do total — **validação raramente é o gargalo de p99** (o custo dominante é DB/rede). Onde é mensurável (healthchecks, leituras triviais, workers de alto volume), mantenha o schema o mais enxuto possível e confie no `serializerCompiler` para a saída.

---

## 3. Fastify: extrair o máximo

### 3.1 Sempre declare `response` schema

Com o `serializerCompiler` do `fastify-type-provider-zod`, a resposta é serializada a partir do schema Zod declarado — muito mais rápido que o `JSON.stringify` genérico, e ainda poda campos fora do schema.

```ts
// ❌ Lento: serialização genérica
app.get("/users/:id", async () => userService.find(id));

// ✅ Rápido: serialização compilada
app.get("/users/:id", {
  schema: { response: { 200: UserResponse } },
  handler: async () => userService.find(id),
});
```

> **Maior alavanca de perf isolada em endpoints de leitura.** Não pule.

### 3.2 Configuração do servidor

```ts
const app = Fastify({
  logger,
  disableRequestLogging: true,
  keepAliveTimeout: 72_000,       // > ALB default (60s) — evita race
  connectionTimeout: 10_000,
  bodyLimit: 1 * 1024 * 1024,
  trustProxy: true,               // EC2 atrás de ALB
  caseSensitive: true,
  ignoreTrailingSlash: true,
});
```

### 3.3 Evite alocação em hot path

- Não crie objetos grandes em loop dentro de handler.
- Caches LRU (`lru-cache`) para resultados quentes em `infra/cache/`.

---

## 4. PostgreSQL + Drizzle

### 4.1 Pool de conexão

```ts
// src/infra/db/client.ts — o pool primário é construído por buildAppPool (src/infra/db/app-pool.ts)
import { drizzle } from "drizzle-orm/node-postgres";
import { env } from "@/config/env";
import { buildAppPool } from "./app-pool.js";

export const pool = buildAppPool({ url: env.DATABASE_URL, max: env.DATABASE_POOL_MAX });
export const db = drizzle(pool);

export type Db = typeof db;
// Handle que o drizzle passa em db.transaction(tx => …); repos aceitam Db | DbTransaction.
export type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type DbOrTx = Db | DbTransaction;
```

O pool configura `max` (`env.DATABASE_POOL_MAX`), `idleTimeoutMillis`/`connectionTimeoutMillis` e `statement_timeout`/`query_timeout` (constante 10s — backstop contra query travada segurar conexão, **não** é o alvo de latência). O mesmo timeout vale para os pools read-only externos (`buildReadOnlyPool`, `max: 5`), onde uma query lenta do upstream poderia esgotar as poucas conexões. **Tanto o pool primário (`buildAppPool`) quanto os externos** ligam `keepAlive` (Aurora/RDS-Proxy/NAT derrubam conexão idle silenciosamente — sem keepalive a conexão morta só aparece na próxima query, como `Connection terminated unexpectedly` → 502 espúrio) e registram um listener `pool.on('error')` (erro de client idle do `pg` sem listener derruba o processo; logado como `app_db.pool_error`/`external_db.pool_error`, não-fatal).

**Retry de conexão (`src/infra/db/connection-retry.ts`).** Aurora derruba conexões em failover/scaling/manutenção, e um pool saturado pode estourar `connectionTimeoutMillis` ao tentar crescer — nenhum dos dois significa query quebrada. `wrapPoolWithRetry` embrulha `pool.query` (nível do pool, **antes** do Drizzle empacotar como `DrizzleQueryError`) com retry + backoff exponencial do Cockatiel. Cobre só queries **não-transacionais** (`db.transaction` pega um client dedicado via `pool.connect`; retentar um statement dentro de uma tx aberta seria inseguro). **Predicado por pool:** o primário (read-write) usa `isConnectionAcquisitionError` — só falhas de **aquisição** (`timeout exceeded when trying to connect`, `Connection terminated due to connection timeout`), provadamente pré-statement, seguras mesmo para writes; os pools read-only usam `isTransientConnectionError` (conjunto completo: + `Connection terminated unexpectedly`, errnos de socket, SQLSTATE `08*`/`57P0x`), seguro porque toda query é idempotente. **Sem circuit breaker** no path de DB (um breaker aberto no hot path de auth = outage total).

Tunings ainda **não** aplicados: `application_name` (rastreia conexões no `pg_stat_activity`) e `drizzle(pool, { logger })` para logar queries em dev.

**Dimensionando em EC2:**

Fórmula prática: `pool_max = (cores_db * 2) + spindles_efetivos`. Para Postgres em SSD com 4 cores, ~10 conexões por instância de app. Se você tem 10 instâncias EC2, são 100 conexões — verifique `max_connections` do RDS.

Quando passar de ~200 conexões totais, coloque **RDS Proxy** (gerenciado) ou **PgBouncer** na frente.

### 4.2 Drizzle: queries diretas, sem N+1

```ts
// ❌ N+1
const orders = await db.select().from(ordersTable);
for (const o of orders) {
  o.items = await db.select().from(items).where(eq(items.orderId, o.id));
}

// ✅ JOIN
const result = await db
  .select()
  .from(ordersTable)
  .leftJoin(items, eq(items.orderId, ordersTable.id));

// ✅ Ou: query relacional
const orders = await db.query.orders.findMany({
  where: (o, { eq }) => eq(o.userId, userId),
  with: { items: true },
});
```

### 4.3 Prepared statements

```ts
const findUserById = db
  .select()
  .from(users)
  .where(eq(users.id, sql.placeholder("id")))
  .prepare("find_user_by_id");

const [user] = await findUserById.execute({ id });
```

Reduz parse/plan em 30-50% para queries quentes.

### 4.4 Índices

**Toda query em produção tem `EXPLAIN ANALYZE` rodado.** Se aparece `Seq Scan` em tabela > 10k rows, crie índice.

```ts
export const users = pgTable(
  "users",
  { /* cols */ },
  (t) => ({
    emailIdx: uniqueIndex("users_email_idx").on(t.email),
    createdAtIdx: index("users_created_at_idx").on(t.createdAt),
  }),
);
```

### 4.5 `SELECT` só o que precisa

```ts
// ❌
await db.select().from(users);

// ✅
await db.select({ id: users.id, email: users.email }).from(users);
```

---

## 5. Async e concorrência

### 5.1 `Promise.all` para chamadas independentes

```ts
// ❌ serial
const user = await usersRepo.find(id);
const bookings = await bookingsRepo.findByUser(id);

// ✅ paralelo
const [user, bookings] = await Promise.all([
  usersRepo.find(id),
  bookingsRepo.findByUser(id),
]);
```

### 5.2 Cuidado com event loop

Nunca em hot path:
- `fs.readFileSync`, `crypto.pbkdf2Sync` — sync bloqueia o loop.
- Loops sobre arrays > 100k itens — quebre em batches com `setImmediate`.
- `JSON.parse` de payloads > 1MB — rejeite via `bodyLimit`.

---

## 6. HTTP cliente (undici)

`undici` é o cliente HTTP padrão. Pools dedicados por upstream — veja [`INTEGRATIONS.md`](./INTEGRATIONS.md). Para chamadas avulsas, dispatcher global:

```ts
// src/infra/http/undici-agent.ts
import { Agent, setGlobalDispatcher } from "undici";

setGlobalDispatcher(new Agent({
  keepAliveTimeout: 30_000,
  keepAliveMaxTimeout: 600_000,
  connections: 100,
  pipelining: 1,
}));
```

---

## 7. Logging não pode ser caro

- **Pino com stdout.** No container, stdout vai pro CloudWatch via log driver `awslogs`.
- **Nível `info` no máximo em prod.**
- **Não serialize objetos grandes.** Configure `redact` (ver [`OBSERVABILITY.md`](./OBSERVABILITY.md)).
- **Sampling.** Se um endpoint loga 10k vezes/s, logue 1 em N para não-erros.

---

## 8. Flags do Node em produção

No `Dockerfile` (produção):

```dockerfile
ENV NODE_OPTIONS="--enable-source-maps --max-old-space-size=768"
CMD ["--import", "./dist/instrumentation.js", "./dist/server.js"]
```

- `--max-old-space-size` ajustado ao container. Para `t3.medium` com 4GB, use 2048 e configure 1500MB pro container.
- `--enable-source-maps` ajuda stack traces.
- `--import` carrega instrumentation antes de tudo.

Não use `--inspect`/`tsx`/`ts-node` em prod.

---

## 9. Múltiplos processos no container

Em EC2 com container Docker rodando 1 instância de Node, você só usa 1 vCPU. Para usar mais:

### Opção A — múltiplos containers por EC2

ALB distribui entre 4 containers na mesma EC2, cada um com 1 processo Node. Mais simples, escala bem.

### Opção B — PM2 dentro do container

Roda PM2 em modo cluster dentro do container, com N processos.

```dockerfile
# Em Dockerfile (alternativa, se for usar PM2 dentro do container)
RUN pnpm add -g pm2
CMD ["pm2-runtime", "ecosystem.config.cjs"]
```

```js
// ecosystem.config.cjs
module.exports = {
  apps: [{
    name: "api",
    script: "./dist/server.js",
    node_args: "--import ./dist/instrumentation.js --enable-source-maps",
    instances: "max",
    exec_mode: "cluster",
  }],
};
```

**Recomendação:** comece com Opção A (1 processo por container, múltiplos containers se necessário). Mais previsível, melhor pra observabilidade (cada processo tem seus traces/métricas separados).

---

## 10. Benchmarks

### 10.1 Microbench (`mitata`)

```ts
import { run, bench, group } from "mitata";

group("validate", () => {
  bench("zod parse (schema enxuto)", () => leanSchema.parse(payload));
  bench("zod parse (schema pesado)", () => heavySchema.parse(payload));
});
await run();
```

### 10.2 Load test (`autocannon`)

```bash
pnpm autocannon -c 100 -d 30 -p 10 http://localhost:3000/v1/users/abc
```

Targets:
- `-c 100`: 100 conexões concorrentes
- `-d 30`: 30s
- `-p 10`: 10 requests pipelined por conexão

Compare contra branch `main`. Regressão > 5% bloqueia merge.

### 10.3 Profiling em prod

1. `node --prof ./dist/server.js` em ambiente isolado.
2. Flame graphs via `clinic flame -- node dist/server.js`.
3. CloudWatch Logs Insights para correlacionar lentidão com query lenta.

---

## 11. Checklist antes de subir endpoint novo

- [ ] `response` schema declarado (Zod)
- [ ] Sem `await` em sequência onde paralelo serviria
- [ ] Queries com `EXPLAIN ANALYZE` — sem `Seq Scan` em tabelas grandes
- [ ] Sem `SELECT *` em queries quentes
- [ ] Sem JSON serializado em log
- [ ] `autocannon` rodado contra endpoint isolado
- [ ] Trace OTel cobre todo o caminho (route → service → repo → db; route → gateway → externo)
