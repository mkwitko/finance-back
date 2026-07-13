# DATES.md — Datas e timestamps

> Como o projeto grava, serializa, pagina e testa datas. Documento **descritivo**: descreve a convenção que o código já segue hoje. Antes de criar qualquer endpoint que exponha data, leia as 8 seções abaixo — principalmente a § 5 (precisão de milissegundos), que é a regra mais fácil de quebrar.

---

## 1. Princípio: UTC ponta a ponta

A aplicação trabalha **sempre em UTC**. Não há conversão de fuso horário no código de runtime — nenhum `America/Sao_Paulo`, nenhum `Intl.DateTimeFormat`, nenhuma lib de timezone.

- **Banco grava UTC.** Toda coluna de data é `timestamptz` (ver § 2); o Postgres normaliza para UTC na escrita.
- **App não converte.** Services e repositories passam `Date`/string ISO adiante sem reinterpretar o fuso.
- **Conversão para fuso local é do cliente.** O frontend (ou o consumidor da API) decide como exibir a data ao usuário final. A API entrega instantes absolutos em ISO 8601 com `Z`.

Consequência prática: se você precisa de "agora", use `new Date()` (instante UTC). Nunca monte strings de data manualmente nem aplique offset de fuso.

---

## 2. Armazenamento (Drizzle + Postgres)

Toda coluna de data usa `timestamp(col, { withTimezone: true })` → `timestamptz` no Postgres. **Nunca** use `timestamp` sem `withTimezone`, nem `date`/`time` puros.

```ts
// src/http/api/bookings/bookings.table.ts
createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`),
```

### 2.1 `created_at` / `updated_at`

Padrão em toda tabela: par `createdAt` + `updatedAt`, ambos `.notNull()`.

| Default | Quando usar |
|---|---|
| `.defaultNow()` | Default JS-side do Drizzle. Usado em `createdAt`. |
| `.default(sql\`now()\`)` | Default no DB via função `now()`. Usado em `updatedAt`. |

> Esses defaults são a **rede de segurança** do schema. Na escrita de tabelas paginadas, o writer ainda grava o timestamp explicitamente — ver § 5.

### 2.2 Índices incluem `createdAt`

Tabelas paginadas indexam `createdAt` para o keyset cursor. Exemplo de `bookings.table.ts`:

```ts
index('idx_bookings_user').on(t.userId, t.createdAt),
index('idx_bookings_tenant').on(t.tenantId, t.createdAt),
index('idx_bookings_cursor').on(t.createdAt, t.id),
```

O índice `(createdAt, id)` espelha exatamente a ordenação do cursor (§ 5). Ver também [`PERFORMANCE.md`](./PERFORMANCE.md) sobre índices.

---

## 3. Serialização HTTP (Zod)

Datas saem da API como **string ISO 8601** (ex.: `2026-05-27T14:29:00.000Z`). No schema Zod, são `z.string()` **puro**:

```ts
// src/http/api/bookings/list-bookings/list-bookings.schema.ts
createdAt: z.string(),
updatedAt: z.string(),
```

### 3.1 Hoje não há `format: 'date-time'`

> ⚠️ Importante: o contrato "isto é uma data ISO" é uma **convenção de aplicação**, **não** validada pelo Zod. Os schemas não usam `z.iso.datetime()`. Não assuma que o framework rejeita uma data malformada num campo de data — ele não rejeita hoje.

Se um dia for necessário validar o formato, é uma mudança deliberada (trocar por `z.iso.datetime()` + decidir comportamento) — **não** introduza validação de formato pontualmente sem alinhar com o time. Por ora: campo de data ⇒ `z.string()`.

### 3.2 Tipo de domínio guarda `string`, não `Date`

A camada de domínio carrega datas como `string` ISO já serializada (não objeto `Date`). A conversão acontece no repositório (§ 4), então tudo acima do repo lida só com string.

---

## 4. Conversão `Date ↔ string`

Sem lib de data. Só o `Date` nativo, `.toISOString()` e `new Date(str)`.

**Leitura (DB → domínio):** o Drizzle devolve `Date`; o repositório converte com `.toISOString()` em `toDomain`:

```ts
// src/http/api/bookings/bookings.repository.ts
function toDomain(row: BookingRow): Booking {
  return {
    // ...
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
```

**Escrita:** sempre `new Date()` (ver § 5 para o porquê de ser explícito).

> ❌ Não adicione `date-fns`, `dayjs`, `luxon` ou `moment`. ✅ `Date` nativo + `.toISOString()` cobre todos os casos atuais. Parsing de string ISO: `new Date(str)`, validando com `Number.isNaN(d.getTime())`.

---

## 5. ⚠️ Precisão de milissegundos no cursor (regra crítica)

Esta é a regra mais sutil do projeto. **Writers de tabelas paginadas devem gravar `createdAt` com `new Date()`** (precisão de ms), não confiar só no default `now()` do DB.

### 5.1 Por quê

- `timestamptz` no Postgres guarda **microssegundos** (µs).
- O `Date` do JS — que lemos de volta e codificamos no cursor — só tem **milissegundos** (ms).
- O cursor codifica `createdAt.toISOString()` (ms). Se o valor gravado tiver µs (ex.: deixar só `now()` do DB), o `Date` lido e o cursor divergem do valor real da coluna → **linhas criadas no mesmo milissegundo podem ser puladas entre páginas**.

Regra: na escrita, fixe ms gravando `new Date()`. Assim `lido == gravado == cursor`.

```ts
// src/http/api/bookings/bookings.repository.ts (insertWithOutbox)
// Set timestamps explicitly to millisecond precision: timestamptz stores
// microseconds, but the JS Date we read back (and encode into cursors) only
// has milliseconds — the divergence would make cursor pagination skip rows
// sharing a millisecond. Storing ms keeps read == stored == cursor.
const now = new Date();
const inserted = await tx
  .insert(bookings)
  .values({ id, /* ... */ createdAt: now, updatedAt: now })
  .returning();
```

### 5.2 Cursor opaco: `base64url(<createdAt ISO>|<id>)`

`encodeCursor`/`decodeCursor` em `src/infra/db/cursor.ts`:

```ts
export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`).toString('base64url');
}

