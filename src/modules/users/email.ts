/**
 * The uniqueness/lookup key for an email address: trimmed and lowercased. No
 * provider-specific rewriting (Gmail dots, `+tags`) – those are distinct mailboxes elsewhere.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
