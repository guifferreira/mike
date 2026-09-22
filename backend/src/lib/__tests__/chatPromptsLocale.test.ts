import { afterEach, describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../../modules/chat/engine/prompts";

const ORIGINAL = process.env.MIKE_LOCALE;

afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.MIKE_LOCALE;
    else process.env.MIKE_LOCALE = ORIGINAL;
});

describe("buildSystemPrompt locale guidance", () => {
    it("leaves the prompt unchanged when MIKE_LOCALE is unset", () => {
        delete process.env.MIKE_LOCALE;
        for (const prompt of [buildSystemPrompt(true), buildSystemPrompt(false)]) {
            expect(prompt).not.toContain("BRAZILIAN PRACTICE (pt-BR):");
        }
    });

    it("appends Brazilian guidance for pt-BR, case-insensitively", () => {
        for (const value of ["pt-BR", "PT-br", " pt-br "]) {
            process.env.MIKE_LOCALE = value;
            for (const prompt of [buildSystemPrompt(true), buildSystemPrompt(false)]) {
                expect(prompt).toContain("BRAZILIAN PRACTICE (pt-BR):");
                expect(prompt).toContain("Reply in Brazilian Portuguese");
                expect(prompt.trimEnd().endsWith("flag points that require the responsible lawyer's judgment.")).toBe(true);
            }
        }
    });

    it("ignores other locale values", () => {
        process.env.MIKE_LOCALE = "en-US";
        expect(buildSystemPrompt(true)).not.toContain("BRAZILIAN PRACTICE (pt-BR):");
    });
});
