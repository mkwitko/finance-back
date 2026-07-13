# DOCKER.md — Docker para Dev e Produção

> Mesma imagem em dev e produção (com pequenas variações), garantindo parity. Em dev, `pnpm dev` sobe Postgres + LocalStack (mock AWS) + app com hot reload.

---

## 1. Dois Dockerfiles, intenções diferentes

| Arquivo | Uso | Características |
|---|---|---|
| `docker/Dockerfile` | Produção (CodeBuild → ECR → EC2) | Multi-stage, distroless, sem dev deps, sem código-fonte |
| `docker/Dockerfile.dev` | Dev local | Inclui `tsx`, mounts da pasta `src/`, hot reload |

---

## 2. Dockerfile de produção

```dockerfile
# docker/Dockerfile
# syntax=docker/dockerfile:1.7

# ---------- Stage 1: deps ----------
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9 --activate
COPY package.json pnpm-lock.yaml .npmrc ./
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm fetch --frozen-lockfile

# ---------- Stage 2: build ----------
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9 --activate
COPY --from=deps /app /app
COPY . .
RUN pnpm install --frozen-lockfile --offline
RUN pnpm build
RUN pnpm prune --prod

# ---------- Stage 3: runtime ----------
FROM gcr.io/distroless/nodejs22-debian12:nonroot AS runtime
WORKDIR /app

COPY --from=build --chown=nonroot:nonroot /app/dist ./dist
COPY --from=build --chown=nonroot:nonroot /app/node_modules ./node_modules
COPY --from=build --chown=nonroot:nonroot /app/package.json ./package.json
COPY --from=build --chown=nonroot:nonroot /app/drizzle ./drizzle

USER nonroot
EXPOSE 3000

ENV NODE_ENV=production \
    NODE_OPTIONS="--enable-source-maps --max-old-space-size=768"

CMD ["--import", "./dist/instrumentation.js", "./dist/server.js"]
```

**Por que distroless:**
- Sem shell, sem package manager, sem coreutils → superfície de ataque mínima.
- Imagem final ~80MB vs ~300MB do node:slim.
- Roda como `nonroot` (UID 65532) por padrão.

**Build args:**

```bash
docker build -t myapp-api:latest -f docker/Dockerfile .
```

---

## 3. Dockerfile de dev (hot reload)

```dockerfile
# docker/Dockerfile.dev
FROM node:22-bookworm-slim

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9 --activate

# Instalar deps primeiro (cache layer)
COPY package.json pnpm-lock.yaml .npmrc ./
RUN pnpm install --frozen-lockfile

# Código vem por volume (não COPY); permite hot reload
EXPOSE 3000

ENV NODE_ENV=development

# tsx watch reinicia ao detectar mudança
CMD ["pnpm", "exec", "tsx", "watch", "--clear-screen=false", "src/server.ts"]
```

---

## 4. `.dockerignore`

```
node_modules
dist
.git
.github
.vscode
.idea
coverage
.env*
*.log
test/
*.test.ts
docs/
infra/cdk.out/
```

---

## 5. Docker Compose para dev

