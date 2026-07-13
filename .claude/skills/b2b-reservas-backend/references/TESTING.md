# TESTING.md — Estratégia de Testes

> Todo use-case tem teste. Toda rota tem teste e2e. Toda query tem integração contra Postgres real. Gateways externos são substituídos por fakes via `app.gateways`.

---

## 1. Pirâmide

```
        /\
       /e2e\         poucos (~10-20)    — fluxos críticos end-to-end (fastify.inject)
      /------\
     /integr. \      vários (~50-100)   — repository contra Postgres real (Testcontainers)
    /----------\
   /   unit     \    muitos (~centenas) — services com gateways fakes / repos mockados
  /--------------\
```

**Inverte se passar de:**
- 1 hora de CI → revisar; cortar e2e que duplicam integração.
- > 30% de mocks em service → suspeito; favor de integração com DB real.

---

## 2. Vitest

Configuração:

```ts
// vitest.config.ts
import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: false,
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/instrumentation.ts",
        "src/server.ts",
        "src/**/*.schema.ts",
      ],
      thresholds: { lines: 80, functions: 80, branches: 75, statements: 80 },
    },
    pool: "threads",
  },
});
```

Workspaces para separar projetos:

```ts
// vitest.workspace.ts
export default [
  { test: { name: "unit", include: ["src/**/*.test.ts"] } },
  {
    test: {
      name: "integration",
      include: ["test/integration/**/*.test.ts"],
      setupFiles: ["test/setup-integration.ts"],
    },
  },
  {
    test: {
      name: "e2e",
      include: ["test/e2e/**/*.test.ts"],
      setupFiles: ["test/setup-e2e.ts"],
    },
  },
];
```

Scripts:

```json
"test":             "vitest",
"test:run":         "vitest run",
"test:unit":        "vitest run --project unit",
"test:integration": "vitest run --project integration",
"test:e2e":         "vitest run --project e2e",
"test:coverage":    "vitest run --coverage"
```

---

## 3. Unit tests

### 3.1 Service que só usa repo + logger

Service usa singletons importados (`usersRepository`, `logger`). Mockamos via `vi.mock`:

```ts
// src/http/api/<recurso>/<use-case>/<use-case>.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ConflictError } from "@/shared/errors";

vi.mock("@/http/users/users.repository", () => ({
  usersRepository: {
    findByEmail: vi.fn(),
    insert: vi.fn(),
  },
}));

vi.mock("@/infra/observability/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { createUser } from "./create-user.service";
import { usersRepository } from "@/http/users/users.repository";
import { logger } from "@/infra/observability/logger";

describe("createUser", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates a new user", async () => {
    (usersRepository.findByEmail as any).mockResolvedValue(null);
    (usersRepository.insert as any).mockResolvedValue({
      id: "u1",
      email: "a@b.com",
      name: "Alice",
      cognitoSub: "cog-1",
      createdAt: new Date(),
    });

    const user = await createUser({
      email: "a@b.com",
      name: "Alice",
      cognitoSub: "cog-1",
    });

    expect(user.id).toBe("u1");
    expect(logger.info).toHaveBeenCalledWith({ userId: "u1" }, "user.created");
  });

  it("rejects duplicate email", async () => {
    (usersRepository.findByEmail as any).mockResolvedValue({ id: "existing" });

    await expect(
      createUser({ email: "a@b.com", name: "Alice", cognitoSub: "cog-1" }),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});
```

### 3.2 Service que recebe `deps` (gateway)

Quando o service recebe gateways como parâmetro, é ainda mais simples — sem `vi.mock`:

