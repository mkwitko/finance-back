# INTEGRATIONS.md — Cognito, S3, SQS/SNS, Serviços Internos

> Toda chamada externa passa por um **gateway**. Services não conhecem AWS SDK nem `undici` diretamente. Gateways ficam em `app.gateways` (decorator Fastify) e são passados como `deps` para services que precisam.

---

## 1. Por que gateways

1. **Testabilidade.** Sobrescrevemos `app.gateways.x` em teste por uma versão fake — sem mockar SDK inteiro.
2. **Trocabilidade.** Se trocarmos Cognito por outro IdP, mudamos o gateway, não os services.
3. **Observabilidade.** Spans são injetados pela auto-instrumentation do AWS SDK/undici (sem wrapper manual no gateway).
4. **Resiliência centralizada.** Retry/timeout/circuit breaker (via `createHttpPolicy`) ficam no gateway.

**Regra geral:**

```
controller → app.gateways.x → [retry/timeout + auto-span] → SDK / HTTP → resposta tipada
                ↘ ou ↙
              service(input, { x: app.gateways.x }) → ...
```

---

## 2. Autenticação — Cognito

**Cognito é fonte da verdade.** Não temos tabela de senha. Validamos JWT do Cognito em todo request autenticado.

### 2.1 Gateway

```ts
// src/gateways/cognito/cognito.gateway.ts
import { CognitoJwtVerifier } from "aws-jwt-verify";
import {
  FetchError,
  JwksNotAvailableInCacheError,
  WaitPeriodNotYetEndedJwkError,
} from "aws-jwt-verify/error";
import { ServiceUnavailableError, UnauthorizedError } from "@/shared/errors";

// Falhas de fetch/cache do JWKS são problemas transitórios de infra
// (Cognito indisponível, JWKS ainda não em cache), NÃO tokens inválidos.
// Mapeá-las para 401 rejeitaria tokens válidos e esconderia outages; mapeamos
// para 503 para que o cliente re-tente e a falha fique visível na observabilidade.
function isTransientVerifyError(err: unknown): boolean {
  return (
    err instanceof FetchError ||
    err instanceof JwksNotAvailableInCacheError ||
    err instanceof WaitPeriodNotYetEndedJwkError
  );
}

export type CognitoClaims = {
  sub: string;
  username: string;
  permissions: Permission[];
};

export interface CognitoGateway {
  verifyToken(token: string): Promise<CognitoClaims>;
}

export function createCognitoGateway(opts: {
  userPoolId: string;
  clientId: string;
  graceSeconds?: number; // folga p/ exp/nbf/iat; default 0 (estrito)
}): CognitoGateway {
  const verifier = CognitoJwtVerifier.create({
    userPoolId: opts.userPoolId,
    clientId: opts.clientId,
    // A plataforma emite ID tokens (token_use: "id"): identidade = `sub`,
    // username em `name`, roles em `authorities`.
    tokenUse: "id",
    graceSeconds: opts.graceSeconds ?? 0,
  });

  return {
    async verifyToken(token) {
      let payload: Awaited<ReturnType<typeof verifier.verify>>;
      try {
        payload = await verifier.verify(token);
      } catch (err) {
        if (isTransientVerifyError(err)) {
          // Preserva a causa raiz para logs via `cause` sem expor ao cliente.
          const e = new ServiceUnavailableError("auth_provider_unavailable");
          e.cause = err;
          throw e;
        }
        throw new UnauthorizedError("invalid_token");
      }

      const name = payload.name;
      return {
        sub: payload.sub,
        username: typeof name === "string" ? name : payload.sub,
        permissions: parseAuthorities(payload.authorities),
      };
    },
  };
}
```

> **Sem tenant no token.** O ID token real **não traz id de empresa/tenant**. A identidade é o `sub`; a empresa do usuário é resolvida no DB local pelo módulo **users** (`requireCaller` em `src/http/api/users/`). O gateway não checa nem exige tenant.

> **Bypass de expiração em dev.** Com `AUTH_DEV_BYPASS_TOKEN_EXP=true` o `gateways-plugin` passa um `graceSeconds` grande (~10 anos) ao gateway, então um ID token real do Cognito não expira durante a sessão de dev. Assinatura, issuer, `client_id` e `token_use` **continuam validados** — só `exp` é relaxado. O plugin **ignora a flag quando `NODE_ENV === 'production'`**, então nunca enfraquece auth em prod.

### 2.2 Hook de autenticação

`authHook` é um `preHandlerHookHandler` registrado **globalmente** em `src/http/index.ts`. `req.user` é augmentado em `src/types/fastify-augment.d.ts` como `{ sub, username, email?, phone?, permissions: Permission[] }` (email/phone vêm das claims do id token). `requireUser(req)` garante o usuário presente dentro do handler.

