# OBSERVABILITY.md — Logs, Métricas, Traces

> Três pilares, **uma instrumentação**: OpenTelemetry. Exporta hoje para **AWS X-Ray (traces)** e **CloudWatch (logs + métricas)** via ADOT Collector. Amanhã, se a empresa adotar Datadog/Grafana/New Relic, mudamos config do Collector — código não muda.

---

## 1. Arquitetura

```
[App Node + OTel SDK no container]
       │
       │ OTLP HTTP (localhost:4318)
       ▼
[ADOT Collector rodando como container/processo na EC2]
       │
       ├──► AWS X-Ray            (traces)
       ├──► CloudWatch Metrics   (métricas via EMF)
       └──► CloudWatch Logs      (logs via Docker log driver awslogs)
```

**Por que OTel + ADOT e não X-Ray SDK direto:**

- X-Ray SDK é AWS-only e legado; AWS está migrando o próprio tooling para OTel.
- ADOT é distro oficial da AWS do OTel — suportada, com exporters X-Ray e CloudWatch nativos.
- Auto-instrumentation OTel para Fastify, pg, undici, aws-sdk é melhor mantida.
- **Vendor lock-in zero.** Se a empresa adotar Datadog amanhã, troca-se config do Collector.

---

## 2. Setup do app

### 2.1 `src/instrumentation.ts` — PRIMEIRO import

```ts
import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { AWSXRayIdGenerator } from "@opentelemetry/id-generator-aws-xray";
import { AWSXRayPropagator } from "@opentelemetry/propagator-aws-xray";

if (process.env.OTEL_SDK_DISABLED !== "true") {
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? "myapp-api",
      [ATTR_SERVICE_VERSION]: process.env.APP_VERSION ?? "0.0.0",
      "deployment.environment": process.env.NODE_ENV ?? "development",
      "cloud.provider": "aws",
      "cloud.region": process.env.AWS_REGION,
    }),
    idGenerator: new AWSXRayIdGenerator(),
    textMapPropagator: new AWSXRayPropagator(),

    traceExporter: new OTLPTraceExporter({ url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT }),
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({ url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT }),
      exportIntervalMillis: 10_000,
    }),

    instrumentations: [
      getNodeAutoInstrumentations({
        "@opentelemetry/instrumentation-fs": { enabled: false },
        "@opentelemetry/instrumentation-dns": { enabled: false },
      }),
    ],
  });

  sdk.start();

  process.on("SIGTERM", () => {
    sdk.shutdown().finally(() => process.exit(0));
  });
}
```

> `OTEL_SDK_DISABLED=true` desliga em dev quando você não quer ruído.

### 2.2 Boot

```ts
// src/server.ts
import "./instrumentation"; // PRIMEIRA LINHA
import { buildApp } from "./app";
// ...
```

E no Dockerfile/scripts:

```
node --import ./dist/instrumentation.js ./dist/server.js
```

`--import` garante que a instrumentação carregue antes de qualquer outro módulo, inclusive ESM com top-level await.

---

## 3. ADOT Collector

Roda como **container separado** na mesma EC2 (sidecar local), ou como processo systemd.

### 3.1 Config

```yaml
# /etc/otel-collector/config.yaml
receivers:
  otlp:
    protocols:
      grpc: { endpoint: 0.0.0.0:4317 }
      http: { endpoint: 0.0.0.0:4318 }

processors:
  batch:
    timeout: 5s
    send_batch_size: 512

exporters:
  awsxray:
    region: sa-east-1
  awsemf:
    region: sa-east-1
    namespace: B2BReservas/MyAppApi
    log_group_name: /aws/otel/myapp-api/metrics
    dimension_rollup_option: NoDimensionRollup

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch]
      exporters: [awsxray]
    metrics:
      receivers: [otlp]
      processors: [batch]
      exporters: [awsemf]
```

> IAM role da EC2 precisa de: `xray:PutTraceSegments`, `logs:PutLogEvents`, `cloudwatch:PutMetricData`. Detalhes do deploy em [`DEPLOYMENT.md`](./DEPLOYMENT.md).

### 3.2 Como o app encontra o Collector

Em prod: app aponta pro `host.docker.internal:4318` (se Collector for processo na host) ou IP do container sidecar.

Em dev: Collector não roda (`OTEL_SDK_DISABLED=true`). Se quiser observar localmente, suba o Collector também no compose.

---

## 4. Tracing

