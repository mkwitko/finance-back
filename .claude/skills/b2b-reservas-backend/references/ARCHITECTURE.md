# ARCHITECTURE.md — Camadas, Vertical Slice, Padrões

> Como o código é organizado e por quê. Leia antes de criar um caso de uso novo.

---

## 1. Princípios

1. **Vertical slice por caso de uso.** Cada operação (`create-user`, `update-booking`) é uma pasta auto-contida com controller + service + schema + teste.
2. **Repository compartilhado por recurso.** Queries são reutilizáveis entre use-cases do mesmo agregado.
3. **Simplicidade > pureza.** Sem DI container, sem `.execute`, sem separar route de controller. Menos arquivos, menos indireção.
4. **Domínio é puro.** Services não conhecem HTTP nem SQL diretamente.
5. **Composition over inheritance.** Sem classes abstratas. Funções e objetos simples.

---

## 2. Por que essas simplificações

### 2.1 Por que não separar `route.ts` de `controller.ts`

Fastify **já é route-based**. Quando você faz `app.post(...)`, está declarando a rota junto com o handler. Separar em dois arquivos só faz sentido quando o controller tem responsabilidade real de orquestração — o que raramente acontece em endpoints típicos. Para 95% dos casos, um arquivo é mais legível: você abre, lê a rota, schema e handler de uma vez.

Quando seria útil separar? Se a mesma lógica de handler atendesse a múltiplas rotas (HTTP + GraphQL, ou v1 + v2 da mesma operação). Não é o nosso caso.

### 2.2 Por que services como funções, sem `.execute`

Padrão `class XService { execute() }` veio de Java/Spring onde classes precisam existir pra DI funcionar. Em TS funcional, isso é overhead. `export const createUser = async (input) => { ... }` é a coisa em si. Para o caller, fica `await createUser({ ... })` — limpo.

### 2.3 Por que sem DI container

O propósito real de um "container" é permitir trocar dependências em teste. Resolvemos isso de duas formas mais simples:

- **Singletons importados** (`db`, `logger`): são globais de qualquer jeito. Em teste, trocamos via `vi.mock` ou criando uma instância test-specific quando precisamos isolar.
- **Gateways externos** (Cognito, S3, SQS, SNS, b2bUsers): expostos via decorator do Fastify (`app.gateways.cognito`). Em teste, sobrescrevemos passando gateways fakes na construção do app: `buildApp({ gateways: buildFakeGateways(...) })`.

Sem container. Sem framework de DI. Sem `reflect-metadata`. Sem `@Injectable`. Só imports e um decorator.

---

## 3. Anatomia de um caso de uso

Exemplo completo: `POST /bookings` (criação). O recurso canônico é `bookings` — não existe recurso `users` (identidade vem do Cognito; dados de usuário, do gateway `b2bUsers`).

```
src/http/api/bookings/create-booking/
├── create-booking.controller.ts   # rota + handler num arquivo só
├── create-booking.service.ts      # factory que retorna a função do caso de uso
├── create-booking.schema.ts       # Zod: Body, Response
└── create-booking.test.ts         # testa o service
```

### 3.1 `create-booking.schema.ts`

```ts
import { z } from "zod/v4";

export const CreateBookingBody = z.object({
  details: z.record(z.string(), z.unknown()),
});
export type CreateBookingBody = z.infer<typeof CreateBookingBody>;

export const CreateBookingResponse = z.object({
  id: z.uuid(),
  userId: z.string(),
  tenantId: z.string(),
  status: z.enum(["pending", "confirmed", "cancelled"]),
  details: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type CreateBookingResponse = z.infer<typeof CreateBookingResponse>;
```

### 3.2 `create-booking.controller.ts` — rota + handler

```ts
import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { env } from "../../../config/env.js";
import { db } from "../../../infra/db/client.js";
import { requireUser } from "../../hooks/auth.js";
import { createBookingsRepository } from "../bookings.repository.js";
import { CreateBookingBody, CreateBookingResponse } from "./create-booking.schema.js";
import { createBookingService } from "./create-booking.service.js";

export const createBookingRoute: FastifyPluginAsync = async (app) => {
  app.withTypeProvider<ZodTypeProvider>().post(
    "/bookings",
    {
      schema: {
        body: CreateBookingBody,
        response: { 201: CreateBookingResponse },
      },
    },
    async (req, reply) => {
      const service = createBookingService({
        repo: createBookingsRepository(db),
        b2bUsers: app.gateways.b2bUsers,
        topicArn: env.SNS_BOOKING_EVENTS_TOPIC_ARN,
      });
      const { sub, tenantId } = requireUser(req);
      const { details } = req.body; // já tipado via ZodTypeProvider — sem `as`
      const result = await service({ userId: sub, tenantId, details });
      void reply.code(201).send(result);
    },
  );
};
```

