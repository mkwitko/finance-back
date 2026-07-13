# CODING_STANDARDS.md — Padrões de Código

> Pequenas decisões consistentes valem mais que grandes decisões pontuais.

---

## 1. TypeScript

### 1.1 `tsconfig.json` é strict

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2023"],
    "outDir": "dist",
    "rootDir": "src",

    "strict": true,
    "noImplicitAny": true,
    "strictNullChecks": true,
    "strictFunctionTypes": true,
    "strictBindCallApply": true,
    "noImplicitThis": true,
    "alwaysStrict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "exactOptionalPropertyTypes": true,

    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,

    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": ["src/**/*"],
  "exclude": ["dist", "node_modules"]
}
```

### 1.2 Regras de tipo

- **Sem `any`.** Use `unknown` + narrow.
- **Sem `as` casual.** Use só em parse de JSON externo (já validado via Zod) ou em assertions genuínas. Prefira type guards.
- **`type` para shapes, `interface` para contratos extensíveis.** Default: `type`.
- **Tipos derivados.** Se Zod define o shape, derive: `type X = z.infer<typeof XSchema>`.
- **`Readonly`/`readonly` em props que não mudam.** Default: imutável.
- **`as const` para literais.** `const STATUS = ["active", "inactive"] as const`.

### 1.3 Imports

```ts
// 1. node built-ins
import { randomUUID } from "node:crypto";
// 2. dependencies externas
import Fastify from "fastify";
import { z } from "zod/v4";
// 3. internos (alias @/)
import { logger } from "@/infra/observability/logger";
// 4. relativos
import type { CreateUserBody } from "./create-user.schema";
```

**Type imports** separados: `import type { X } from "y"`.

### 1.4 Naming

- **camelCase**: variáveis, funções, **services exportados** (`createUser`, não `CreateUser`).
- **PascalCase**: tipos, classes, enums, **schemas Zod** (`CreateUserBody`).
- **SCREAMING_SNAKE_CASE**: constantes top-level.
- **kebab-case**: arquivos (`create-user.service.ts`, `error-handler.ts`).
- **Factory functions**: `createX` (`createCognitoGateway`, `createS3Gateway`).
- **Boolean**: `is`/`has`/`should` (`isActive`, `hasPermission`).
- **Async sem sufixo `Async`.**

### 1.5 Funções

- **Funções puras quando possível.** Side effects nas bordas.
- **≤ 20 linhas no corpo.** Acima, extrair.
- **Params sempre via UM objeto nomeado** (≥ 2 args). As **dependências entram no mesmo objeto** — `db`, gateways, repos, clients. Nunca `fn(db, { ...args })`: isso deixa coisa "fora do objeto". Um único arg posicional é o único caso que dispensa objeto. Tipe o objeto com um `type ...Args` exportado.
- **Retorno tipado explicitamente** em funções exportadas.

```ts
// ❌ posicional — o que é cada string no call-site?
resolveCallerContext(deps, sub, token);
// ❌ split dep+objeto — db ficou de fora
findById(db, { uuid, scope });

// ✅ um objeto só; dependências dentro dele
export type ResolveCallerContextArgs = {
  dependencies: CallerContextDeps;
  sub: string;
  token: string;
};
export async function resolveCallerContext({
  dependencies,
  sub,
  token,
}: ResolveCallerContextArgs): Promise<CallerContext> { /* ... */ }

resolveCallerContext({ dependencies: deps, sub: input.alphaId, token: input.token });
```

**Repositórios (ops db-first).** A interface não expõe `db`; a impl recebe `db` dentro do objeto; o factory injeta:

```ts
// interface (sem db)
export type FindByIdArgs = { uuid: string; scope: RfpScope };
findById(args: FindByIdArgs): Promise<RfpRow | null>;

// impl (db dentro do objeto)
export async function findById({ db, uuid, scope }: FindByIdArgs & { db: DbOrTx }) { /* ... */ }