### 4.1 Auto-instrumentation cobre

- HTTP servidor (Fastify) — cada request vira span raiz.
- HTTP cliente (`undici`).
- PostgreSQL via `pg` — cada query vira span filho.
- AWS SDK v3 — cada chamada (S3, SQS, etc) vira span.

### 4.2 Spans manuais

Para etapas distintas dentro de service ou worker:

```ts
import { trace, SpanStatusCode } from "@opentelemetry/api";

const tracer = trace.getTracer("myapp.bookings");

export const createBooking = async (input: CreateBookingInput) => {
  return tracer.startActiveSpan("createBooking", async (span) => {
    try {
      span.setAttribute("booking.property_id", input.propertyId);
      // ... lógica
      span.setStatus({ code: SpanStatusCode.OK });
      return booking;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      throw err;
    } finally {
      span.end();
    }
  });
};
```

### 4.3 Atributos

**SIM:**
- `user.id`, `tenant.id` (após autenticar)
- `db.operation`, `db.table` (auto)
- `http.route` (auto)
- Identificadores de negócio: `booking.id`, `property.id`

**NÃO:**
- PII bruta (email, CPF, telefone) — use hash ou domínio (`email.domain`)
- Senhas, tokens, cartões — **nunca**
- Payloads inteiros — só size/checksum

### 4.4 Sampling

- **Dev:** 100% (`always_on`).
- **Staging/Prod:** começamos com `parentbased_traceidratio` 10% + forçar 100% em erros via tail-sampling no Collector.
- X-Ray cobra por trace gravado.

---

## 5. Métricas

### 5.1 Sempre existentes (RED + USE)

| Métrica | Tipo | Labels |
|---|---|---|
| `http_server_requests_total` | counter | method, route, status_code |
| `http_server_duration_seconds` | histogram | method, route, status_code |
| `http_server_active_requests` | up-down counter | — |
| `db_pool_connections_total` | gauge | state (active/idle/waiting) |
| `db_query_duration_seconds` | histogram | operation, table |
| `aws_sdk_call_duration_seconds` | histogram | service, operation |
| `app_business_events_total` | counter | event_name |
| `nodejs_eventloop_lag_seconds` | gauge | — |
| `process_resident_memory_bytes` | gauge | — |

Auto-instrumentation cobre HTTP, DB, AWS SDK. Para processo, adicione `@opentelemetry/host-metrics`.

### 5.2 Métricas customizadas

```ts
import { metrics } from "@opentelemetry/api";

const meter = metrics.getMeter("myapp.bookings");
const bookingsCreated = meter.createCounter("bookings_created_total", {
  description: "Total bookings created",
});

export const createBooking = async (input: CreateBookingInput) => {
  const booking = await bookingsRepository.insert(input);
  bookingsCreated.add(1, { property_type: booking.propertyType });
  return booking;
};
```

No CloudWatch, métricas aparecem no namespace `B2BReservas/MyAppApi`.

---

## 6. Logging — Pino → stdout → CloudWatch

Container Docker com log driver `awslogs` envia stdout direto pro CloudWatch Logs. Configurado no `docker run` (script de deploy):

```bash
--log-driver=awslogs \
--log-opt awslogs-region="$AWS_REGION" \
--log-opt awslogs-group="/myapp/${ENVIRONMENT}/api" \
--log-opt awslogs-stream="$(hostname)/$(date +%Y%m%d%H%M%S)"
```

### 6.1 Logger

```ts
// src/infra/observability/logger.ts
import { pino } from "pino";
import { trace } from "@opentelemetry/api";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  formatters: {
    level: (label) => ({ level: label }),
    log: (obj) => {
      const span = trace.getActiveSpan();
      if (!span) return obj;
      const ctx = span.spanContext();
      return { ...obj, trace_id: ctx.traceId, span_id: ctx.spanId };
    },
  },
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "*.password",
      "*.passwordHash",
      "*.token",
      "*.accessToken",
      "*.refreshToken",
      "*.cpf",
      "*.creditCard",
    ],
    censor: "[REDACTED]",
  },
  // Drizzle wraps the driver error and stashes the real `pg` error (with
  // `code`/`detail`/`constraint`/`table`/`column`) on `.cause`. The default
  // `err` serializer only flattens the top-level error, so those diagnostics
  // are lost — `errWithCause` recurses the cause chain and surfaces them.
  serializers: { err: pino.stdSerializers.errWithCause },
  timestamp: pino.stdTimeFunctions.isoTime,
});
```

