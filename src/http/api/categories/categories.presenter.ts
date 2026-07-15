import type { Category } from "./categories.repository.js";
import type { CategoryView } from "./categories.schema.js";

export function present(c: Category): CategoryView {
  return {
    id: c.uuid,
    name: c.name,
    kind: c.kind,
    icon: c.icon,
    system: c.system,
    createdAt: c.createdAt,
  };
}