```yaml
# docker/docker-compose.yml
services:
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: myapp
      POSTGRES_PASSWORD: myapp
      POSTGRES_DB: myapp
    ports:
      - "5432:5432"
    volumes:
      - postgres-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U myapp"]
      interval: 5s
      timeout: 3s
      retries: 5

  localstack:
    # LocalStack = AWS local. Implementa S3, SQS, SNS, Cognito (limitado), etc.
    image: localstack/localstack:3.7
    restart: unless-stopped
    environment:
      SERVICES: s3,sqs,sns
      DEBUG: 0
      AWS_DEFAULT_REGION: sa-east-1
      DOCKER_HOST: unix:///var/run/docker.sock
    ports:
      - "4566:4566"
    volumes:
      - localstack-data:/var/lib/localstack
      - /var/run/docker.sock:/var/run/docker.sock
      # Script roda na inicialização: cria buckets, queues, topics
      - ../scripts/localstack-init.sh:/etc/localstack/init/ready.d/init.sh
    healthcheck:
      test: ["CMD", "curl", "-sf", "http://localhost:4566/_localstack/health"]
      interval: 5s
      timeout: 3s
      retries: 10

  api:
    build:
      context: ..
      dockerfile: docker/Dockerfile.dev
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
      localstack:
        condition: service_healthy
    environment:
      NODE_ENV: development
      LOG_LEVEL: debug
      PORT: 3000
      DATABASE_URL: postgres://myapp:myapp@postgres:5432/myapp
      AWS_REGION: sa-east-1
      AWS_ACCESS_KEY_ID: test
      AWS_SECRET_ACCESS_KEY: test
      # Aponta SDK AWS para LocalStack em vez do AWS real
      AWS_ENDPOINT_URL: http://localstack:4566
      S3_BUCKET_UPLOADS: myapp-user-uploads
      SQS_BOOKING_CREATED_URL: http://localstack:4566/000000000000/booking-created
      SNS_BOOKING_EVENTS_TOPIC_ARN: arn:aws:sns:us-east-1:000000000000:booking-events
      # Cognito: o gateway sempre verifica JWT real (ver seção 7)
      COGNITO_USER_POOL_ID: us-east-1_local
      COGNITO_CLIENT_ID: local-client-id
      # OTel desligado em dev por padrão (liga se quiser testar)
      OTEL_SDK_DISABLED: "true"
      B2B_USERS_BASE_URL: http://host.docker.internal:3001
      OTEL_SERVICE_NAME: myapp-api   # ver PROJECT.md §1 p/ o nome real do serviço
    ports:
      - "3000:3000"
    volumes:
      # Mount código-fonte para hot reload
      - ../src:/app/src
      - ../drizzle:/app/drizzle
      - ../tsconfig.json:/app/tsconfig.json
      # Volume nomeado para node_modules: evita conflito com host
      - api-node-modules:/app/node_modules

volumes:
  postgres-data:
  localstack-data:
  api-node-modules:
```

---

## 6. Script de inicialização do LocalStack

```bash
#!/bin/bash
# scripts/localstack-init.sh
# Roda automaticamente quando LocalStack está pronto.

set -e

echo "Initializing LocalStack resources..."

# S3 buckets
awslocal s3 mb s3://myapp-user-uploads
awslocal s3 mb s3://myapp-app-assets

# SQS queues
awslocal sqs create-queue --queue-name booking-created
awslocal sqs create-queue --queue-name booking-created-dlq

# Configurar DLQ
QUEUE_URL=$(awslocal sqs get-queue-url --queue-name booking-created --query QueueUrl --output text)
DLQ_ARN=$(awslocal sqs get-queue-attributes --queue-url $(awslocal sqs get-queue-url --queue-name booking-created-dlq --query QueueUrl --output text) --attribute-names QueueArn --query Attributes.QueueArn --output text)

awslocal sqs set-queue-attributes \
  --queue-url "$QUEUE_URL" \
  --attributes "{\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"$DLQ_ARN\\\",\\\"maxReceiveCount\\\":\\\"5\\\"}\"}"

# SNS topic
awslocal sns create-topic --name booking-events

# Subscrever SQS no SNS
TOPIC_ARN=$(awslocal sns list-topics --query "Topics[?contains(TopicArn, 'booking-events')].TopicArn" --output text)
QUEUE_ARN=$(awslocal sqs get-queue-attributes --queue-url "$QUEUE_URL" --attribute-names QueueArn --query Attributes.QueueArn --output text)
awslocal sns subscribe --topic-arn "$TOPIC_ARN" --protocol sqs --notification-endpoint "$QUEUE_ARN"

echo "LocalStack ready ✓"
```

---

## 7. Cognito em dev

O gateway **sempre** verifica JWT real do Cognito via `aws-jwt-verify` (`createCognitoGateway`) — não há bypass HS256 nem flag `COGNITO_DEV_MODE` no código. Para dev e testes locais:

- **Testes (unit/integração/e2e):** o app é construído com gateways fakes — `buildApp({ gateways: buildFakeGateways(...) })`. O fake `cognito.verifyToken` deriva `{ sub, username, permissions }` do próprio token (token = sub), sem chamar o Cognito real. Ver [`TESTING.md`](./TESTING.md).
- **Rodar a API localmente contra Cognito:** aponte `COGNITO_USER_POOL_ID`/`COGNITO_CLIENT_ID` para um user pool real (ou de staging) e mande um **ID token** válido (`token_use: "id"`) em `Authorization: Bearer <token>`. O user é provisionado no 1º `GET /users/authenticated-user` (que chama o agencies e cria company+user); as demais rotas só fazem lookup e rejeitam com `user_not_provisioned` (403) se o bootstrap ainda não rodou.

LocalStack não provê Cognito na versão gratuita; por isso o caminho de dev é via fakes (testes) ou um pool real.

