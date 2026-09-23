import { afterEach, describe, expect, it, vi } from "vitest";

// Only the pure prompt helpers are under test; keep the LLM and database
// layers out of the import graph.
vi.mock("../../lib/llm", () => ({ completeText: vi.fn() }));
vi.mock("../user/user.service", () => ({ getUserModelSettings: vi.fn() }));
vi.mock("../../lib/supabase", () => ({}));
vi.mock("./tabular.shared", () => ({ statusFailure: vi.fn() }));
import {
  emptySummaryLabel,
  formatPromptSuffix,
  notFoundLabel,
} from "./tabular.prompt";

const original = process.env.MIKE_LOCALE;

afterEach(() => {
  if (original === undefined) delete process.env.MIKE_LOCALE;
  else process.env.MIKE_LOCALE = original;
});

describe("tabular prompt locale", () => {
  it("keeps the English wording when MIKE_LOCALE is unset", () => {
    delete process.env.MIKE_LOCALE;
    expect(formatPromptSuffix("yes_no")).toContain("[[Yes]] or [[No]]");
    expect(formatPromptSuffix("date")).toContain("1 January 2024");
    expect(formatPromptSuffix("monetary_amount")).toContain("$1,234.56");
    expect(notFoundLabel()).toBe("Not Found");
    expect(emptySummaryLabel()).toBe("Not addressed");
  });

  it("switches Yes/No, dates, amounts and not-found to pt-BR", () => {
    process.env.MIKE_LOCALE = " PT-br ";
    expect(formatPromptSuffix("yes_no")).toContain("[[Sim]] or [[Não]]");
    expect(formatPromptSuffix("yes_no")).not.toContain("[[Yes]]");
    expect(formatPromptSuffix("date")).toContain("15 de março de 2024");
    expect(formatPromptSuffix("monetary_amount")).toContain("R$ 1.234.567,89");
    expect(notFoundLabel()).toBe("Não previsto");
    expect(emptySummaryLabel()).toBe("Não previsto");
  });

  it("leaves formats without a pt-BR variant unchanged", () => {
    delete process.env.MIKE_LOCALE;
    const englishTag = formatPromptSuffix("tag", ["Alto", "Baixo"]);
    const englishList = formatPromptSuffix("bulleted_list");
    process.env.MIKE_LOCALE = "pt-BR";
    expect(formatPromptSuffix("tag", ["Alto", "Baixo"])).toBe(englishTag);
    expect(formatPromptSuffix("bulleted_list")).toBe(englishList);
    expect(formatPromptSuffix("text")).toBe("");
  });
});