```ts
// src/http/uploads/create-avatar-upload/create-avatar-upload.test.ts
import { describe, it, expect, vi } from "vitest";
import { createAvatarUpload } from "./create-avatar-upload.service";
import { ValidationError } from "@/shared/errors";

// O S3Gateway real expõe só presignUpload / presignDownload.
const makeFakeS3 = () => ({
  presignUpload: vi.fn().mockResolvedValue("https://fake/upload"),
  presignDownload: vi.fn(),
});

describe("createAvatarUpload", () => {
  it("returns presigned url for valid content type", async () => {
    const s3 = makeFakeS3();
    const result = await createAvatarUpload(
      { cognitoSub: "cog-1", contentType: "image/jpeg" },
      { s3 },
    );
    expect(result.url).toBe("https://fake/upload");
    expect(result.key).toMatch(/^users\/cog-1\/avatar\//);
    expect(s3.presignUpload).toHaveBeenCalledOnce();
  });

  it("rejects invalid content type", async () => {
    const s3 = makeFakeS3();
    await expect(
      createAvatarUpload(
        { cognitoSub: "cog-1", contentType: "application/x-exe" },
        { s3 },
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
```

> **Esse padrão é o melhor.** Sem `vi.mock`, sem ordem de imports importar — só funções recebendo argumentos. Preferimos quando o service precisa de gateway.

### 3.3 Regras

- **Testa comportamento, não implementação.** Verifique o resultado, não "chamou X método N vezes" (exceto para side effects observáveis).
- **Um conceito por teste.** Se você precisa de "e" no nome do teste, divida.
- **Fixtures como builders.** `aUser({ overrides })` em `test/builders/`.

---

## 4. Integration tests

**Banco real, sem mock.** Testcontainers sobe Postgres em container Docker.

### 4.1 Setup

Um helper `startTestDb()` (`test/integration/helpers/db.ts`) sobe o container, cria o `Pool`, instancia o Drizzle e roda as migrations de `src/infra/db/migrations`. Devolve `{ pool, db, container, stop() }`. O projeto `integration` do Vitest injeta env dummy via `setupFiles`.

```ts
// test/integration/helpers/db.ts
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import type { Db } from "../../../src/infra/db/client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function startTestDb() {
  const container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const pool = new Pool({ connectionString: container.getConnectionUri(), max: 5 });
  const db = drizzle(pool);
  await migrate(db, {
    migrationsFolder: path.resolve(__dirname, "../../../src/infra/db/migrations"),
  });
  return {
    pool,
    db,
    container,
    async stop() {
      await pool.end();
      await container.stop();
    },
  };
}
```

### 4.2 Isolamento

O repository é instanciado por uma factory recebendo o `db` do teste — sem `vi.mock` do singleton. **`TRUNCATE` no `beforeEach`** (raw query, mais rápido que recriar container):

```ts
// test/integration/bookings.repository.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createBookingsRepository } from "../../src/http/api/bookings/bookings.repository.js";
import { startTestDb, type TestDb } from "./helpers/db.js";

describe("bookingsRepository (integration)", () => {
  let testDb: TestDb;
  let repo: ReturnType<typeof createBookingsRepository>;

  beforeAll(async () => {
    testDb = await startTestDb();
    repo = createBookingsRepository(testDb.db);
  }, 60_000);

  afterAll(async () => {
    await testDb.stop();
  });

  beforeEach(async () => {
    await testDb.pool.query("TRUNCATE TABLE bookings, outbox, idempotency_keys");
  });

  it("findOwned returns the booking only for the matching user and tenant", async () => {
    const { booking } = await repo.insertWithOutbox(
      { userId: "u1", tenantId: "t1", details: {} },
      event("booking.created"),
    );
    expect(await repo.findOwned(booking.id, "u1", "t1")).toEqual(booking);
    expect(await repo.findOwned(booking.id, "u2", "t1")).toBeNull();
    expect(await repo.findOwned(booking.id, "u1", "t2")).toBeNull();
  });
});
```

### 4.3 Quando integração > unit

- Repositories — **sempre** integração.
- Services com transação envolvendo múltiplos repos — integração.
- Migrations — teste que aplica + roda contra snapshot.

---

## 5. E2E (HTTP)

**`fastify.inject`** — sem socket TCP, sem porta. Rápido e isolado.

