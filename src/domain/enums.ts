export const ACCOUNT_KINDS = ["cash", "checking", "credit", "investment", "prepaid"] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];

export const CATEGORY_KINDS = ["income", "expense"] as const;
export type CategoryKind = (typeof CATEGORY_KINDS)[number];

export const GOAL_TYPES = [
  "house",
  "car",
  "emergency",
  "retirement",
  "trip",
  "debt",
  "independence",
] as const;
export type GoalType = (typeof GOAL_TYPES)[number];

export const HOUSEHOLD_TYPES = ["individual", "family", "shared", "kids"] as const;
export type HouseholdType = (typeof HOUSEHOLD_TYPES)[number];

export const MEMBERSHIP_ROLES = ["owner", "adult", "teen", "child", "viewer"] as const;
export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];
export const ROLE_RANK: Record<MembershipRole, number> = {
  owner: 4,
  adult: 3,
  teen: 2,
  child: 1,
  viewer: 0,
};

export const IMPORT_SOURCES = ["ofx", "csv", "receipt"] as const;
export type ImportSource = (typeof IMPORT_SOURCES)[number];
export const IMPORT_STATUSES = ["pending", "processing", "completed", "failed"] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];

export const INSIGHT_KINDS = ["spending_alert", "summary", "trend", "advice"] as const;
export type InsightKind = (typeof INSIGHT_KINDS)[number];
export const INSIGHT_SEVERITIES = ["info", "warning", "positive"] as const;
export type InsightSeverity = (typeof INSIGHT_SEVERITIES)[number];

export const TRANSACTION_DIRECTIONS = ["in", "out"] as const;
export type TransactionDirection = (typeof TRANSACTION_DIRECTIONS)[number];
export const TRANSACTION_SOURCES = ["manual", "import", "receipt"] as const;
export type TransactionSource = (typeof TRANSACTION_SOURCES)[number];
