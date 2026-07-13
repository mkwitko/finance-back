import { z } from "zod/v4";
import { logger } from "../../infra/observability/logger.js";

export type CategorizationItem = {
  index: number;
  description: string;
  direction: "in" | "out";
  amountCents: number;
};

export type CategorizationRequest = {
  categories: { name: string; kind: "income" | "expense" }[];
  items: CategorizationItem[];
};

export type Categorization = {
  index: number;
  category: string | null;
  confidence: number;
};

export type ExtractedRow = {
  amountCents: number;
  direction: "in" | "out";
  description: string;
  occurredAt: string | null; // ISO date (YYYY-MM-DD) if the receipt shows one
};

export interface DeepseekGateway {
  /** False when no API key is configured — callers can skip the round-trip. */
  readonly enabled: boolean;
  /** Assign a category name + confidence (0-100) to each item. Never throws: on any
   *  failure it returns [] so the import still completes (uncategorized). */
  categorizeTransactions(req: CategorizationRequest): Promise<Categorization[]>;
  /** Extract transaction rows from raw OCR text of a receipt/Pix/fatura. Returns []
   *  when disabled or on any failure. */
  extractReceipt(text: string): Promise<ExtractedRow[]>;
}

// Deepseek is OpenAI-compatible. We ask for a strict JSON object and validate it.
const CategorizeSchema = z.object({
  items: z.array(
    z.object({
      index: z.number().int(),
      category: z.string().nullable(),
      confidence: z.number().min(0).max(100),
    }),
  ),
});

const ReceiptSchema = z.object({
  items: z.array(
    z.object({
      amountCents: z.number().int().nonnegative(),
      direction: z.enum(["in", "out"]),
      description: z.string(),
      occurredAt: z.string().nullable(),
    }),
  ),
});

const TIMEOUT_MS = 20_000;

function buildPrompt(req: CategorizationRequest): string {
  const income = req.categories.filter((c) => c.kind === "income").map((c) => c.name);
  const expense = req.categories.filter((c) => c.kind === "expense").map((c) => c.name);
  return [
    "Você é um categorizador de transações financeiras em português do Brasil.",
    "Para cada transação, escolha UMA categoria da lista correspondente ao seu tipo.",
    'Transações "in" (entradas) usam categorias de RECEITA; "out" (saídas) usam categorias de DESPESA.',
    `Categorias de RECEITA: ${income.join(", ")}`,
    `Categorias de DESPESA: ${expense.join(", ")}`,
    "Se nenhuma categoria servir, use null. confidence é um inteiro de 0 a 100.",
    'Responda APENAS JSON no formato: {"items":[{"index":0,"category":"Nome","confidence":90}]}.',
    "",
    "Transações:",
    JSON.stringify(
      req.items.map((i) => ({
        index: i.index,
        direction: i.direction,
        amount: (i.amountCents / 100).toFixed(2),
        description: i.description,
      })),
    ),
  ].join("\n");
}

const RECEIPT_PROMPT = [
  "Você extrai transações financeiras do texto (OCR) de um comprovante, Pix ou fatura.",
  "Retorne cada item de compra/pagamento como uma transação.",
  'amountCents é inteiro em centavos; direction é "out" para gastos/pagamentos e "in" para entradas;',
  "occurredAt é a data no formato ISO YYYY-MM-DD, ou null se não houver.",
  'Responda APENAS JSON: {"items":[{"amountCents":1590,"direction":"out","description":"...","occurredAt":"2024-01-15"}]}.',
].join("\n");

export function createDeepseekGateway(opts: {
  apiKey: string | undefined;
  baseUrl: string;
  model: string;
}): DeepseekGateway {
  const enabled = Boolean(opts.apiKey);

  // Shared OpenAI-compatible JSON call. Returns the message content string or null.
  async function callJson(userContent: string): Promise<string | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(`${opts.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${opts.apiKey}`,
        },
        body: JSON.stringify({
          model: opts.model,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: "You output only valid JSON." },
            { role: "user", content: userContent },
          ],
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        logger.warn({ status: res.status }, "deepseek non-2xx");
        return null;
      }
      const payload = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      return payload.choices?.[0]?.message?.content ?? null;
    } catch (err) {
      logger.warn({ err }, "deepseek request failed");
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    enabled,
    async categorizeTransactions(req) {
      if (!enabled || req.items.length === 0) return [];
      const content = await callJson(buildPrompt(req));
      if (!content) return [];
      try {
        const parsed = CategorizeSchema.safeParse(JSON.parse(content));
        return parsed.success ? parsed.data.items : [];
      } catch {
        return [];
      }
    },
    async extractReceipt(text) {
      if (!enabled || text.trim().length === 0) return [];
      const content = await callJson(`${RECEIPT_PROMPT}\n\nTexto:\n${text}`);
      if (!content) return [];
      try {
        const parsed = ReceiptSchema.safeParse(JSON.parse(content));
        return parsed.success ? parsed.data.items : [];
      } catch {
        return [];
      }
    },
  };
}