**Regras:**
- Arquivo único: rota, schema, handler. Tipo `FastifyPluginAsync`; a rota chama `app.withTypeProvider<ZodTypeProvider>()` (de `fastify-type-provider-zod`), então `req.body` (e `req.params`/`req.query`) já vêm **tipados** a partir dos schemas Zod — **sem `as`**. A validação roda pelo `validatorCompiler` setado no `buildApp` (§7).
- Handler é **fino**. Monta as deps do service, extrai input, chama service, formata response.
- Response schema **sempre** declarado — o `serializerCompiler` do `fastify-type-provider-zod` serializa a partir do schema Zod (muito mais rápido que `JSON.stringify` e poda campos fora do schema).
- Identidade via `requireUser(req)` → `{ sub, tenantId }` (não existe `app.authenticate` nem `req.user.sub` direto; a auth é aplicada pelo escopo autenticado — ver §7). `sub` vira `userId` do domínio.
- Não acessa DB diretamente (repo construído com `db`). Não importa AWS SDK (gateways vêm de `app.gateways`).

### 3.3 `create-booking.service.ts` — factory + função pura

Services são **factories**: recebem `deps` e retornam a função do caso de uso. Isso mantém o domínio puro e injeta repo/gateways sem DI container.

```ts
import type { B2bUsersGateway } from "../../../gateways/internal/b2b-users.gateway.js";
import { ForbiddenError, NotFoundError } from "../../../shared/errors.js";
import { bookingEvent } from "../bookings.events.js";
import type { BookingsRepository } from "../bookings.repository.js";
import type { Booking } from "../bookings.types.js";
import type { CreateBookingBody } from "./create-booking.schema.js";

export type CreateBookingDeps = {
  repo: BookingsRepository;
  b2bUsers: B2bUsersGateway;
  topicArn: string;
};

export type CreateBookingInput = CreateBookingBody & { userId: string; tenantId: string };

export function createBookingService(deps: CreateBookingDeps) {
  return async (input: CreateBookingInput): Promise<Booking> => {
    const user = await deps.b2bUsers.findById(input.userId);
    if (!user) throw new NotFoundError(`user ${input.userId} not found`);
    // O tenant do token é a fronteira de segurança; rejeite se o tenant do
    // diretório divergir, em vez de escrever num tenant ao qual ele não pertence.
    if (user.tenantId !== input.tenantId) {
      throw new ForbiddenError("tenant_mismatch");
    }

    // O evento é gravado no outbox na MESMA transação; um relay publica no SNS —
    // o service nunca publica direto. Ver §5.1.
    const { booking } = await deps.repo.insertWithOutbox(
      { userId: input.userId, tenantId: input.tenantId, details: input.details },
      bookingEvent("booking.created", deps.topicArn),
    );
    return booking;
  };
}
```

**Regras:**
- **Zero conhecimento de HTTP.** Não importa `fastify`, não recebe `req`/`reply`.
- **Zero SQL.** Conversa com `BookingsRepository` (recebido em `deps`, não importado).
- **Dependências via `deps`:** repo, gateways e config (`topicArn`) chegam pela factory. Sem singletons mágicos no service.
- Lança erros tipados de `@/shared/errors` (ver §6).

### 3.4 Quando o service precisa de gateway

Service não importa gateway direto (perde testabilidade). O controller pega do `app.gateways` e injeta na factory do service — o mesmo padrão de `create-booking` acima, que recebe `b2bUsers` (e poderia receber `s3`, `sns`, etc) em `deps`:

```ts
// no controller: monta as deps a partir de app.gateways
const service = createBookingService({
  repo: createBookingsRepository(db),
  b2bUsers: app.gateways.b2bUsers,
  topicArn: env.SNS_BOOKING_EVENTS_TOPIC_ARN,
});
```

```ts
// no service: tipa o gateway em deps e usa via deps.<gateway>
export type CreateBookingDeps = {
  repo: BookingsRepository;
  b2bUsers: B2bUsersGateway;
  topicArn: string;
};

export function createBookingService(deps: CreateBookingDeps) {
  return async (input: CreateBookingInput) => {
    const user = await deps.b2bUsers.findById(input.userId);
    // ...
  };
}
```

