import { and, isNull } from "drizzle-orm";
import { SYSTEM_ACTOR_UUID } from "../../../shared/constants/system-actor.js";
import type { Db } from "../client.js";
import type { CategoryKind } from "../tables/categories/category.table.js";
import { category } from "../tables/categories/category.table.js";

// System default categories (householdId = null, visible to everyone). Kept in pt-BR
// for the launch market. The category NAMES are also the label set the Deepseek
// categorizer is constrained to when auto-tagging imported transactions.
export const DEFAULT_CATEGORIES: ReadonlyArray<{ name: string; kind: CategoryKind; icon: string }> =
  [
    // Income
    { name: "Salário", kind: "income", icon: "💰" },
    { name: "Renda extra", kind: "income", icon: "🪙" },
    { name: "Investimentos", kind: "income", icon: "📈" },
    { name: "Transferência recebida", kind: "income", icon: "⬇️" },
    { name: "Outras receitas", kind: "income", icon: "➕" },
    // Expense
    { name: "Mercado", kind: "expense", icon: "🛒" },
    { name: "Restaurante e delivery", kind: "expense", icon: "🍔" },
    { name: "Transporte", kind: "expense", icon: "🚗" },
    { name: "Moradia", kind: "expense", icon: "🏠" },
    { name: "Contas e serviços", kind: "expense", icon: "🧾" },
    { name: "Saúde", kind: "expense", icon: "💊" },
    { name: "Educação", kind: "expense", icon: "📚" },
    { name: "Lazer", kind: "expense", icon: "🎉" },
    { name: "Compras", kind: "expense", icon: "🛍️" },
    { name: "Assinaturas", kind: "expense", icon: "🔁" },
    { name: "Cartão de crédito", kind: "expense", icon: "💳" },
    { name: "Impostos e taxas", kind: "expense", icon: "🏛️" },
    { name: "Pix enviado", kind: "expense", icon: "⬆️" },
    { name: "Outras despesas", kind: "expense", icon: "➖" },
  ];

/** Idempotent: seeds the system categories only if none exist yet. */
export async function seedDefaultCategories(db: Db): Promise<number> {
  const existing = await db
    .select({ id: category.id })
    .from(category)
    .where(and(isNull(category.householdId), isNull(category.deletedAt)))
    .limit(1);
  if (existing.length > 0) return 0;

  const now = new Date();
  await db.insert(category).values(
    DEFAULT_CATEGORIES.map((c) => ({
      householdId: null,
      name: c.name,
      kind: c.kind,
      icon: c.icon,
      createdBy: SYSTEM_ACTOR_UUID,
      updatedBy: SYSTEM_ACTOR_UUID,
      createdAt: now,
      updatedAt: now,
    })),
  );
  return DEFAULT_CATEGORIES.length;
}
