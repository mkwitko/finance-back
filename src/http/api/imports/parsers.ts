// Deterministic statement parsers. Both OFX and CSV normalize to `NormalizedRow`:
// amount is a POSITIVE integer in cents, with the sign carried by `direction`.

export type NormalizedRow = {
  amountCents: number;
  direction: "in" | "out";
  occurredAt: Date;
  description: string;
  rawRef: string | null;
};

function toCents(value: number): number {
  return Math.round(Math.abs(value) * 100);
}

// --- OFX (Money 1.x SGML and 2.x XML both work with tag-prefix extraction) ---

function ofxField(block: string, tag: string): string | null {
  // Matches `<TAG>value` up to the next tag or line end (works with/without closers).
  const m = block.match(new RegExp(`<${tag}>([^<\r\n]*)`, "i"));
  return m?.[1]?.trim() ?? null;
}

function parseOfxDate(raw: string | null): Date {
  // DTPOSTED like `20240115` or `20240115103000[-3:BRT]` — first 8 digits are the date.
  const digits = (raw ?? "").replace(/[^0-9]/g, "");
  if (digits.length < 8) return new Date(0);
  const year = Number(digits.slice(0, 4));
  const month = Number(digits.slice(4, 6));
  const day = Number(digits.slice(6, 8));
  return new Date(Date.UTC(year, month - 1, day));
}

export function parseOfx(content: string): NormalizedRow[] {
  const blocks = content.split(/<STMTTRN>/i).slice(1);
  const rows: NormalizedRow[] = [];
  for (const block of blocks) {
    const amountRaw = ofxField(block, "TRNAMT");
    if (amountRaw === null) continue;
    const amount = Number(amountRaw.replace(",", "."));
    if (Number.isNaN(amount)) continue;
    const name = ofxField(block, "NAME");
    const memo = ofxField(block, "MEMO");
    rows.push({
      amountCents: toCents(amount),
      direction: amount < 0 ? "out" : "in",
      occurredAt: parseOfxDate(ofxField(block, "DTPOSTED")),
      description: (name || memo || "Sem descrição").slice(0, 512),
      rawRef: ofxField(block, "FITID"),
    });
  }
  return rows;
}

// --- CSV (headered; flexible column + locale detection) ---

function splitCsvLine(line: string, delimiter: string): string[] {
  return line.split(delimiter).map((c) => c.trim().replace(/^"|"$/g, ""));
}

function parseAmount(raw: string): number {
  const cleaned = raw.replace(/[^\d.,-]/g, "");
  // BR locale "1.234,56" -> "1234.56"; plain "1234.56" left intact.
  const normalized =
    cleaned.includes(",") && cleaned.lastIndexOf(",") > cleaned.lastIndexOf(".")
      ? cleaned.replace(/\./g, "").replace(",", ".")
      : cleaned.replace(/,/g, "");
  return Number(normalized);
}

function parseCsvDate(raw: string): Date {
  const s = raw.trim();
  // ISO first (YYYY-MM-DD), then BR DD/MM/YYYY.
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])));
  const br = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (br) return new Date(Date.UTC(Number(br[3]), Number(br[2]) - 1, Number(br[1])));
  return new Date(0);
}

function findColumn(headers: string[], keywords: string[]): number {
  return headers.findIndex((h) => keywords.some((k) => h.toLowerCase().includes(k)));
}

export function parseCsv(content: string): NormalizedRow[] {
  const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const delimiter = (lines[0]?.includes(";") ?? false) ? ";" : ",";
  const headers = splitCsvLine(lines[0] as string, delimiter);

  const dateCol = findColumn(headers, ["date", "data"]);
  const descCol = findColumn(headers, [
    "desc",
    "hist",
    "memo",
    "lançamento",
    "lancamento",
    "title",
  ]);
  const amountCol = findColumn(headers, ["amount", "valor", "value"]);
  if (dateCol < 0 || amountCol < 0) return [];

  const rows: NormalizedRow[] = [];
  for (const line of lines.slice(1)) {
    const cols = splitCsvLine(line, delimiter);
    const amount = parseAmount(cols[amountCol] ?? "");
    if (Number.isNaN(amount) || amount === 0) continue;
    rows.push({
      amountCents: toCents(amount),
      direction: amount < 0 ? "out" : "in",
      occurredAt: parseCsvDate(cols[dateCol] ?? ""),
      description: (descCol >= 0 ? cols[descCol] : "") || "Sem descrição",
      rawRef: null,
    });
  }
  return rows;
}