**Resumo:**
- Service que só usa repo: a factory recebe `{ repo }` em `deps`.
- Service que precisa de gateway: a factory recebe `{ repo, <gateway>, ... }` em `deps`.

Em teste, passa um `deps` com gateway fake. Sem mocking de módulo.

### 3.5 Compartilhados do recurso

`src/http/api/bookings/` (arquivos compartilhados entre os use-cases do agregado).

> **Tabelas Drizzle ficam centralizadas em `src/infra/db/tables/<módulo>/*.table.ts`**, separadas por módulo (`companies/`, `users/`, `rfp/`, …) — não dentro de `src/http/api/`. Schema é camada de DB e nem todo módulo tem endpoint (ex.: `users`, `companies`), então não faz sentido criar pasta de recurso HTTP só pela tabela. O glob `./src/**/*.table.ts` do `drizzle.config.ts` as encontra. Imports cross-módulo entre tabelas usam `../<módulo>/<x>.table.js`. Os demais compartilhados de um recurso com endpoint (`*.types.ts`, `*.repository.ts`) seguem em `src/http/api/<recurso>/`.

```ts
// src/infra/db/tables/bookings/bookings.table.ts — Drizzle
import { sql } from "drizzle-orm";
import { index, jsonb, pgEnum, pgTable, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

export const bookingStatus = pgEnum("booking_status", ["pending", "confirmed", "cancelled"]);

export const bookings = pgTable(
  "bookings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: varchar("user_id", { length: 64 }).notNull(),
    tenantId: varchar("tenant_id", { length: 64 }).notNull(),
    status: bookingStatus("status").notNull().default("pending"),
    details: jsonb("details").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (t) => [
    index("idx_bookings_user").on(t.userId, t.createdAt),
    index("idx_bookings_tenant").on(t.tenantId, t.createdAt),
    index("idx_bookings_cursor").on(t.createdAt, t.id),
  ],
);

export type BookingRow = typeof bookings.$inferSelect;
export type BookingInsert = typeof bookings.$inferInsert;
```

```ts
// bookings.types.ts — tipo de domínio (não é o row do Drizzle)
export type BookingStatus = "pending" | "confirmed" | "cancelled";

export type Booking = {
  id: string;
  userId: string;
  tenantId: string;
  status: BookingStatus;
  details: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};
```

```ts
// bookings.repository.ts — factory createBookingsRepository(db: DbOrTx)
// Retorna um objeto com as queries do recurso. O service recebe a interface
// BookingsRepository em deps; o controller constrói com createBookingsRepository(db).
export interface BookingsRepository {
  insertWithOutbox(
    input: { userId: string; tenantId: string; details: Record<string, unknown> },
    event: (booking: Booking) => OutboxEvent,
    idempotency?: { tenantId: string; key: string },
  ): Promise<{ booking: Booking; deduped: boolean }>;
  findById(id: string): Promise<Booking | null>;
  findOwned(id: string, userId: string, tenantId: string): Promise<Booking | null>;
  confirmWithOutbox(id: string, event: (booking: Booking) => OutboxEvent): Promise<Booking | null>;
  listByCursor(args: {
    userId: string;
    tenantId: string;
    limit: number;
    cursor: string | null;
  }): Promise<CursorPage<Booking>>;
}

export function createBookingsRepository(db: DbOrTx): BookingsRepository {
  return {
    /* ...queries com Drizzle, transações e outbox (ver §5.1) ... */
  };
}
```

```ts
// index.ts — registra todas as rotas do recurso
import type { FastifyPluginAsync } from "fastify";
import { confirmBookingRoute } from "./confirm-booking/confirm-booking.controller.js";
import { createBookingRoute } from "./create-booking/create-booking.controller.js";
import { getBookingRoute } from "./get-booking/get-booking.controller.js";
import { listBookingsRoute } from "./list-bookings/list-bookings.controller.js";

// Auth é aplicada pelo escopo autenticado em ../index.ts que registra este plugin (§7).
export const bookingsRoutes: FastifyPluginAsync = async (app) => {
  await app.register(createBookingRoute);
  await app.register(getBookingRoute);
  await app.register(listBookingsRoute);
  await app.register(confirmBookingRoute);
};
```

### 3.6 Recursos filhos do agregado (sub-pastas)

Quando um agregado tem recursos filhos (1:1 ou 1:N), cada filho ganha a **própria sub-pasta** com seus próprios `*.schema.ts` / `*.repository.ts` / `*.presenter.ts`, **agrupada sob `children/`**. Isso separa visualmente os filhos das operações (`*-rfp/`) e da raiz (`rfp.*`) — não os deixe no mesmo nível dos use-cases. Não amontoe tudo no schema/repository do agregado. Ex. (RFP):

