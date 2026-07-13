// Aggregated schema for the Drizzle client. Also the target of the `*.table.ts`
// glob in drizzle.config.ts.

export { account } from "./tables/accounts/account.table.js";
export { refreshToken } from "./tables/auth/refresh-token.table.js";
export { category } from "./tables/categories/category.table.js";
export { goal } from "./tables/goals/goal.table.js";
export { household } from "./tables/households/household.table.js";
export { membership } from "./tables/households/membership.table.js";
export { importBatch } from "./tables/imports/import-batch.table.js";
export { transaction } from "./tables/transactions/transaction.table.js";
export { user } from "./tables/users/user.table.js";