Gateways são substituídos por fakes via `buildFakeGateways` ao construir o app. O helper `buildTestApp` (`test/e2e/helpers/app.ts`) sobe um Postgres via Testcontainers, roda as migrations, injeta as env vars dummy e chama `buildApp({ gateways: buildFakeGateways(overrides) })`. Passe apenas os overrides que o teste precisar.

```ts
// test/e2e/bookings.e2e.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildTestApp, type TestApp } from "./helpers/app.js";

// O fake do cognito deriva a identidade do bearer token: o token É o `sub`.
// "<sub>" → tenant t1; "<sub>@<tenant>" mira um tenant específico (cross-tenant).
// 'ghost' é o único id que o fake b2bUsers rejeita (caminho user-not-found).
const as = (token: string) => ({ authorization: `Bearer ${token}` });

describe("bookings e2e", () => {
  let h: TestApp;

  beforeAll(async () => {
    h = await buildTestApp();
  }, 60_000);

  afterAll(async () => {
    await h.close();
  });

  beforeEach(async () => {
    await h.pool.query("TRUNCATE TABLE bookings, outbox, idempotency_keys");
  });

  it("creates a booking for the acting user", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/bookings",
      headers: as("u1"),
      payload: { details: { room: "A" } },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ userId: "u1", tenantId: "t1", status: "pending" });
  });

  it("returns 401 without a bearer token", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/bookings",
      payload: { details: {} },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("UNAUTHORIZED");
  });

  it("returns 404 fetching another user's booking (ownership)", async () => {
    const create = await h.app.inject({
      method: "POST",
      url: "/bookings",
      headers: as("owner1"),
      payload: { details: {} },
    });
    const { id } = create.json();

    const res = await h.app.inject({
      method: "GET",
      url: `/bookings/${id}`,
      headers: as("owner2"),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("NOT_FOUND");
  });
});
```

> **Convenção de auth nos e2e.** Rotas autenticadas exigem `Authorization: Bearer <token>`. O fake do cognito (`verifyToken`) ecoa o token como `sub` e devolve `{ sub, username, permissions }`, então o valor do token É o id do usuário que está agindo. Para cenários que precisam de empresa/identidade no DB, semeie com `seedCompanyUser(pool, { sub, companyAlphaId })` (`test/e2e/helpers/seed.ts`) — não há mais JIT. O `/health` é público (sem token).

### 5.2 Testando permissões (personas)

O fake do Cognito também aceita personas inline no token via convenção `<sub>#<persona>,<persona>` — o gateway de teste faz parse e popula `req.user.permissions`. Sem `#`, o usuário não tem nenhuma persona (vai falhar em qualquer rota que exija permissão).

```ts
import { PERMISSIONS } from "@/shared/permissions/catalog";
const SYS = PERMISSIONS.EXEMPLO_API; // <SISTEMA> real do projeto: ver catalog.ts / PROJECT.md §3

const asPersona = (sub: string, ...personas: Permission[]) => ({
  authorization: `Bearer ${sub}#${personas.join(",")}`,
});

it("denies create-booking to a read-only persona", async () => {
  const res = await h.app.inject({
    method: "POST",
    url: "/bookings",
    headers: asPersona("u1", SYS.APP_USER),
    payload: { details: { room: "A" } },
  });
  expect(res.statusCode).toBe(403);
  expect(res.json().code).toBe("AUTH-T0011"); // insufficient_permissions
});

