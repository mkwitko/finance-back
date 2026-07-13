import { z } from "zod/v4";
import { INSIGHT_KINDS, INSIGHT_SEVERITIES } from "../../../infra/db/tables/insights/insight.table.js";

export const InsightView = z.object({
  id: z.uuid(),
  kind: z.enum(INSIGHT_KINDS),
  severity: z.enum(INSIGHT_SEVERITIES),
  title: z.string(),
  body: z.string(),
  recommendation: z.string().nullable(),
  periodStart: z.string(),
  periodEnd: z.string(),
  generatedAt: z.string(),
});
export const ListInsightsResponse = z.object({ insights: z.array(InsightView) });