```
src/http/api/rfp/
├── rfp.schema.ts / rfp.repository.ts / rfp.presenter.ts   # raiz do agregado
├── create-rfp/ get-rfp/ update-rfp/ ...                    # use-cases (operações, no topo)
└── children/                                               # todos os filhos agrupados
    ├── participants/                                       # filho (1:N)
    │   └── participants.schema.ts / .repository.ts / .presenter.ts
    ├── cities/                                             # filho (1:N)
    │   ├── cities.schema.ts / .repository.ts / .presenter.ts
    │   └── hotels/                                         # NETO (FK → cities)
    └── policy/                                             # filho 1:1 (sub-agregado)
        ├── policy.schema.ts / .repository.ts / .presenter.ts
        └── room-types/ payments/ amenities/ esg/           # filhos do policy
```

Regras:
- **Use-cases ficam no topo** (`create-rfp/`, `update-rfp/`…), igual ao template canônico `http/<recurso>/<use-case>/`. Só os recursos-filhos vão pra `children/`.
- O **repository do filho** é um factory `createXRepository(db: DbOrTx)` — recebe `DbOrTx` pra **compor dentro da transação do agregado** (passa o `tx`) ou rodar standalone em reads (passa `db`).
- **Netos** (filho de filho, ex. `hotels` sob `cities`) ganham sub-pasta **dentro** do filho; o repo do filho compõe o repo do neto no mesmo `tx` (ver `cities.repository` → `createHotelsRepository`). Aplique a regra recursivamente.
- A **escrita do agregado é transacional**: o repository da raiz abre `db.transaction` e delega aos repositories dos filhos no mesmo `tx` (rfp + filhos + netos commitam/rollback juntos). Ver `rfp.repository.insertAggregate`.
- **Saco de filhos (children bag)**: quando há >1 grupo de filhos, não cresça args posicionais — passe `RfpChildrenInput` (create, toda coleção presente) / `RfpChildrenPatch` (update, coleção `undefined` = inalterada); o agregado lê via `findChildren` → `RfpChildrenRows`. Adicionar um filho novo = +1 campo no saco.
- **Response**: separe `XBaseResponse` (raiz, sem filhos) de `XResponse` (`Intersect` base + filhos). **List usa o base** (1 query, sem N+1); create/get/update retornam o full. Evite N+1 no read de filhos: busque os netos de todos os filhos numa query (`findByCityIds` + `Map` por FK), não um-por-filho.
- **Update**: monte `UpdateBody` explicitamente (os campos da raiz como `.partial()` + cada coleção de filho como `.optional()`), não via `CreateBody.partial()` cru. Coleção **presente** = replace-all (soft-delete os ativos — e os netos via os ids ativos — + insere os novos, no mesmo `tx`); **ausente** = inalterada. Tudo numa transação (`updateAggregate`).
- **Mapeamento HTTP→repo**: campos opcionais do schema viram `null` no repo via um mapper estrutural (`toNewRfpCity`) — mantém o repo agnóstico ao schema HTTP. Colunas `numeric` chegam/saem como string decimal (converta na borda).
- **Ordenação dos filhos**: ordene reads pela **chave natural de negócio** (`cityId`, `hotelAlphaId`, `alphaId`), não por `created_at` (idêntico para linhas da mesma tx) nem pelo `id` UUID (random, não reflete inserção). Determinístico e sem migração; o `id` só desempata chaves iguais. Ordem dos filhos **não é contrato posicional** — em teste, localize por chave (`find`), não por índice.
- **Filho 1:1 (sub-agregado)**: quando o filho é 1:1 (ex. `policy`, com `unique(rfpId)`) ele é um **objeto**, não array. No bag: create `policy: New… | null` (null = sem); patch `policy?: New… | null` (objeto = replace, `null` = remover, `undefined` = inalterado); read `policy: …Aggregate | null`. Aninha seus próprios filhos 1:1 (payments) e 1:N (room_types/amenities/esg, sem `unique` → soft-delete + insert) — é um sub-agregado completo sob `policy/`.
- **Replace de 1:1 com `unique()`**: soft-delete + reinsert **viola** o `unique` (a tombstone mantém a FK). Para esses, o replace faz **hard delete** da raiz do sub-agregado (`delete(rfpPolicy).where(rfpId)`) e confia no **FK `onDelete: cascade`** pra limpar os filhos, depois reinsere. Sem tombstone, sem violação. (Filhos 1:N sem `unique` seguem soft-delete + insert como cities/participants.)
- **Enums**: derive o enum Zod do enum do Drizzle — `z.enum(rfpHotelType.enumValues)` — em vez de reescrever os literais (SSOT, sem drift).

