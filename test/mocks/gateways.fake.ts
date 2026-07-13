import type { DeepseekGateway } from "../../src/gateways/deepseek/deepseek.gateway.js";
import type { GoogleIdentity } from "../../src/gateways/google/google.gateway.js";
import type { Gateways } from "../../src/types/fastify.js";

// Complete set of fake gateways. `opts.gateways` replaces the whole set at once
// (no partial merge), so buildFakeGateways returns every gateway; override only what
// a test needs. The fake google gateway derives the identity from the idToken value:
// idToken "alice" -> sub "google-alice", email "alice@example.com".
export function buildFakeGateways(overrides: Partial<Gateways> = {}): Gateways {
  return {
    google: {
      verifyIdToken: async (idToken: string): Promise<GoogleIdentity> => ({
        sub: `google-${idToken}`,
        email: `${idToken}@example.com`,
        name: idToken,
        picture: null,
        emailVerified: true,
      }),
    },
    deepseek: fakeDeepseek(),
    ...overrides,
  };
}

// Deterministic fake: assigns each item the FIRST category matching its kind
// (income for "in", expense for "out") at 90% confidence. Lets import tests assert
// AI categorization without a network call. extractReceipt returns nothing.
export function fakeDeepseek(): DeepseekGateway {
  return {
    enabled: true,
    async categorizeTransactions(req) {
      return req.items.map((item) => {
        const wantKind = item.direction === "in" ? "income" : "expense";
        const match = req.categories.find((c) => c.kind === wantKind);
        return { index: item.index, category: match?.name ?? null, confidence: 90 };
      });
    },
    async extractReceipt() {
      return [];
    },
    async generateInsights(input) {
      return [
        {
          kind: "summary",
          severity: input.netCurrentCents >= 0 ? "positive" : "warning",
          title: "Resumo do período",
          body: `Saldo do período: ${input.netCurrentCents} centavos.`,
          recommendation: null,
        },
        {
          kind: "advice",
          severity: "info",
          title: "Dica",
          body: "Considere revisar a maior categoria de gasto.",
          recommendation: "Defina um limite mensal para a categoria de maior gasto.",
        },
      ];
    },
  };
}