export function decodeCursor(cursor: string): Cursor | null {
  try {
    const [ts, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    if (!ts || !id) return null;
    const createdAt = new Date(ts);
    if (Number.isNaN(createdAt.getTime())) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}
```

### 5.3 Keyset `(createdAt desc, id desc)`

O timestamp sozinho não é único — duas linhas podem dividir o mesmo ms. Por isso o keyset desempata por `id`. `afterCursor` e `keysetOrderBy` andam **sempre juntos** para a ordem do scan e a comparação do cursor não divergirem:

```ts
// afterCursor: rows estritamente após `decoded` em (createdAt desc, id desc)
or(
  lt(createdAtCol, decoded.createdAt),
  and(eq(createdAtCol, decoded.createdAt), lt(idCol, decoded.id)),
);

// keysetOrderBy: o ORDER BY que afterCursor assume
[desc(createdAtCol), desc(idCol)];
```

Detalhes de transações e cursor: [`ARCHITECTURE.md`](./ARCHITECTURE.md).

---

## 6. Outbox / ordenação

A tabela `outbox` usa o mesmo `timestamptz`, mas a ordenação é **oposta** à do cursor de leitura: o relay drena por `createdAt ASC` (FIFO — eventos mais antigos primeiro). `publishedAt` é nullable; `NULL` = ainda não publicado.

```ts
// src/workers/outbox-relay/outbox-relay.ts
.where(isNull(outbox.publishedAt))
.orderBy(asc(outbox.createdAt))
.limit(batchSize)
// ...
await tx.update(outbox).set({ publishedAt: new Date() }).where(eq(outbox.id, row.id));
```

`publishedAt` também é gravado com `new Date()`, consistente com § 4.

---

## 7. Testes

- **Fixtures** criam datas com `new Date()` (ex.: `TESTING.md` § fixtures).
- **Paginação:** para exercitar o desempate por `id` da § 5.3, crie **várias linhas no mesmo milissegundo** (passando o mesmo `Date` a inserts consecutivos) e verifique que nenhuma é pulada nem repetida ao percorrer as páginas. Esse é o caso que a regra de ms protege.
- **Round-trip de cursor:** `decodeCursor(encodeCursor(d, id))` deve devolver o mesmo instante (ms) e id; cursor inválido ⇒ `null`.

Setup de testes: [`TESTING.md`](./TESTING.md).

---

## 8. Checklist rápido

| Ação | Faça | Não faça |
|---|---|---|
| Coluna de data | `timestamp(col, { withTimezone: true })` | `timestamp` sem TZ, `date`, `time` |
| Gravar timestamp (tabela paginada) | `new Date()` explícito (ms) | confiar só no default `now()` do DB (µs) |
| Serializar p/ HTTP | `Date.toISOString()` → `z.string()` | montar string de data à mão |
| Schema de campo data | `z.string()` | assumir que `format` valida (não há) |
| Tipo de domínio | `string` ISO | objeto `Date` acima do repo |
| Paginar | keyset `(createdAt desc, id desc)`, `encodeCursor` | offset/`LIMIT OFFSET` |
| Fuso | UTC em todo lugar; converter no cliente | `Intl`/timezone no app |
| Lib de data | `Date` nativo | `date-fns`, `dayjs`, `luxon`, `moment` |

---

**Veja também:** [`ARCHITECTURE.md`](./ARCHITECTURE.md) (cursor, transações, erros) · [`PERFORMANCE.md`](./PERFORMANCE.md) (índices) · [`TESTING.md`](./TESTING.md) (fixtures, e2e).