```ts
// src/http/index.ts (trecho relevante)
app.get('/health', { config: { public: true, rateLimit: false } }, async () => ({ status: 'ok' }));
app.addHook('preHandler', authHook);
app.addHook('preHandler', permissionsHook);
await app.register(bookingsRoutes);
```

Toda rota dentro de `httpRoutes` é autenticada. Para sair desse default em rotas verdadeiramente públicas, declare `config: { public: true }` — o hook detecta e retorna sem verificar token. O código completo do hook está em `src/http/hooks/auth/auth.ts`.

**Extração do token.** A plataforma envia o token **cru** no `Authorization` (sem `Bearer`); `extractToken(req)` (exportado) tolera o esquema `Bearer` opcional e retorna o token. Controllers que precisam **repassar** o token do caller a um gateway upstream (ex.: agencies) usam `extractToken(req)`.

### 2.3 Uso na rota

```ts
import { authHook, requireUser } from "@/http/hooks/auth";

app.post("/users/me/preferences", {
  preHandler: authHook,
  schema: { /* ... */ },
}, async (req, reply) => {
  const { sub } = requireUser(req);
  await updatePreferences({ cognitoSub: sub, preferences: req.body });
  return reply.code(204).send();
});
```

### 2.4 Sincronia com tabela `users` local (padrão lookup-vs-provision)

Dados de usuário no DB local (empresa, perfil de negócio) são **referenciados por `cognito_sub`**. O slice `src/http/api/users/` é o **dono da identidade**, com dois caminhos distintos:

- **Lookup (data puro, não cria nada).** O repositório expõe um `resolveCallerBySub(sub)` que faz left-join users×companies e retorna um discriminated union — `{ kind: 'found' }` | `{ kind: 'no_user' }` | `{ kind: 'company_inactive' }`. O **throw** mora numa camada feature (`requireCaller`), não no repositório: mapeia `no_user` → `AUTH.USER_NOT_PROVISIONED` (403) e `company_inactive` → `ORG.COMPANY_INACTIVE` (403, ciclo de vida da empresa, fora do namespace AUTH).
- **Provision (idempotente, race-safe).** Um `provisionCaller(...)` faz upsert transacional de company + user. É chamado **só** pelo bootstrap de 1º acesso — as demais rotas são **lookup-only**: recebem `usersRepo` via deps e chamam `requireCaller`, nunca provisionam (quem não passou pelo bootstrap recebe 403).