// factory injeta db
findById: (args) => findById({ db, ...args }),
```

Services seguem a mesma regra: factory `createXService(deps)` → handler `(input)`, ambos objetos.

---

## 2. Erros

### 2.1 Lance erros tipados

```ts
// ❌
throw new Error("user not found");

// ✅
throw new NotFoundError("user not found");
```

Hierarquia em `@/shared/errors`. `errorHandler` global mapeia para HTTP.

### 2.2 Não engula erros

```ts
// ❌
try { await x(); } catch {}

// ❌ logar e seguir como se nada
try { await x(); } catch (e) { logger.error(e); }

// ✅ ou trata, ou rethrow
try {
  await x();
} catch (err) {
  if (isRetryable(err)) return retry();
  throw err;
}
```

### 2.3 `cause` para preservar contexto

```ts
try {
  await app.gateways.s3.putObject(...);
} catch (err) {
  throw badGateway("failed to upload report", err);
}
```

### 2.4 Sem Promise rejected silenciosa

`unhandledRejection` derruba o processo. Em handlers async do Fastify, deixe rethrow — o `errorHandler` cuida.

---

## 3. Logging

Recap (regras completas em [`OBSERVABILITY.md`](./OBSERVABILITY.md)):

- Use `req.log` em handlers (já tem `reqId` + `trace_id`).
- Use `logger` (singleton importado) em services/gateways.
- **Sempre objeto primeiro, mensagem depois**: `log.info({ userId }, "user.created")`.
- Mensagens **estáveis e curtas** (`"user.created"`, não frases longas). Contexto no objeto.

---

## 4. Configuração / Env

```ts
// src/config/env.ts
import { z } from "zod/v4";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "staging", "production", "test"]),
  PORT: z.coerce.number().int().min(1).max(65535),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]),

  DATABASE_URL: z.string().min(1),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(200),

  AWS_REGION: z.string().min(1),
  AWS_ENDPOINT_URL: z.string().optional(), // LocalStack em dev

  COGNITO_USER_POOL_ID: z.string().min(1),
  COGNITO_CLIENT_ID: z.string().min(1),
  AUTH_DEV_BYPASS_TOKEN_EXP: z.stringbool().default(false), // dev-only; ignorado em prod

  S3_BUCKET_UPLOADS: z.string().min(1),
  SQS_BOOKING_CREATED_URL: z.string().min(1),
  SNS_BOOKING_EVENTS_TOPIC_ARN: z.string().min(1),

  B2B_USERS_BASE_URL: z.string().min(1),

  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
  OTEL_SERVICE_NAME: z.string().min(1),
});

export type EnvConfig = z.infer<typeof EnvSchema>;

// Zod é a fonte do schema. env sempre chega como string: `z.coerce.*` converte
// para número, e `z.stringbool()` interpreta "true"/"false"/"1"/"0" (não caia em
// `z.coerce.boolean()`, que trata qualquer string não-vazia como true). `.default()`
// preenche ausentes. `safeParse` agrega os erros num relatório único.
export function parseEnv(raw: Record<string, string | undefined>): EnvConfig {
  const result = EnvSchema.safeParse(raw);
  if (!result.success) {
    const msg = result.error.issues.map((e) => `${e.path.join(".")} ${e.message}`).join("; ");
    throw new Error(`Invalid env: ${msg}`);
  }
  return result.data;
}

// Singleton lazy: validado no PRIMEIRO acesso a `env`, não no import — assim
// testes que setam process.env antes de importar (ou que só usam `parseEnv`)
// não quebram em import-time.
let _env: EnvConfig | undefined;
export const env: EnvConfig = new Proxy({} as EnvConfig, {
  get(_t, prop) {
    if (!_env) _env = parseEnv(process.env as Record<string, string | undefined>);
    return (_env as Record<string | symbol, unknown>)[prop];
  },
});
```

**Fail fast.** Falta uma env vital → `parseEnv` lança no primeiro acesso a `env` (na construção do app/logger), e o processo morre cedo.

**Sem `process.env.X` espalhado pelo código.** Sempre `import { env } from "@/config/env"`.

---

## 5. Segurança

### 5.1 Headers

`@fastify/helmet` no início da chain.

### 5.2 CORS

CORS fechado por padrão; liberado só em desenvolvimento. O real `app.ts` faz:

```ts
const corsOrigin =
  env.NODE_ENV === "development"
    ? true
    : (env.CORS_ALLOWED_ORIGINS?.split(",").map((o) => o.trim()).filter(Boolean) ?? []);
