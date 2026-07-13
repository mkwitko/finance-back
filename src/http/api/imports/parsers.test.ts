import { describe, expect, it } from "vitest";
import { parseCsv, parseOfx } from "./parsers.js";

const OFX = `<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20240115<TRNAMT>-45.90<FITID>TX1<NAME>IFOOD DELIVERY</STMTTRN>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20240116<TRNAMT>3500.00<FITID>TX2<NAME>SALARIO EMPRESA</STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

describe("parseOfx", () => {
  it("extracts transactions with sign-derived direction and cents", () => {
    const rows = parseOfx(OFX);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      amountCents: 4590,
      direction: "out",
      description: "IFOOD DELIVERY",
      rawRef: "TX1",
    });
    expect(rows[0]?.occurredAt.toISOString()).toBe("2024-01-15T00:00:00.000Z");
    expect(rows[1]).toMatchObject({ amountCents: 350000, direction: "in", rawRef: "TX2" });
  });
});

describe("parseCsv", () => {
  it("parses headered CSV with BR locale amounts and dates", () => {
    const csv = [
      "data;descricao;valor",
      "15/01/2024;Mercado Extra;-1.234,56",
      "16/01/2024;Salario;3.500,00",
    ].join("\n");
    const rows = parseCsv(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ amountCents: 123456, direction: "out" });
    expect(rows[0]?.occurredAt.toISOString()).toBe("2024-01-15T00:00:00.000Z");
    expect(rows[1]).toMatchObject({ amountCents: 350000, direction: "in" });
  });

  it("parses ISO dates and comma delimiter", () => {
    const csv = ["date,description,amount", "2024-02-01,Uber,-19.90"].join("\n");
    const rows = parseCsv(csv);
    expect(rows[0]).toMatchObject({ amountCents: 1990, direction: "out", description: "Uber" });
  });
});