> **Gotcha — DB errors log as "Failed query" with no pg code.** Without the
> `errWithCause` serializer above, a Drizzle/`pg` failure logs only the wrapper
> message + bound params; the pg `code`/`detail`/`constraint` live on `err.cause`
> and the default serializer drops them. Note `err.cause.detail` is **not** in the
> redact allow-list, so a constraint-violation detail can echo row values
> (e.g. `Key (email)=(...) already exists`) — acceptable for debugging today.

### 6.2 No Fastify

```ts
const app = Fastify({
  logger,
  disableRequestLogging: true,
  genReqId: (req) => (req.headers["x-request-id"] as string) ?? crypto.randomUUID(),
});

app.addHook("onResponse", (req, reply, done) => {
  req.log.info({
    req: {
      method: req.method,
      url: req.url,
      route: req.routerPath,
      ip: req.ip,
    },
    res: {
      statusCode: reply.statusCode,
      duration_ms: reply.elapsedTime,
    },
  }, "request.completed");
  done();
});
```

### 6.3 Níveis

- `trace` — nunca em prod
- `debug` — debug temporário, ligado por flag
- `info` — eventos de negócio importantes (`user.created`, `booking.confirmed`, `request.completed`)
- `warn` — degradação, fallback, retry
- `error` — erro tratado mas anômalo
- `fatal` — vai derrubar o processo

### 6.4 O que **não** logar

- Body de request inteiro
- Stack trace em `info` (só em `error`/`fatal`)
- PII bruta
- Senha, token, hash, cartão — **nunca**

### 6.5 CloudWatch Logs Insights

```
fields @timestamp, level, msg, trace_id, req.route, res.statusCode, res.duration_ms
| filter level = "error"
| sort @timestamp desc
| limit 50
```

---

## 7. Health checks

### 7.1 `/health/live` — liveness

Responde 200 se o processo está vivo. **Não toca em DB.**

```ts
app.get("/health/live", { logLevel: "silent" }, async () => ({ status: "ok" }));
```

### 7.2 `/health/ready` — readiness

Verifica dependências críticas. ALB health check aponta pra aqui.

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

Durante shutdown, `isReady=false` sinaliza ALB antes de fechar conexões — veja [`OPERATIONS.md`](./OPERATIONS.md#graceful-shutdown).

### 7.3 `@fastify/under-pressure`

```ts
app.register(import("@fastify/under-pressure"), {
  maxEventLoopDelay: 1000,
  maxHeapUsedBytes: 1_000_000_000,
  maxRssBytes: 1_500_000_000,
  retryAfter: 50,
});
```

Sob pressão, responde 503 automaticamente.

---

## 8. Correlação ponta-a-ponta

Cada request **gera ou propaga** um `trace_id`. Aparece em:

1. Span raiz do OTel (visível no X-Ray).
2. Todos os logs do request (via formatter do Pino) — visível no CloudWatch Logs.
3. Header de response (`x-trace-id`).
4. Headers de chamadas downstream (`traceparent` + `X-Amzn-Trace-Id`).
5. SQS messages — incluído em `MessageAttributes` para o consumer continuar o trace.

Em incidente:
1. User reporta erro com `traceId: 1-abc-123`.
2. Busca no X-Ray por esse id → trace completo (HTTP → service → DB → S3).
3. CloudWatch Logs Insights com `filter trace_id = "1-abc-123"` → todos os logs do request.

---

## 9. Dashboards mínimos (CloudWatch)

Dashboard por serviço com:

1. **RED** — Rate, Errors, Duration (p50/p95/p99) por rota
2. **DB** — pool usage, query duration, conexões em waiting
3. **Processo** — event loop lag, heap, RSS, CPU, GC
4. **Negócio** — métricas customizadas do domínio
5. **Gateways externos** — latência por upstream, error rate

Alertas mínimos via **CloudWatch Alarms** (→ SNS → Slack/PagerDuty):
- Error rate > 1% por 5 min
- p99 > 200ms por 5 min
- Pool DB > 90% por 2 min
- Event loop lag p99 > 100ms por 5 min
- DLQ com mensagens > 0
- Healthcheck failing por 3 min

**Os alarmes de Error rate e p99 são usados pelo CodeDeploy** para rollback automático — veja [`DEPLOYMENT.md`](./DEPLOYMENT.md#rollback-automático).
