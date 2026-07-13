# DATABASE — convenções de tabela

> **Mecanismo, não inventário.** Define como TODA tabela é modelada. O schema vive em `src/infra/db/tables/<recurso>/*.table.ts`; o helper `src/infra/db/columns.ts` carrega as colunas-padrão. Migrations em `src/infra/db/migrations/` (Drizzle).

## 1. Toda tabela carrega

Spread `entityColumns('<table>')` primeiro no corpo do `pgTable`, depois as colunas de domínio:

```ts
export const rfp = pgTable('rfp', {
  ...entityColumns('rfp'),
  companyId: bigint('company_id', { mode: 'number' }).notNull().references(() => company.id),
  // ...colunas de domínio
});
```

`entityColumns(name)` injeta, nesta ordem:

| Coluna (JS / DB) | Tipo | Papel |
|---|---|---|
| `id` / `<table>_id` | `bigint` identity PK (`generatedAlwaysAsIdentity`) | **PK interna**. Sequencial, barata em FK/índice/cursor. **Nunca exposta em endpoint.** A propriedade JS é sempre `id`; só o nome da coluna varia (`rfp_id`, `company_id`, …). |
| `uuid` | `uuid` UNIQUE, default `gen_random_uuid()` | **Identificador público.** Todo lookup/list de endpoint usa o uuid. |
| `created_by` / `updated_by` | `uuid` NOT NULL, FK → `user.uuid` | Ator de auditoria (o `user.uuid` de quem escreveu). |
| `created_at` / `updated_at` | `timestamptz` NOT NULL default `now()` | Timestamps UTC (ver [`DATES.md`](./DATES.md)). |
| `deleted_at` | `timestamptz` nullable | Soft-delete. |

`alpha_id` (quando existe) = id de **sistema externo** (Cognito sub, agencies), não nasce do helper.

## 2. Regras

- **Nomes de tabela no singular** (`user`, `company`, `rfp_participant`). `user` é palavra reservada no SQL — em SQL cru, sempre `"user"`.
- **PK nunca sai pela API.** Params/queries de rota resolvem pelo `uuid`; presenter expõe `uuid` como `id`. Scoping por empresa usa o `company_id` (PK bigint) internamente, nunca o uuid.
- **FK interna referencia a PK bigint** (`rfp.company_id` → `company.company_id`). Threading de id: a camada de auth resolve o sub → carrega `userId`/`companyId` (PKs) **e** `userUuid`/`companyUuid` (públicos); writes usam as PKs nos FKs e o `userUuid` em `created_by`/`updated_by`.
- **Todo write passa `actorUuid`.** Repos de escrita (`insertMany`/`insert`/`replaceForRfp`/`insertAggregate`/`softDelete`) recebem o `actorUuid` (último parâmetro) e carimbam `created_by`/`updated_by`. Reads não.
- **Reads que expõem refs cruzadas** (ex. RFP → company/user) usam um *view* com join para trazer os uuids públicos — ver `rfp/repository/view.ts` (`RfpView`, `rfpViewColumns`, `readRfpViewByPk`). Nunca serialize a PK.

## 3. Bootstrap SYSTEM

`created_by`/`updated_by` são FK NOT NULL para `user.uuid`. Linhas escritas fora de request (provisionamento out-of-band, fixtures, o próprio seed) atribuem ao **usuário SYSTEM**:

- `SYSTEM_ACTOR_UUID` / `SYSTEM_COMPANY_UUID` em `src/shared/constants/system-actor.ts` (espelhados como literais no seed da migration baseline — manter em sync).
- A migration baseline semeia a company SYSTEM + o user SYSTEM. Como `company.created_by`/`updated_by` referenciam um user que ainda não existe no momento do insert da company, esses dois FKs são **`DEFERRABLE INITIALLY DEFERRED`** (checados no COMMIT da migration, quando ambas as linhas já existem). O user SYSTEM auto-referencia o próprio uuid.
- Provisionamento (`provisionCaller`) e seed de teste (`test/e2e/helpers/seed.ts`) usam `SYSTEM_ACTOR_UUID` nas colunas de auditoria.

## 4. Migrations

- `pnpm db:generate` gera o diff a partir do schema TS. O snapshot em `migrations/meta/` **não** modela `DEFERRABLE` nem seeds (são SQL cru editado à mão no `.sql`), então não geram drift em generates futuros.
- Mudança de PK (uuid→bigint), rename de tabela e reescrita de FK **não** são diffáveis com segurança pelo Drizzle — preferir baseline limpo (squash) em pré-prod. Em ambiente com dados, ver [`OPERATIONS.md`](./OPERATIONS.md).