---

## 8. Comandos do dia a dia

Aliases em `package.json`:

```json
{
  "scripts": {
    "dev": "docker compose -f docker/docker-compose.yml up --build",
    "dev:down": "docker compose -f docker/docker-compose.yml down",
    "dev:reset": "docker compose -f docker/docker-compose.yml down -v",
    "dev:logs": "docker compose -f docker/docker-compose.yml logs -f api",
    "dev:db": "docker compose -f docker/docker-compose.yml up -d postgres localstack",
    "dev:native": "tsx watch --clear-screen=false src/server.ts",
    "dev:token": "tsx scripts/gen-dev-token.ts",
    "homolog": "docker compose -f docker/docker-compose.homolog.yml up",
    "homolog:down": "docker compose -f docker/docker-compose.homolog.yml down",
    "production": "docker compose -f docker/docker-compose.production.yml up",
    "production:down": "docker compose -f docker/docker-compose.production.yml down"
  }
}
```

**App local contra AWS homolog real** (`docker-compose.homolog.yml`): sem Postgres/LocalStack — o app fala com RDS + S3 + Cognito reais de homolog. Cognito JWT verify pega JWKS via HTTPS (sem creds); S3 exige creds. Secrets em `docker/.env.homolog` (gitignored; copie de `.env.homolog.example`). Suba com `pnpm homolog`. Migrations homolog são à parte: `pnpm db:migrate:homolog` (aponta DB real — cuidado).

**App local contra AWS prod real** (`docker-compose.production.yml`): mesmo padrão do homolog apontando produção. Diferenças deliberadas no `.env.production`: `NODE_ENV=production`, `LOG_LEVEL=info`, **sem** `AUTH_DEV_BYPASS_TOKEN_EXP` (tokens prod expiram normal). Secrets em `docker/.env.production` (gitignored; copie de `.env.production.example`). Suba com `pnpm production`. **⚠️ Writes batem dados reais de cliente — use só com intenção.**

**Workflow típico:**

```bash
# Primeira vez: sobe tudo (DB cria, LocalStack provisiona)
pnpm dev

# Outro terminal: aplica migrations
pnpm db:migrate

# Outro terminal: gera token de dev
pnpm dev:token meu@teste.com
# → Bearer eyJhbG...

# Faz requests
curl -H "Authorization: Bearer eyJhbG..." http://localhost:3000/v1/users/me
```

---

## 9. Dev sem Docker (alternativa rápida)

Se o ciclo de feedback do Docker incomodar (rebuild lento em mudança de deps):

```bash
# Sobe só Postgres + LocalStack via Docker
pnpm dev:db

# Roda app native (mais rápido, debugger nativo do VS Code)
pnpm dev:native
```

Vantagem: hot reload instantâneo, breakpoints no editor.
Desvantagem: menos paridade com prod.

Para a maioria das tasks, `pnpm dev` (tudo no Docker) é melhor. Para debug pesado, `pnpm dev:native`.

---

## 10. Verificando que tudo subiu

```bash
# Healthcheck do app
curl http://localhost:3000/health/ready

# LocalStack
curl http://localhost:4566/_localstack/health

# Postgres
docker compose -f docker/docker-compose.yml exec postgres psql -U myapp -c "\l"

# Listar buckets S3 no LocalStack
aws --endpoint-url=http://localhost:4566 s3 ls

# Listar queues SQS
aws --endpoint-url=http://localhost:4566 sqs list-queues
```

> Para usar `aws` CLI sem `--endpoint-url` toda vez, instale `awscli-local` (`pip install awscli-local`) e use `awslocal`.

---

## 11. Troubleshooting comum

| Sintoma | Causa provável | Solução |
|---|---|---|
| Mudança em código não recarrega | Volume não montado | Verifique paths em `volumes:` no compose |
| `EADDRINUSE :3000` | Outro processo na porta | `lsof -i :3000` + kill, ou mude `PORT` |
| `Cannot connect to postgres` | Postgres ainda subindo | Aguarde healthcheck; `depends_on` cobre maioria dos casos |
| LocalStack SDK call falha | Endpoint não setado | `AWS_ENDPOINT_URL` apontando pra `http://localstack:4566` |
| Permissão negada no volume | UID host ≠ UID container | Use volumes nomeados (`api-node-modules`) em vez de bind |
| `node_modules` corrupto após mudar deps | Cache antigo | `pnpm dev:reset` (apaga volumes) |