it("allows create-booking to an admin persona", async () => {
  const res = await h.app.inject({
    method: "POST",
    url: "/bookings",
    headers: asPersona("u2", SYS.ADMIN),
    payload: { details: { room: "A" } },
  });
  expect(res.statusCode).toBe(201);
});
```

Convenção forte: **toda rota nova ganha pelo menos um teste de "persona errada → 403"**, idealmente alvejando uma persona vizinha (uma persona read-only quando a rota é de escrita). Isso protege contra `config.permissions` colado errado.

### 5.1 O que cobrir em e2e

- Happy path por endpoint
- Validação (400)
- Auth (401/403)
- Edge: not found (404), conflict (409)
- Formato do JSON de erro (contrato)

**Não** cobrir todas as combinações em e2e — é trabalho dos unit.

---

## 6. Mocks de serviços externos HTTP

Para gateways de serviços HTTP (internos como `b2b-users` ou externos), há duas estratégias:

### 6.1 Substituir gateway via `app.gateways` (preferido)

`buildFakeGateways` (`test/mocks/gateways.fake.ts`) devolve o conjunto completo de fakes; sobrescreva só o que o teste precisar via `buildApp({ gateways: buildFakeGateways({ ...overrides }) })`. Para sobrescrever `b2bUsers` num cenário específico:

```ts
import { buildFakeGateways } from "../mocks/gateways.fake.js";

const app = await buildApp({
  gateways: buildFakeGateways({
    b2bUsers: {
      findById: async (id) => (id === "missing" ? null : { id, email: `${id}@b.com`, tenantId: "t1" }),
    },
  }),
});
```

O fake padrão do cognito expõe `verifyToken(token)` retornando `{ sub, username, permissions }` (token = sub). Nos e2e, prefira usar `buildTestApp(overrides)`, que já encadeia `buildFakeGateways`.

### 6.2 MSW para integração entre gateway e SDK HTTP

Se quiser testar o **gateway em si** (não pelo seu wrapper, mas pela camada HTTP):

```ts
// test/mocks/b2b-users.ts
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";

export const b2bUsersMock = setupServer(
  http.get("https://b2b-users.internal/internal/users/by-cognito-sub/:sub", ({ params }) =>
    HttpResponse.json({
      id: "user-1",
      email: "a@b.com",
      cognitoSub: params.sub,
      fullName: "Alice",
    }),
  ),
);

// em test/setup-integration.ts:
beforeAll(() => b2bUsersMock.listen({ onUnhandledRequest: "error" }));
afterEach(() => b2bUsersMock.resetHandlers());
afterAll(() => b2bUsersMock.close());
```

---

## 7. Test data — builders

```ts
// test/builders/user.builder.ts
import type { NewUser } from "@/http/users/users.types";

export const aUser = (overrides: Partial<NewUser> = {}): NewUser => ({
  email: `user-${crypto.randomUUID()}@test.com`,
  name: "Test User",
  cognitoSub: `cog-${crypto.randomUUID()}`,
  ...overrides,
});
```

Uso: `await usersRepository.insert(aUser({ email: "specific@case.com" }))`.

**Sem dados compartilhados entre testes.** Truncate no `beforeEach`.

---

## 8. Performance dos testes

- Vitest workers por padrão.
- **Não importe `@/app` em unit tests** — só o módulo testado.
- Logger silenciado em testes (mockado via `vi.mock` ou `pino({ enabled: false })`).
- Container Postgres compartilhado entre arquivos de mesma suíte.
- Targets: unit < 10s, integração < 60s, e2e < 90s.

---

## 9. Cobertura

Mínimo: **80% lines / 75% branches**.

Excluídos:
- `*.schema.ts` (só tipos)
- `instrumentation.ts`
- `server.ts` (bootstrap)
- Migrations geradas

---

## 10. Teste flake

Zero tolerância. Causas comuns:
- Dependência de relógio (`Date.now()` em vez de injetar clock).
- Ordem de teste (estado vazado entre testes).
- Race com container (timeout no Testcontainers).
- MSW handler não restaurado entre testes.

---

## 11. CI (CodeBuild)

```
Stage 1 (paralelo, ~3 min): biome + typecheck + vitest unit
Stage 2 (sequencial, ~5-10 min): integration + e2e + coverage
```

Em PR (CodeCommit pull request), só Stage 1 bloqueia merge automaticamente; Stage 2 bloqueia se falhar.
