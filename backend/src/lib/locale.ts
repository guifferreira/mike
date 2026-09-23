// Deployment locale, read from MIKE_LOCALE. Unset means the default English
// behaviour; "pt-BR" (any case, surrounding whitespace ignored) turns on the
// Brazilian Portuguese prompt variants in chat and tabular review.

export function isPtBrLocale(): boolean {
  return (process.env.MIKE_LOCALE ?? "").trim().toLowerCase() === "pt-br";
}
