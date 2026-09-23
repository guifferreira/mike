import { describe, expect, it } from "vitest";
import { getPillClass } from "./pillUtils";
import type { ColumnConfig } from "../shared/types";

const yesNo = { format: "yes_no" } as ColumnConfig;

describe("getPillClass yes/no", () => {
  it("colors English answers", () => {
    expect(getPillClass("Yes", yesNo)).toContain("green");
    expect(getPillClass("No", yesNo)).toContain("red");
  });

  it("colors Brazilian Portuguese answers the same way", () => {
    expect(getPillClass("Sim", yesNo)).toContain("green");
    expect(getPillClass("Não", yesNo)).toContain("red");
    expect(getPillClass("nao", yesNo)).toContain("red");
  });

  it("keeps anything else neutral", () => {
    expect(getPillClass("Talvez", yesNo)).toContain("gray");
  });
});
