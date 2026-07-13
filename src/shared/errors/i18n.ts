import enUS from "./i18n/en-US.json" with { type: "json" };
import esES from "./i18n/es-ES.json" with { type: "json" };
import ptBR from "./i18n/pt-BR.json" with { type: "json" };

export type Locale = "pt-BR" | "en-US" | "es-ES";
const DEFAULT_LOCALE: Locale = "pt-BR";

const bundles: Record<Locale, Record<string, string>> = {
  "pt-BR": ptBR,
  "en-US": enUS,
  "es-ES": esES,
};

// Fallback by primary subtag: pt-PT -> pt-BR, en-GB -> en-US, es-MX -> es-ES.
function normalizeLocale(tag: string): Locale {
  const primary = tag.trim().toLowerCase().split("-")[0];
  if (primary === "en") return "en-US";
  if (primary === "es") return "es-ES";
  return "pt-BR";
}

/** Pick a supported locale from an `Accept-Language` header value. */
export function pickLocale(acceptLanguage: string | undefined): Locale {
  if (!acceptLanguage) return DEFAULT_LOCALE;
  const first = acceptLanguage.split(",")[0];
  if (!first) return DEFAULT_LOCALE;
  return normalizeLocale(first.split(";")[0] ?? first);
}

/** Resolve the user-facing message for an error `code` in the given locale. */
export function resolveMessage(code: string, locale: Locale): string {
  return bundles[locale][code] ?? bundles[DEFAULT_LOCALE][code] ?? code;
}
