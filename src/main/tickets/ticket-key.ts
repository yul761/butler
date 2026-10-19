export const DEFAULT_TICKET_PATTERN = "[A-Z][A-Z0-9]+-\\d+";

export function isValidTicketKey(key: string, pattern = DEFAULT_TICKET_PATTERN): boolean {
  return new RegExp(`^(?:${pattern})$`).test(key);
}

export function extractTicketKey(text: string, pattern = DEFAULT_TICKET_PATTERN): string | null {
  const m = new RegExp(`(?<![A-Za-z0-9])(?:${pattern})(?![0-9])`, "i").exec(text);
  return m ? m[0].toUpperCase() : null;
}

export function renderBranch(template: string, key: string): string {
  return template.replaceAll("{key}", key);
}