await app.register(cors, {
  origin: corsOrigin,
  methods: ["GET", "HEAD", "POST", "PATCH", "DELETE"],
});
```

Dev (`origin: true`) reflete a origin do request. Homolog/prod usam a **allowlist** `CORS_ALLOWED_ORIGINS` (env, separada por vírgula) — array de origins exatas; allowlist vazia → sem headers CORS (só same-origin). **Nunca** `*`.

**`methods` é obrigatório declarar.** O default do `@fastify/cors` é `'GET,HEAD,POST'`, então sem isso o preflight do browser bloqueia PATCH/DELETE com "network error" silencioso. Liste os verbos que a API usa.

### 5.3 Rate limit

`@fastify/rate-limit` registrado em `src/http/plugins/rate-limit/rate-limit.ts` (`rateLimitPlugin`), aplicado globalmente em `app.ts`. Ligado por padrão; desligado quando `buildApp` recebe `rateLimit: false` (default sob `NODE_ENV=test`, para manter o e2e determinístico). Testes que precisam exercitar o limiter real passam `buildApp({ rateLimit: true })` — ver `test/e2e/rate-limit.e2e.test.ts` e `rate-limit.test.ts`.

- **Chave** (`keyGenerator`): hash do bearer token quando presente, senão `req.ip`. O limiter roda no `onRequest` (antes do `preHandler` de auth), então `req.user` ainda não existe — mas o token identifica o principal, separando usuários atrás do mesmo NAT (um tenant não derruba o bucket do outro). Tráfego anônimo/público cai no IP.
- **`req.ip` confiável**: `trustProxy` é fixado em `TRUST_PROXY_HOPS` (default `1` = o ALB), **nunca `true`** — senão a entrada mais à esquerda de `X-Forwarded-For` (controlada pelo cliente) viraria `req.ip` e permitiria *bypass* rotacionando o header.
- **Limites configuráveis por env** (defaults via `.default()` do Zod, sem env novo em deploys existentes; **lidos no boot — mudança exige restart/redeploy**):
  - `RATE_LIMIT_MAX` (default `300`) — teto global frouxo por janela.
  - `RATE_LIMIT_STRICT_MAX` (default `10`) — teto apertado para rotas mutadoras.
  - `RATE_LIMIT_WINDOW_MS` (default `60000`) — janela compartilhada.
- **Endpoints estritos automáticos**: um hook `onRoute` aplica `strictRateLimit()` a toda rota mutadora (`POST/PUT/PATCH/DELETE`) sem `config.rateLimit` explícito — então uma rota nova já nasce protegida, sem o dev lembrar de opt-in. Override explícito (incl. `config: { rateLimit: false }` para isentar, como em `/health`) é respeitado.
- **Resposta 429**: `errorResponseBuilder` retorna um `RateLimitedError` (subclasse de `AppError`); o plugin o lança e o `errorHandler` global serializa o envelope canônico `{ code: "RATE_LIMITED", message, trace_id }` e loga em `warn`. Mantém-se 4xx (não vira 5xx que dispararia o alarme de 5xx → rollback). Headers `Retry-After` / `x-ratelimit-*` sobrevivem ao throw.
- **Store**: in-memory → contagem **por instância**. Atrás do fleet blue/green o limite efetivo é ~`max * nº de instâncias`. Para limite globalmente exato, passe uma conexão `redis` (ElastiCache) ao registrar o plugin.

### 5.4 Autenticação

Cognito JWT verificado em todo request autenticado. **Nunca** armazenamos senha. Detalhes em [`INTEGRATIONS.md`](./INTEGRATIONS.md#autenticacao-cognito).

### 5.5 Segredos

- **Nunca em código, nunca em log.**
- Source: AWS Secrets Manager ou SSM Parameter Store; expostos como env vars no container via script de deploy.
- Use `redact` do Pino — configurado em [`OBSERVABILITY.md`](./OBSERVABILITY.md).

### 5.6 SQL Injection

Drizzle parametriza por padrão. **Nunca** template strings cruas em `sql\`...\``:

```ts
// ❌
db.execute(sql`SELECT * FROM users WHERE email = '${email}'`);

// ✅
db.execute(sql`SELECT * FROM users WHERE email = ${email}`);
```

### 5.7 Body limits e timeouts

```ts
Fastify({
  bodyLimit: 1 * 1024 * 1024,
  connectionTimeout: 10_000,
  requestTimeout: 30_000,
});
```

### 5.8 Validação sempre

Toda input externa passa por Zod. Sem exceção. Inclui:
- Body, params, query, headers customizados.
- Payloads SQS no consumer.
- Responses de serviços externos no gateway.

---

## 6. Estilo

**Biome cuida.** Override do default:
- Aspas: `"double"`
- Semicolons: `"always"`
- Trailing comma: `"all"`
- Line width: `100`
- Indent: 2 espaços

```bash
pnpm check         # biome check
pnpm check:fix
```

Pre-commit (Husky + lint-staged) roda em arquivos staged. Pre-push roda `typecheck` + `test:unit`.

---

## 7. Comentários

- **Por quê, não o quê.** O código diz o quê.
- **JSDoc em API pública** (services exportados, gateways, helpers em `shared/`). Não em internals óbvios.
- **`TODO(nome):` `FIXME(nome):` com dono** + issue link.
- **Sem código comentado morto.** Git tem histórico.

---

## 8. Definition of Done

- [ ] Compila sem warning (`pnpm typecheck`)
- [ ] Lint passa (`pnpm check`)
- [ ] Testes novos cobrem o caso (unit + integração onde aplicável)
- [ ] Testes existentes passam (`pnpm test:run`)
- [ ] Cobertura não caiu
- [ ] Endpoint novo: response schema, teste e2e, aparece no Swagger
- [ ] Toda rota declara `operationId` (camelCase `<verbo><Recurso>`, ex. `createRfp`) e `tags` (nome do recurso) no `schema` — para a doc OpenAPI
- [ ] DB novo: migration, teste de integração
- [ ] Integração externa nova: gateway com fake em teste, policy de resilience
- [ ] Métricas/traces relevantes em lugar; logs estruturados
- [ ] Sem segredo em código; envs novos em `env.ts` + SSM Parameter Store (`/myapp/<env>/`)
- [ ] README/docs atualizados se mudou contrato
- [ ] Sem regressão de performance > 5% nos benchmarks
- [ ] Nova rota declara `config.permissions` (ou `config.public: true` se realmente pública). Personas vindas do catálogo (`PERMISSIONS.*`) — nunca strings literais.
- [ ] Teste e2e cobre "persona errada → 403 AUTH-T0011" para rotas de escrita.
- [ ] Throws novos passam pelo catálogo (`ERRORS.MOD.NAME(...)`), nunca `new AppError(...)` direto.
- [ ] Novos códigos de erro têm mensagens em `pt-BR`, `en-US` e `es-ES`.

---

## 9. PR

- **Pequenos.** < 400 linhas de diff sempre que possível.
- **Um propósito.** "Add create-user use-case" sim. "Add users + fix logging + bump deps" não.
- **Descrição em formato:**
  - **Contexto** — por que existe
  - **Mudança** — o que mudou em alto nível
  - **Como testar** — passos pra reviewer rodar
  - **Risco** — o que pode quebrar, como mitigamos
