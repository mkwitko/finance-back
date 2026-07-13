# ERRORS.md — Sistema de erros (mecanismo)

> Descreve **como** erros funcionam — formato, factory, envelope, i18n. **Não enumera os códigos**: o inventário vive no código (`src/shared/errors/catalog.ts` + os `i18n/<locale>.json`), que é a fonte da verdade. Adicionar um código **não** exige editar este doc.

---

## Formato do código

`SIGLA-TNNNN`. `T` = "technical" (slots futuros podem usar `B` business / `V` validation). A `SIGLA` é o módulo (2–4 letras maiúsculas) e nasce quando você cria o `*.errors.ts` daquele módulo. As siglas **ativas neste projeto** estão em [`PROJECT.md` §4](./PROJECT.md#4-erros--módulos-siglas-ativos); a lista canônica é `catalog.ts`.

## Lançar via factory

Todo código ship com `pt-BR`, `en-US` e `es-ES` em `src/shared/errors/i18n/<locale>.json`. O catálogo vive em `src/shared/errors/catalog.ts`. **Sempre** lance pela factory, nunca `new AppError(...)` direto:

```ts
throw ERRORS.RFP.NOT_FOUND({ rfpId });
throw ERRORS.SYS.BAD_GATEWAY({ statusCode });
```

`details` (o objeto passado à factory) aparece no envelope em ambientes não-produção e nos logs. Para preservar a causa raiz de uma falha upstream sem vazá-la ao cliente, use `withCause(factory, details, cause)`.

Para uma falha de **gateway** (chamada a serviço externo), use `upstreamError(factory, { status, message }, cause)`: o nosso endpoint apresenta **sempre o nosso status** (um 502 `SYS-T0012 UPSTREAM_ERROR`) — nunca adota o status do upstream como nosso — mas carrega o `{ status, message }` do upstream no campo `upstream` do `AppError`. Esse campo é exposto no envelope **inclusive em produção** (vem de serviço interno confiável, ao contrário de `details`, que fica só em não-produção).

## Envelope de resposta

Em **produção** (enxuto):

```json
{ "status": 401, "code": "AUTH-T0001", "message": "Token inválido.", "trace_id": "4bf9…" }
```

O `code` é exposto em produção (identificador não-sensível): o usuário vê a `message` i18n amigável, e dev/suporte usa `code` + `trace_id` para identificar a classe do erro e puxar o registro completo (`stack`/`internal_message`/`payload`) dos logs pelo trace. `stack`, `internal_message`, `url`/`method` e `details` continuam **fora** do envelope de produção.

Em qualquer ambiente **não-produção** (`development`, `staging`, `test`) — verboso pra debug:

```json
{
  "status": 401,
  "code": "AUTH-T0001",
  "message": "Token inválido.",
  "internal_message": "invalid_token",
  "url": "/rfps/abc-123",
  "method": "GET",
  "trace_id": "4bf9…",
  "details": { "rfpId": "abc-123" },
  "stack": "AppError: invalid_token\n    at …"
}
```

Numa falha de gateway o envelope ganha também `"upstream": { "status": 404, "message": "…" }` — em produção e fora dela — com o status/mensagem que o serviço externo retornou (ver `upstreamError` acima). Nosso `status` permanece 502.

`trace_id` vem do span ativo do OTel. Erros de validação do Zod (via `fastify-type-provider-zod`, marcados com `.validation`) viram `SYS-T0002` (400). Qualquer valor lançado fora do catálogo cai no fallback `internal_server_error` (500) e dispara o alarme de 5xx → rollback.

## i18n

`message` é resolvido contra o `Accept-Language` do request, com `pt-BR` como default. Fallback por subtag primário: `pt-PT`→pt-BR, `en-GB`→en-US, `es-MX`→es-ES.

## Adicionar um código novo

1. Escolha a sigla (existente ou nova — 2–4 maiúsculas).
2. Adicione a entrada em `src/shared/errors/catalog.ts` (`code`, `status`, `internalMessage`).
3. Adicione as strings `pt-BR`, `en-US` e `es-ES` nos três `src/shared/errors/i18n/<locale>.json` (o teste de cobertura de bundle obriga).

Pronto — **não há passo "atualizar este doc"**. Sigla genuinamente nova de um módulo novo? Registre-a em [`PROJECT.md` §4](./PROJECT.md#4-erros--módulos-siglas-ativos).
