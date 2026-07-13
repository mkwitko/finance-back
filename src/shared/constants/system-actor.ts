// The SYSTEM actor stamps `created_by`/`updated_by` on rows written outside a user
// request (baseline seed, out-of-band provisioning, and first-access Google upsert,
// where there is no authenticated actor yet). Mirrored as a literal in the baseline
// migration seed — keep in sync.
export const SYSTEM_ACTOR_UUID = "00000000-0000-0000-0000-000000000001";