---

## 4. Gateways e o decorator `app.gateways`

### 4.1 O problema

Services precisam chamar serviços externos (Cognito, S3, SQS, SNS, serviços internos). Se importarmos AWS SDK direto no service, perdemos testabilidade. Se usarmos DI container, complicamos.

### 4.2 A solução

Gateways são **factories** (`createCognitoGateway`, `createS3Gateway`, etc) instanciadas no boot do app. O tipo `Gateways` vive em `src/types/fastify.ts`:

```ts
// src/types/fastify.ts
import type { CognitoGateway } from "../gateways/cognito/cognito.gateway.js";
import type { B2bUsersGateway } from "../gateways/internal/b2b-users.gateway.js";
import type { S3Gateway } from "../gateways/s3/s3.gateway.js";
import type { SnsGateway } from "../gateways/sns/sns.gateway.js";
import type { SqsGateway } from "../gateways/sqs/sqs.gateway.js";

export type Gateways = {
  cognito: CognitoGateway;
  s3: S3Gateway;
  sqs: SqsGateway;
  sns: SnsGateway;
  b2bUsers: B2bUsersGateway;
};
```

O decorator é declarado em `src/types/fastify-augment.d.ts` (`FastifyInstance.gateways`; também aumenta `FastifyRequest.user` com `{ sub, username, tenantId, groups? }`). O `gatewaysPlugin` (via `fastify-plugin`) decora a instância; `buildDefaultGateways()` monta as instâncias reais a partir do `env`:

```ts
// src/http/plugins/gateways-plugin.ts
import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { env } from "../../config/env.js";
import { createCognitoGateway } from "../../gateways/cognito/cognito.gateway.js";
import { createB2bUsersGateway } from "../../gateways/internal/b2b-users.gateway.js";
import { createS3Gateway } from "../../gateways/s3/s3.gateway.js";
import { createSnsGateway } from "../../gateways/sns/sns.gateway.js";
import { createSqsGateway } from "../../gateways/sqs/sqs.gateway.js";
import type { Gateways } from "../../types/fastify.js";

export function buildDefaultGateways(): Gateways {
  return {
    cognito: createCognitoGateway({ userPoolId: env.COGNITO_USER_POOL_ID, clientId: env.COGNITO_CLIENT_ID }),
    s3: createS3Gateway({ region: env.AWS_REGION, bucket: env.S3_BUCKET_UPLOADS, endpoint: env.AWS_ENDPOINT_URL }),
    sqs: createSqsGateway({ region: env.AWS_REGION, endpoint: env.AWS_ENDPOINT_URL }),
    sns: createSnsGateway({ region: env.AWS_REGION, endpoint: env.AWS_ENDPOINT_URL }),
    b2bUsers: createB2bUsersGateway({ baseUrl: env.B2B_USERS_BASE_URL }),
  };
}

const _gatewaysPlugin: FastifyPluginAsync<{ gateways?: Gateways }> = async (app, opts) => {
  // Default: instâncias reais. Em teste, passa-se um set completo de fakes via opts.
  const gateways = opts.gateways ?? buildDefaultGateways();
  app.decorate("gateways", gateways);
};

export const gatewaysPlugin = fp(_gatewaysPlugin, { fastify: "5.x", name: "gateways" });
```

### 4.3 Em produção

```ts
// src/app.ts
await app.register(gatewaysPlugin, { gateways: opts.gateways });
// sem opts.gateways → buildDefaultGateways(); qualquer handler tem
// app.gateways.cognito, app.gateways.s3, app.gateways.b2bUsers, etc.
```

### 4.4 Em teste

```ts
// test/e2e/helpers/app.ts
import { buildApp } from "../../../src/app.js";
import { buildFakeGateways } from "../../mocks/gateways.fake.js";

const app = await buildApp({ gateways: buildFakeGateways(gatewayOverrides) });
```

`buildFakeGateways(overrides)` (em `test/mocks/gateways.fake.ts`) devolve o conjunto **completo** de gateways fakes — `opts.gateways` substitui todos de uma vez, não faz merge parcial. Sem `vi.mock`. Sem framework de DI. Só um decorator com override.

---

## 5. Transações

Transações nascem no service, atravessam repositories.