O **gatilho de bootstrap** (qual rota provisiona, qual serviço externo é consultado, como se mapeia tipo de empresa) é **específico do projeto** — ver [`PROJECT.md` §6](./PROJECT.md#6-identidade-e-bootstrap-específico). Padrão alternativo (futuro): Cognito Post-Confirmation Lambda → SNS → SQS → worker cria o user local.

**`cognito_sub` é a chave estrangeira; nunca duplique senha ou hash localmente.**

### 2.5 Autorização (permissões — padrão persona)

**Modelo:** toda permissão é uma **persona** — descreve *quem o usuário é*, não *qual ação ele executa*. Strings seguem o padrão `DOMINIO:PERSONA` em UPPER_SNAKE_CASE com `:` como separador.

O catálogo (`src/shared/permissions/catalog.ts`) agrupa as personas por **sistema** — a chave de sistema espelha o nome do serviço que o Cognito entrega no claim `authorities.<SISTEMA>`. Estrutura (valores ilustrativos; o catálogo real do projeto está em [`PROJECT.md` §3](./PROJECT.md#3-catálogo-de-permissões-personas)):

```ts
// src/shared/permissions/catalog.ts — forma (não os valores reais)
export const PERMISSIONS = {
  // <SISTEMA> espelha authorities.<SISTEMA> do token; parseado p/ '<SISTEMA>:<role>'
  EXEMPLO_API: {
    APP_USER:   'EXEMPLO_API:APP_USER',
    ADMIN:      'EXEMPLO_API:ADMIN',
    SYS_ADMIN:  'EXEMPLO_API:SYS_ADMIN',
  },
} as const;

type ValuesOf<T> = T[keyof T];
export type Permission = ValuesOf<ValuesOf<typeof PERMISSIONS>>;

export const ALL_PERMISSIONS: readonly Permission[] = Object.values(PERMISSIONS)
  .flatMap((g) => Object.values(g));
```

> **Por que persona, não ação fina (`BOOKING:CREATE`).** Personas representam papéis estáveis (administrador, usuário do app); ações finas mudam toda hora ("criar reserva" pode virar "criar pré-reserva" + "confirmar"). Cada endpoint declara **quais personas podem acessá-lo**; a relação "criar X = `ADMIN`" mora no endpoint, não no claim. Quando a regra muda, mexe-se no endpoint, não no User Pool. Ver [`DECISIONS.md`](./DECISIONS.md#adr-022-padrão-persona-para-permissões-sem-ações-finas).

**Como permissões chegam ao request:**

1. Cognito coloca as roles no claim `authorities` — **string JSON aninhada por serviço**, ex.: `'{"HOTEL_API":["HOTEL_ADMIN","APP_USER"],"BOOKING_API":["..."]}'`.
2. O `cognitoGateway` (`parseAuthorities`) faz parse do JSON, achata **todos** os serviços para `<SISTEMA>:<role>` e **filtra contra `ALL_PERMISSIONS`** (roles fora do catálogo, ou de serviços sem entrada no catálogo, são descartadas silenciosamente). Adicionar um serviço novo = só adicionar no catálogo. JSON inválido/ausente → `[]`.
3. `authHook` atribui `req.user.permissions: Permission[]`.

**Declaração na rota** — toda rota autenticada **precisa** declarar `config.permissions`:

```ts
import { PERMISSIONS } from "@/shared/permissions/catalog";
const SYS = PERMISSIONS.EXEMPLO_API; // <SISTEMA> real do projeto: ver catalog.ts / PROJECT.md §3

// "Personas que podem criar: admin ou sys admin"
app.post('/bookings', {
  config: { permissions: { any: [SYS.ADMIN, SYS.SYS_ADMIN] } },
  schema: { body: CreateBookingBody },
}, handler);

// "Apenas sys admin pode ver tudo"
app.get('/admin/audit', {
  config: { permissions: { all: [SYS.SYS_ADMIN] } },
}, handler);

// "Service-to-service / operação restrita: precisa ser SYS_ADMIN"
app.post('/internal/sync', {
  config: { permissions: { all: [SYS.SYS_ADMIN] } },
}, handler);
```

Semântica:
- `any`: OR — usuário precisa ter **pelo menos uma** das personas listadas. **É o caso comum** (a maioria dos endpoints aceita múltiplas personas).
- `all`: AND — usuário precisa ter **todas** as personas. Raro; geralmente para endpoints com restrição combinada.
- Ambos presentes: ambos precisam passar.
- Não declarar (ausente ou arrays vazios): 403 `AUTH-T0010` em runtime — força o desenvolvedor a declarar conscientemente.

**Tipagem:** o campo `permissions` é `readonly Permission[]`. Passar string fora do catálogo é erro de TypeScript no build. Não há concessão para "permissões dinâmicas" no código.

**Catálogo é a fonte da verdade compartilhada.** Backend exporta o tipo `Permission` no OpenAPI (via `z.enum(ALL_PERMISSIONS)` no schema do endpoint `GET /me/permissions`). O frontend consome esse tipo via Kubb — **sem replicar o catálogo**. Adicionar uma persona nova = update no User Pool + adicionar no `PERMISSIONS` + commit → frontend regenera tipos e o autocomplete já mostra a nova. Remover = TypeScript aponta usos no front.

**Endpoint para o frontend:**

```ts
// src/http/api/me/get-permissions/get-permissions.controller.ts
import { z } from "zod/v4";
import { ALL_PERMISSIONS, PERMISSIONS } from "@/shared/permissions/catalog";

const PermissionLiteral = z.enum(ALL_PERMISSIONS);
// registra o schema como reutilizável → jsonSchemaTransformObject o emite como $ref "Permission"
z.globalRegistry.add(PermissionLiteral, { id: "Permission" });

const Response = z.object({
  permissions: z.array(PermissionLiteral),
});

app.withTypeProvider<ZodTypeProvider>().get('/me/permissions', {
  config: {
    // qualquer pessoa autenticada pode ler suas próprias personas
    permissions: { any: [...ALL_PERMISSIONS] },
  },
  schema: { response: { 200: Response } },
}, async (req) => ({ permissions: requireUser(req).permissions }));
```

Erros relacionados: `AUTH-T0010` (rota sem `config.permissions`), `AUTH-T0011` (usuário sem persona necessária). Ver [`ERRORS.md`](./ERRORS.md).

---

## 3. Storage — S3

### 3.1 Gateway

```ts
// src/gateways/s3/s3.gateway.ts
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export interface S3Gateway {
  presignUpload(key: string, contentType: string, expiresIn?: number): Promise<string>;
  presignDownload(key: string, expiresIn?: number): Promise<string>;
}

export function createS3Gateway(opts: {
  region: string;
  bucket: string;
  endpoint?: string;
}): S3Gateway {
  const client = new S3Client({
    region: opts.region,
    // Em dev, aponta pro LocalStack
    ...(opts.endpoint ? { endpoint: opts.endpoint, forcePathStyle: true } : {}),
  });

  return {
    async presignUpload(key, contentType, expiresIn = 900) {
      const cmd = new PutObjectCommand({ Bucket: opts.bucket, Key: key, ContentType: contentType });
      return getSignedUrl(client, cmd, { expiresIn });
    },
    async presignDownload(key, expiresIn = 900) {
      const cmd = new GetObjectCommand({ Bucket: opts.bucket, Key: key });
      return getSignedUrl(client, cmd, { expiresIn });
    },
  };
}
```

> O bucket é fixado na factory; os métodos recebem só `key`/`contentType`. `expiresIn` default = 900s. Falhas do SDK propagam como `BadGatewayError` quando envolvidas via `badGateway(...)` (ver §8).

### 3.2 Padrão: uploads de usuário (presigned URL)

```ts
// src/http/uploads/create-avatar-upload/create-avatar-upload.controller.ts
export const createAvatarUploadController: FastifyPluginAsync = async (app) => {
  app.withTypeProvider<ZodTypeProvider>().post("/users/me/avatar/upload-url", {
    preHandler: authHook,
    schema: { /* body { contentType }, response { url, key } */ },
  }, async (req, reply) => {
    const { sub } = requireUser(req);
    const result = await createAvatarUpload(
      { cognitoSub: sub, contentType: req.body.contentType },
      { s3: app.gateways.s3 },
    );
    return reply.send(result);
  });
};
```

```ts
// create-avatar-upload.service.ts
import type { S3Gateway } from "@/gateways/s3/s3.gateway";
import { ValidationError } from "@/shared/errors";

const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export const createAvatarUpload = async (
  input: { cognitoSub: string; contentType: string },
  deps: { s3: S3Gateway },
) => {
  if (!ALLOWED_TYPES.has(input.contentType)) {
    throw new ValidationError("invalid content type");
  }

  // O bucket já está fixado na factory do gateway; passamos só key + contentType.
  const key = `users/${input.cognitoSub}/avatar/${crypto.randomUUID()}`;
  const url = await deps.s3.presignUpload(key, input.contentType, 300);
  return { url, key };
};
```

### 3.3 Convenções

- Buckets privados. Acesso só via presigned URL.
- Chaves hierárquicas: `users/<cognitoSub>/avatar/<uuid>.jpg`.
- Nunca expor IDs sequenciais.
- Buckets separados por finalidade: `myapp-user-uploads`, `myapp-app-assets`.

---

## 4. Filas — SQS + SNS

**Padrão:** SNS para fan-out, SQS para entrega ao consumer.

### 4.1 Gateway (send)

O span OTel é injetado pela auto-instrumentation do AWS SDK (ver OBSERVABILITY.md), não por wrapper manual. `attrs` é um `Record<string, string>` simples mapeado para `MessageAttributes` do tipo `String`.

```ts
// src/gateways/sqs/sqs.gateway.ts
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { badGateway } from "@/shared/errors";

export interface SqsGateway {
  send<T>(queueUrl: string, body: T, attrs?: Record<string, string>): Promise<void>;
}

export function createSqsGateway(opts: { region: string; endpoint?: string }): SqsGateway {
  const client = new SQSClient({
    region: opts.region,
    ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
  });

  return {
    async send(queueUrl, body, attrs) {
      try {
        await client.send(
          new SendMessageCommand({
            QueueUrl: queueUrl,
            MessageBody: JSON.stringify(body),
            MessageAttributes: attrs
              ? Object.fromEntries(
                  Object.entries(attrs).map(([k, v]) => [
                    k,
                    { DataType: "String", StringValue: v },
                  ]),
                )
              : undefined,
          }),
        );
      } catch (err) {
        // Mapeia a falha bruta do SDK para um 502 tipado; preserva a causa para logs.
        throw badGateway("sqs_send_failed", err);
      }
    },
  };
}
```

### 4.2 Consumer (worker)

Use a lib **`sqs-consumer`**:

```ts
// src/workers/booking-created/booking-created.consumer.ts
import { Consumer } from "sqs-consumer";
import { SQSClient } from "@aws-sdk/client-sqs";
import { logger } from "@/infra/observability/logger";
import { env } from "@/config/env";
import { BookingCreatedPayload } from "./booking-created.schema";
import { handleBookingCreated } from "./booking-created.handler";

export const startBookingCreatedConsumer = () => {
  const sqs = new SQSClient({
    region: env.AWS_REGION,
    ...(env.AWS_ENDPOINT_URL ? { endpoint: env.AWS_ENDPOINT_URL } : {}),
  });

  const consumer = Consumer.create({
    queueUrl: env.SQS_BOOKING_CREATED_URL,
    sqs,
    batchSize: 10,
    visibilityTimeout: 60,
    waitTimeSeconds: 20,
    handleMessageBatch: async (messages) => {
      const succeeded = [];
      for (const msg of messages) {
        try {
          const raw = JSON.parse(msg.Body ?? "{}");
          const parsed = BookingCreatedPayload.safeParse(raw);
          if (!parsed.success) {
            logger.error(
              { messageId: msg.MessageId, errors: parsed.error.issues },
              "sqs.invalid_payload",
            );
            // Não succeeded → fica no batch, vai para DLQ depois do max receive count
            continue;
          }
          await handleBookingCreated(parsed.data);
          succeeded.push(msg);
        } catch (err) {
          logger.error({ err, messageId: msg.MessageId }, "worker.handler_failed");
          // Não succeeded → SQS retentará
        }
      }
      return succeeded;
    },
  });

  consumer.on("error", (err) => logger.error({ err }, "consumer.error"));
  consumer.on("processing_error", (err) => logger.error({ err }, "consumer.processing_error"));

  consumer.start();
  return consumer;
};
```

### 4.3 Handler (função pura)

```ts
// src/workers/booking-created/booking-created.handler.ts
import { logger } from "@/infra/observability/logger";
import { bookingsRepository } from "@/http/bookings/bookings.repository";
import type { BookingCreatedPayload } from "./booking-created.schema";

export const handleBookingCreated = async (payload: BookingCreatedPayload) => {
  // Idempotência
  const exists = await bookingsRepository.findProcessed(payload.bookingId);
  if (exists) {
    logger.info({ bookingId: payload.bookingId }, "worker.already_processed");
    return;
  }

  // ... lógica
  logger.info({ bookingId: payload.bookingId }, "worker.booking_processed");
};
```

### 4.4 Regras de ouro

- **Idempotência sempre.** Mensagem pode ser entregue 2+ vezes. Use `messageId` ou chave de negócio + tabela `processed_events`.
- **DLQ configurada.** Após N falhas (tipicamente 5), mensagem vai pra DLQ. CloudWatch alarm dispara.
- **Visibility timeout > tempo máximo de processamento.** Se função demora 30s, visibility ≥ 60s.
- **Trace propagation.** OTel auto-instrumentation injeta `traceparent` no `MessageAttributes` quando enviado e extrai no consumer.

### 4.5 Worker no mesmo processo do API?

**Sim, por padrão.** Em `server.ts`:

```ts
import { startBookingCreatedConsumer } from "./workers/booking-created/booking-created.consumer";

const consumer = startBookingCreatedConsumer();

// no shutdown:
await consumer.stop({ abort: false });
```

Para separar (carga justifica): mesmo binário, flag `WORKER_ONLY=true` que pula `app.listen()` e roda só consumers.

### 4.6 Eventos de domínio via outbox transacional

Services **não** publicam no SNS diretamente. Eventos como `booking.created` / `booking.confirmed` são gravados na tabela `outbox` na **mesma transação** da escrita (ver ARCHITECTURE.md §5.1), e o relay em `src/workers/outbox-relay/` os publica no SNS de forma assíncrona, marcando `published_at`. Assim o evento só existe se a transação commitou, e a publicação é re-tentável sem perder eventos. O `SnsGateway` continua sendo o ponto de publicação — só que chamado pelo relay, não pelo service.

---

## 5. Serviços HTTP internos

Serviços internos do ambiente (ex.: **agencies**, **hospitality**; o conjunto real do projeto está em [`PROJECT.md` §5](./PROJECT.md#5-gateways-e-env-concretos)) são chamados via gateway undici + `createHttpPolicy()`. Cada gateway interno mora sob `src/gateways/internal/<serviço>/` e **compartilha a plumbing HTTP** em `internal/shared/internal-client.ts`. O gateway só **compõe**; a chamada de cada endpoint vive numa subpasta por recurso sob `routes/`:

```
src/gateways/internal/
├── shared/
│   ├── internal-client.ts     # createInternalApiClient({ baseUrl, name }): getJson/postJson/postWriteJson/putJson/patchJson — policy read|write + mapeamento de erro (compartilhado por todos os internos)
│   └── proxy-route.ts         # companyScopedProxyRoute: rota proxy thin company-scoped (path /:id + ownership da própria empresa); forward recebe os gateways → serve qualquer interno
├── agencies/
│   ├── agencies.gateway.ts    # interface + factory (compõe; sem lógica de endpoint)
│   ├── agencies.routes.ts     # registra os controllers proxy no router
│   └── routes/company-infos/get-company-info/
│       ├── get-company-info.ts             # schema Zod tolerante + getCompanyInfo({ client, token, alphaId })
│       ├── get-company-info.controller.ts  # companyScopedProxyRoute({ path: '/company-infos/:alphaId', forward })
│       └── get-company-info.test.ts        # MockAgent
└── hospitality/
    ├── hospitality.gateway.ts
    ├── hospitality.routes.ts
    ├── routes/agencies/list-served-by-agencies/
    │   ├── list-served-by-agencies.ts             # listServedByAgencies(token) → GET agencies-all?listServedBy=true (encaminha token do caller); filtra type==='AGENCY' + projeta { alphaId, companyId, name }
    │   ├── list-served-by-agencies.controller.ts  # rota inline GET /hospitality/agencies (app.get; persona WEB_USER; encaminha token do caller — extractToken(req))
    │   └── list-served-by-agencies.test.ts        # MockAgent
    ├── routes/amenities-categories/list-amenities-categories/
    │   ├── list-amenities-categories.ts             # listAmenitiesCategories(token) → GET amenities-categories (encaminha token do caller); desembrulha envelope { data } + projeta categorias + amenities aninhadas + label
    │   ├── list-amenities-categories.controller.ts  # rota inline GET /hospitality/amenities-categories (app.get; persona WEB_USER; encaminha token do caller — extractToken(req))
    │   └── list-amenities-categories.test.ts        # MockAgent
    └── routes/hotels/get-hotel-details/
        ├── get-hotel-details.ts             # getHotelDetails({ client, token, alphaId }) → GET hotels/{alphaId} (encaminha token do caller); desembrulha envelope { data } + schema Zod tolerante (só alphaId obrigatório, objeto loose `z.looseObject` em cada nó)
        ├── get-hotel-details.controller.ts  # rota inline GET /hospitality/hotel/details/:id (app.get; persona WEB_USER; NÃO company-scoped — hotel não é a empresa do caller; params { id })
        └── get-hotel-details.test.ts        # MockAgent
└── datalake/
    ├── datalake.gateway.ts
    ├── datalake.routes.ts
    ├── routes/dataset/search-dataset/
    │   ├── search-dataset.ts             # schema Zod request (DSL: criteria/terms/sort) + response + searchDataset({ client, token, input }) → POST dataset/search (token cru do caller)
    │   ├── search-dataset.controller.ts  # rota inline POST /datalake/search (app.post; persona WEB_USER; body validado; strict rate-limit por ser POST — query cara)
    │   └── search-dataset.test.ts        # MockAgent
    └── routes/hotels/search-hotels/
        ├── search-hotels.ts             # endpoint PRONTO (typed): chama gateways.datalake.searchDataset com tabela fixa rfp_hotel + filtro is_hotel_active + janela 1 mês; coage linhas string→tipos nativos (camelCase). cityId opcional (todas cidades), hotelName LIKE
        ├── search-hotels.controller.ts  # rota inline GET /datalake/search/hotels (persona WEB_USER; query cityId?/hotelName?)
        └── search-hotels.test.ts        # service puro (fake gateway)
```

Os endpoints sob `datalake/` têm dois níveis: **genérico** (`search-dataset` — proxy 1:1 do DSL) e **prontos** (`search-hotels` — tabela/filtros fixos + saída tipada/coagida pro frontend). Um endpoint pronto **consome** o método do gateway (`searchDataset`), não a rede direto; a coerção string→tipo nativo vive no op.

```ts
// agencies.gateway.ts — composição (passa name p/ rotular logs/erros do upstream)
export function createAgenciesGateway(opts: { baseUrl: string }): AgenciesGateway {
  const client = createInternalApiClient({ baseUrl: opts.baseUrl, name: 'agencies' });
  return { listCompanyInfos: ({ sub, token }) => listCompanyInfos({ client, token }) };
}

// routes/company-infos/list-company-infos/list-company-infos.ts — operação (path + tipo, sem plumbing)
export function listCompanyInfos({ client, token }: { client: InternalApiClient; token: string }): Promise<CompanyInfosList> {
  return client.getJson('company-infos/list', token) as Promise<CompanyInfosList>;
}

// shared/internal-client.ts — plumbing compartilhada (essência)
async function getJson(url, token, signal) {
  const res = await request(url, {
    method: 'GET',
    // APIs internas esperam o token CRU em Authorization, sem o esquema `Bearer`.
    headers: { authorization: token, accept: 'application/json' },
    signal, // a policy injeta o signal de timeout/abort
  }); // rede falha -> withCause(ERRORS.SYS.SERVICE_UNAVAILABLE) (retryable)
  const { statusCode, body } = res;
  if (statusCode >= 200 && statusCode < 300) return body.json(); // body inválido -> nonRetryable BAD_GATEWAY
  await body.dump();
  if (statusCode >= 400 && statusCode < 500) throw nonRetryable(ERRORS.SYS.BAD_GATEWAY({ statusCode }));
  throw ERRORS.SYS.SERVICE_UNAVAILABLE({ statusCode }); // 5xx: retryable
}
```

**Pontos importantes:**
- **Gateway = composição.** `<serviço>.gateway.ts` não tem chamada HTTP; só monta o client e fia as operações. Endpoint novo = arquivo novo na subpasta do recurso (`routes/`) + uma linha no factory.
- **Client compartilhado entre internos.** `internal/shared/internal-client.ts` (`createInternalApiClient({ baseUrl, name })` → `getJson`/`postJson`/`postWriteJson`/`putJson`/`patchJson`) concentra base-URL join, **dois breakers (`read` | `write`)** e o mapeamento de erro; `name` rotula o upstream nos logs/erros. As operações só conhecem path + tipo de resposta. Gateway novo interno = reusa este client, não cria plumbing.
- **Verbo × retry.** Breaker `read` (`getJson`, `postJson`) **retenta** transientes (rede/5xx); breaker `write` (`postWriteJson`, `putJson`, `patchJson`) tem retry DESLIGADO. `postJson` é só para queries idempotentes (ex.: datalake `dataset/search`); para um POST que **cria/muda estado** use `postWriteJson`; `putJson` (replace) e `patchJson` (write parcial) também não retentam. Separar os breakers impede que falha de write derrube reads saudáveis.
- **Proxy company-scoped compartilhado.** `internal/shared/proxy-route.ts` (`companyScopedProxyRoute`) monta uma rota thin para recurso com path id (`/company-infos/:alphaId`): exige ownership da própria empresa (`alphaId === companyAlphaId`) **antes** de qualquer chamada upstream; 403 senão. Suporta **leitura e escrita** — `method` (default `get`) + um `body` opcional (rota de escrita anexa o schema de body; sem ele, o body é repassado cru, ex. quando a coerção do Zod quebraria semântica de `null`). O `forward` recebe `gateways` + `token` + `alphaId` (+ `body` na escrita) → qualquer interno pode ser o alvo. A empresa do caller é resolvida pelo gateway **`companyContext`** (lê a chain no DB da agencies), independente do alvo do forward.
- **Proxy sem ownership = rota inline.** Lista/coleção sem path id (ex.: `GET /hospitality/agencies`) **e também recurso COM path id que não é da própria empresa** (ex.: `GET /hospitality/hotel/details/:id` — um hotel não é a empresa do caller) não usam o helper: o controller registra `app.get` direto (declara a persona exigida, schema `params` quando há path id, chama o gateway, `send(200)`). O helper `companyScopedProxyRoute` é só para o caso company-scoped (ownership `alphaId === companyAlphaId`), que concentra a lógica não-trivial — path id por si só não implica o helper.
- **Token interno (serviço-a-serviço).** Endpoint cujo upstream autoriza o **serviço RFP** (não o usuário final) não repassa cru o token do caller: o gateway **minta** um token HS256 por request (`iat` fresco — o upstream rejeita `iat` velho) com o segredo compartilhado `INTERNAL_TOKEN_SECRET` (**secret** — placeholder no `.env.example`). Helpers em `gateways/internal/shared/internal-token.ts`, **dois modos**: (1) **REPLACE** — `mintInternalToken(secret)`: claims fixos do RFP (`sub=RFP`), descarta a identidade do caller, authorities fixos `{"HOTEL_API":["SYS_INTERNAL","HOTEL_ADMIN"]}`; usado em chamadas service-scoped (todo o hospitality). (2) **ENRICH** — `enrichCallerToken(secret, callerToken, service?)`: mantém os claims do caller (identidade, `exp`, **e as próprias authorities**) e só **adiciona** `SYS_INTERNAL` ao serviço alvo (`service`, default `HOTEL_API_SERVICE`; agencies passa `BOOKING_API_SERVICE`) — mais quaisquer **roles extras específicas do serviço** (mapa `EXTRA_SERVICE_ROLES`; valores concretos em [`PROJECT.md` §5](./PROJECT.md#5-gateways--integrações-externas)) — re-emitindo como `iss=RFP`; usado quando o upstream deve atribuir a escrita/leitura ao caller (ambas as ops do gateway **agencies**: `list-company-infos` e `update-additional-data`). **Merge (não replace):** as authorities do caller são preservadas — ex. caller `{"HOTEL_API":["WEB_USER"]}` + serviço sem roles extras → `{"HOTEL_API":["WEB_USER"],"<SERVIÇO>":["SYS_INTERNAL"]}`; cria a chave do serviço se ausente, dedupe se a role já presente. **Dois tokens distintos:** (1) o token do caller autentica **quem** chama a nossa rota; (2) o token interno autoriza a **chamada upstream**.
- **Token por parâmetro.** `listCompanyInfos(token)` recebe o bearer a enviar — para este endpoint é o ID token do próprio caller; outras operações podem passar token diferente/enriquecido. O gateway não conhece `req`.
- **Erros via catálogo** (`ERRORS.SYS.BAD_GATEWAY` 502 / `SERVICE_UNAVAILABLE` 503), nunca `new AppError`. `withCause(factory, details, cause)` preserva a causa raiz em `cause` (logs) sem vazar ao cliente. **Contexto de debug fora de prod:** numa falha de request (conexão ou status), o `cause` recebe (via `externalErrorContext`, props enumeráveis que o `errWithCause` do Pino loga) a **URL externa completa** (path params + query), a `query` isolada e o **request body** — gated em `NODE_ENV !== 'production'` (body/URL podem ter dado sensível). O **token nunca** é incluído.
- **Retry vs não.** Rede/5xx ficam retryable (a policy retenta); 4xx e body malformado viram `nonRetryable()` (não retenta, não conta no breaker).
- **Base URL com path.** `new URL('company-infos/list', base)` com barra final preservada → não derruba o prefixo `/agency/v1/`.
- **Env.** A base-URL do serviço (ex. `AGENCIES_BASE_URL`) é required em `src/config/env.ts` e injetada no `buildDefaultGateways()`. Inventário no [`PROJECT.md` §5](./PROJECT.md#5-gateways-e-env-concretos).
- **Teste:** `undici` `MockAgent` colocado com a operação (`routes/<recurso>/<op>/<op>.test.ts`) — `setGlobalDispatcher(mockAgent)`, intercepta origin+path, cobre 2xx/4xx-não-retry/5xx-retry/body-inválido. Padrão de teste para gateways HTTP (não MSW).

---

## 6. APIs externas de terceiros

Mesmo padrão, com:
1. Política de resilience mais conservadora (timeouts curtos, circuit breaker apertado).
2. Idempotência explícita (`Idempotency-Key` header se o provider suportar).

```ts
// Timeouts curtos para um provider externo, marcando erros de contrato como não-retryable.
const externalPolicy = createHttpPolicy({ retries: 3, timeoutMs: 5_000 });
```

---

## 7. Resiliência (Cockatiel) — política HTTP via factory

A resiliência é uma **factory** `createHttpPolicy`, não policies nomeadas. Ela compõe circuit breaker + retry + timeout num `wrap`, e só retenta erros que **não** foram marcados via `nonRetryable()`. Defaults: `retries = 2`, `timeoutMs = 5000`.

```ts
// src/infra/resilience/policies.ts
import {
  ConsecutiveBreaker,
  circuitBreaker,
  ExponentialBackoff,
  handleWhen,
  retry,
  TimeoutStrategy,
  timeout,
  wrap,
} from "cockatiel";

const NON_RETRYABLE = Symbol("cockatiel.nonRetryable");

/**
 * Marca um erro como não-retryable: o {@link createHttpPolicy} não o re-tenta
 * nem o conta no circuit breaker. Use para falhas que não se recuperam em retry
 * (4xx client errors, response bodies malformados/inválidos).
 */
export function nonRetryable<E extends Error>(err: E): E {
  Object.defineProperty(err, NON_RETRYABLE, { value: true, enumerable: false });
  return err;
}

// Retry por default — blips de rede e timeouts são transitórios. Só pula erros
// explicitamente marcados via `nonRetryable`.
function isRetryable(err: unknown): boolean {
  return !(err instanceof Error && NON_RETRYABLE in err);
}

export function createHttpPolicy(opts?: { retries?: number; timeoutMs?: number }) {
  const retries = opts?.retries ?? 2;
  const timeoutMs = opts?.timeoutMs ?? 5_000;

  const retryPolicy = retry(handleWhen(isRetryable), {
    maxAttempts: retries,
    backoff: new ExponentialBackoff({ initialDelay: 100, maxDelay: 2_000 }),
  });
  const timeoutPolicy = timeout(timeoutMs, TimeoutStrategy.Aggressive);
  const breakerPolicy = circuitBreaker(handleWhen(isRetryable), {
    halfOpenAfter: 10_000,
    breaker: new ConsecutiveBreaker(5),
  });

  return wrap(breakerPolicy, retryPolicy, timeoutPolicy);
}

export type HttpPolicy = ReturnType<typeof createHttpPolicy>;
```

**Quando NÃO usar retry:** operações não-idempotentes sem `Idempotency-Key` — marque o erro com `nonRetryable()`.

---

## 8. Checklist para uma integração nova

- [ ] Gateway criado em `src/gateways/<nome>/<nome>.gateway.ts`
- [ ] Factory function (`createXGateway(opts)`) + interface `XGateway` exportada
- [ ] Interface adicionada ao type `Gateways` em `src/types/fastify.ts`
- [ ] Wiring em `buildDefaultGateways()` (`src/http/plugins/gateways-plugin/gateways-plugin.ts`)
- [ ] Entrada no fake `buildFakeGateways()` (`test/mocks/gateways.fake.ts`)
- [ ] Tipos de input/output explícitos
- [ ] Envoltório com `createHttpPolicy(...)` quando for chamada HTTP (e `nonRetryable()` nos erros de contrato)
- [ ] Erros via catálogo `ERRORS.SYS.BAD_GATEWAY()` / `SERVICE_UNAVAILABLE()` (+ `withCause(...)`); nunca `new AppError`
- [ ] Span OTel via auto-instrumentation do SDK/undici (não wrapper manual)
- [ ] Em dev: aponta pro LocalStack via `endpoint` (se for AWS)
- [ ] Teste colocado com `undici` `MockAgent` (gateways HTTP) ou unit offline (SDK)
- [ ] Var (required) em `env.ts` **e** em todos os setups de env: `.env.example`, `docker/.env*`, `test/e2e/helpers/app.ts`, `vitest.integration.config.ts`, `src/config/env.test.ts`, e demais testes que dão boot — senão o boot falha em `parseEnv`
