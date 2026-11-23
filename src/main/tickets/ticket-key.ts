import { DEFAULT_TICKET_PATTERN } from "../../shared/ticket-pattern";

export { DEFAULT_TICKET_PATTERN };

export function isValidTicketKey(key: string, pattern = DEFAULT_TICKET_PATTERN): boolean {
  return new RegExp(`^(?:${pattern})$`).test(key);
}

export function extractTicketKey(text: string, pattern = DEFAULT_TICKET_PATTERN): string | null {
  const m = new RegExp(`(?<![A-Za-z0-9])(?:${pattern})(?![0-9])`, "i").exec(text);
  return m ? m[0].toUpperCase() : null;
}

export { renderBranch } from "../../shared/branch";