```ts
// Service: chama db.transaction direto
import { db } from "@/infra/db/client";
import { accountsRepository } from "./accounts.repository";
import { ledgerRepository } from "./ledger.repository";

export const transferFunds = async (input: TransferInput) => {
  return db.transaction(async (tx) => {
    await accountsRepository.debit(input.from, input.amount, tx);
    await accountsRepository.credit(input.to, input.amount, tx);
    await ledgerRepository.record(input, tx);
  });
};
```

```ts
// Repository: aceita tx opcional
async debit(id: string, amount: number, tx?: Transaction) {
  const exec = tx ?? db;
  await exec.update(accountsTable).set({ balance: sql`balance - ${amount}` }).where(eq(accountsTable.id, id));
}
```

**Cuidado:**
- Nunca chame gateway externo dentro de transação. Se o gateway falha, a transação fica aberta segurando locks.
- Padrão: trabalho externo **antes** ou **depois** da transação, ou use o outbox transacional (§5.1).

### 5.1 Outbox transacional + idempotência

Para emitir um evento de domínio de forma confiável, **não publique no SNS direto do service** (a publicação pode falhar depois do commit, ou o commit falhar depois da publicação). Grave o evento na **mesma transação** da mudança de estado; um relay publica depois.

Helpers genéricos em `src/infra/db/outbox.ts`:

- `enqueueOutbox(tx, event)` — insere uma linha em `outbox` dentro da transação.
- `claimIdempotencyKey(tx, { tenantId, key, aggregateId })` — reserva a chave `(tenant, key)`; retorna `null` se o chamador é o dono (segue a escrita) ou `{ existingAggregateId }` em retry (o chamador carrega e devolve o agregado existente).

O repository compõe os dois dentro de `db.transaction`:

```ts
// bookings.repository.ts (resumo)
return db.transaction(async (tx) => {
  if (idempotency) {
    const dup = await claimIdempotencyKey(tx, { ...idempotency, aggregateId: id });
    if (dup) return { booking: await load(tx, dup.existingAggregateId), deduped: true };
  }
  const booking = await insert(tx, { id, createdAt: new Date(), ...input });
  await enqueueOutbox(tx, bookingEvent("booking.created", topicArn));
  return { booking, deduped: false };
});
```

Tabelas: `outbox` (`aggregate_type`, `aggregate_id`, `event_type`, `topic_arn`, `payload`, `published_at`) e `idempotency_keys` (PK `(tenant_id, idempotency_key)` → `aggregate_id`). O relay que drena o outbox para o SNS vive em `src/workers/outbox-relay/` (ver §8).

### 5.2 Paginação por cursor (keyset)

Listagens usam keyset pagination, não `OFFSET`. Helpers em `src/infra/db/cursor.ts`:

- `afterCursor(createdAtCol, idCol, decoded)` + `keysetOrderBy(createdAtCol, idCol)` — **use sempre os dois juntos**; ambos assumem `(createdAt desc, id desc)` e divergem em silêncio se o `ORDER BY` for outro.
- `encodeCursor`/`decodeCursor` — cursor opaco `base64url(<createdAt ISO>|<id>)`.
- `toPage(rows, limit, cursorOf, map)` — fatia `limit + 1` linhas e deriva `nextCursor` (rejeita `limit < 1`).

> Cursor estável exige timestamps em **precisão de milissegundos**: `timestamptz` guarda microssegundos, mas o `Date` lido no JS só tem ms. Grave `createdAt` com `new Date()` (ms) na escrita — senão linhas criadas no mesmo milissegundo são puladas entre páginas.

---

## 6. Erros

Hierarquia em `src/shared/errors.ts`. A base `AppError` tem assinatura `(code, statusCode, message, details?)`:

```ts
export class AppError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends AppError {
  constructor(message = "not_found") {
    super("NOT_FOUND", 404, message);
  }
}
export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super("VALIDATION", 400, message, details);
  }
}
export class ConflictError extends AppError {
  constructor(message: string) {
    super("CONFLICT", 409, message);
  }
}
export class UnauthorizedError extends AppError {
  constructor(message = "unauthorized") {
    super("UNAUTHORIZED", 401, message);
  }
}
export class ForbiddenError extends AppError {
  constructor(message = "forbidden") {
    super("FORBIDDEN", 403, message);
  }
}
export class BadGatewayError extends AppError {
  constructor(message = "bad_gateway", details?: unknown) {
    super("BAD_GATEWAY", 502, message, details);
  }
}
export class ServiceUnavailableError extends AppError {
  constructor(message = "service_unavailable", details?: unknown) {
    super("SERVICE_UNAVAILABLE", 503, message, details);
  }
}

// Envolve uma falha upstream capturada como 502 tipado, preservando o erro
// original em `cause` para os logs sem expô-lo ao cliente.
export function badGateway(message: string, cause: unknown): BadGatewayError {
  const err = new BadGatewayError(message);
  err.cause = cause;
  return err;
}
```

`errorHandler` global em `src/http/plugins/error-handler.ts` traduz para o shape achatado `{ code, message, details?, trace_id }` (`trace_id` vem do span ativo do OTel):

```json
{
  "code": "NOT_FOUND",
  "message": "booking abc not found",
  "trace_id": "abc123..."
}
```

- Erros de validação do Zod (via `fastify-type-provider-zod`, com `.validation`) → 400 `{ code: "VALIDATION", message, details: <issues>, trace_id }`.
- Erros inesperados (não-`AppError`) → 500 `{ code: "INTERNAL", message: "internal_server_error", trace_id }` + log em nível `error` com o erro.

---

## 7. Plugins Fastify — ordem em `app.ts`

`buildApp` é enxuto. Os compilers do `fastify-type-provider-zod` (`validatorCompiler` + `serializerCompiler`) são setados logo após criar a instância; as rotas então usam `withTypeProvider<ZodTypeProvider>()`. Sem under-pressure nem `genReqId`. O rate-limit (`@fastify/rate-limit`) é registrado fora do ambiente de teste — ver [`CODING_STANDARDS.md` §5.3](./CODING_STANDARDS.md#53-rate-limit). O `swaggerPlugin` (`@fastify/swagger` + `@fastify/swagger-ui`) é registrado **antes** de `httpRoutes` para que o hook `onRoute` capture o schema Zod de cada rota — ver §7.2. O logger é injetado como `loggerInstance` (o Pino singleton):

```ts
// src/app.ts
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import sensible from "@fastify/sensible";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { env } from "./config/env.js";
import { httpRoutes } from "./http/index.js";
import { errorHandlerPlugin } from "./http/plugins/error-handler/error-handler.js";
import { gatewaysPlugin } from "./http/plugins/gateways-plugin/gateways-plugin.js";
import { rateLimitPlugin } from "./http/plugins/rate-limit/rate-limit.js";
import { swaggerPlugin } from "./http/plugins/swagger/swagger.js";
import { logger } from "./infra/observability/logger.js";
import "./infra/http/undici-agent.js";
import type { Gateways } from "./types/fastify.js";

export type BuildAppOptions = { gateways?: Gateways; rateLimit?: boolean };

export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: logger as FastifyBaseLogger,
    disableRequestLogging: false,
    trustProxy: env.TRUST_PROXY_HOPS,                            // hops confiáveis (ALB), nunca true
    bodyLimit: 1_048_576,
  });

  // Zod como fonte da verdade: validação + serialização compiladas via type provider.
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(sensible);                                  // 1. utilitários
  await app.register(helmet);                                    // 2. segurança
  await app.register(cors, { origin: env.NODE_ENV === "development", methods: ["GET", "HEAD", "POST", "PATCH", "DELETE"] });
  await app.register(errorHandlerPlugin);                        // 3. error handler global
  if (opts.rateLimit ?? env.NODE_ENV !== "test")                 // 4. rate limit (off em teste por default)
    await app.register(rateLimitPlugin);
  await app.register(gatewaysPlugin, { gateways: opts.gateways }); // 5. gateways (override em teste)
  await app.register(swaggerPlugin);                             // 6. OpenAPI + Swagger UI (antes das rotas)
  await app.register(httpRoutes);                                // 7. rotas

  return app;
}
```

### 7.1 Global preHandler chain (auth + permissions)

`src/http/index.ts` registers two `preHandler` hooks at the top level of the HTTP plugin:

1. `authHook` — verifies the bearer token via the Cognito gateway and attaches `req.user` (with `permissions: Permission[]`). Short-circuits when `req.routeOptions.config.public === true`.
2. `permissionsHook` — reads `config.permissions: { all?, any? }` and enforces it against `req.user.permissions`. Throws `AUTH-T0010` when the route declared no permissions, `AUTH-T0011` when the user is short.

The `/health` route is the only public one and ships `config: { public: true, rateLimit: false }`. Adding a new authenticated route automatically inherits the chain — no per-route `preHandler` wiring needed.

**Permission model:** persona-based. `Permission` literals (`<SISTEMA>:<PERSONA>`) describe *who the user is*, not *what action they invoke*. Routes typically use `any: [...]` to declare which personas can access them. Pattern in [`INTEGRATIONS.md`](./INTEGRATIONS.md#25-autorização-permissões--padrão-persona) and [`DECISIONS.md`](./DECISIONS.md#adr-022-padrão-persona-para-permissões-sem-ações-finas); o catálogo real do projeto em [`PROJECT.md` §3](./PROJECT.md#3-catálogo-de-permissões-personas).

### 7.2 OpenAPI + Swagger UI (`swaggerPlugin`)

`src/http/plugins/swagger/swagger.ts` registra `@fastify/swagger` (OpenAPI 3.0.3) e `@fastify/swagger-ui` via `fastify-plugin` (sem encapsulamento). Como o `onRoute` do swagger só enxerga rotas registradas **depois** dele, o plugin entra **antes** de `httpRoutes` em `buildApp`. Os schemas são Zod, então o `@fastify/swagger` recebe `transform: jsonSchemaTransform` e `transformObject: jsonSchemaTransformObject` (do `fastify-type-provider-zod`), que convertem cada schema Zod em JSON Schema (Zod 4 tem export de primeira classe via `z.toJSONSchema()`). Schemas reutilizáveis/ref'd são registrados com `z.globalRegistry.add(Schema, { id: 'User' })` — o `jsonSchemaTransformObject` os emite como `$ref` no documento.

Superfícies expostas (ambas GET, **sem autenticação**):

- `/docs` — Swagger UI (humano).
- `/docs/json` — documento OpenAPI 3; o frontend o consome via **Kubb** para gerar o cliente tipado.

Essas rotas vivem no contexto raiz, **fora** do encapsulamento de `httpRoutes` que instala os preHandlers de auth/permissões (§7.1) — por isso ficam acessíveis sem token e não precisam de `config.public`. O `operationId` declarado no schema de cada controller vira o nome da função no cliente gerado, mantendo o output do Kubb estável (mais um motivo de `operationId` ser obrigatório). O security scheme `bearerAuth` (HTTP bearer/JWT) é declarado global no documento.

---

## 8. Workers (consumers SQS)

Workers seguem a mesma filosofia: arquivo único para o consumer, função para o handler.

```
src/workers/booking-created/
├── booking-created.consumer.ts     # configura SQS poll + ack
├── booking-created.handler.ts      # handleBookingCreated(payload)
├── booking-created.schema.ts       # Zod do payload
└── booking-created.test.ts
```

> **Status atual:** o consumer SQS `booking-created` está **desabilitado** — comentado no boot (`server.ts`: `startBookingCreatedConsumer()` e o `consumer.stop()` no shutdown) até a subscription SNS→SQS + DLQ serem provisionadas. As três linhas relacionadas são descomentadas juntas para drenar a fila.

Detalhes em [`INTEGRATIONS.md`](./INTEGRATIONS.md#filas-sqs--sns).

Além dos consumers SQS, há o **relay do outbox** em `src/workers/outbox-relay/`: faz poll da tabela `outbox`, publica cada evento no SNS via `app.gateways.sns` e marca `published_at` (`FOR UPDATE SKIP LOCKED` para rodar em múltiplas instâncias). Sobe no boot (`server.ts`) e para no shutdown antes de fechar o pool. Ver §5.1.

---

## 9. Checklist para um caso de uso novo

- [ ] Pasta criada em `src/http/api/<recurso>/<use-case>/`
- [ ] `*.schema.ts` com Zod para body, params, query, response
- [ ] `*.controller.ts` declara rota + schema + handler (arquivo único, `FastifyPluginAsync`)
- [ ] **`config.permissions` declarado** (personas via `PERMISSIONS.*` do catálogo; `any: [...]` é o padrão)
- [ ] `*.service.ts` exporta a factory `createXService(deps)` (sem `.execute`, sem classe)
- [ ] `*.test.ts` cobre happy path + erros principais + **persona errada → 403**
- [ ] Registrado no `index.ts` do recurso (`src/http/api/<recurso>/index.ts`)
- [ ] Auth: o recurso está sob o escopo autenticado (§7)? Handler usa `requireUser(req)` para a identidade?
- [ ] Trace: aparece corretamente no X-Ray
- [ ] Log: emite evento de domínio (`user.created`, `booking.confirmed`) com contexto
- [ ] Sem `import { db }` em controller (só em repository)
- [ ] Sem `import { S3Client }` em service (use `app.gateways.s3`)
