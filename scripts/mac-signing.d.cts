export type Env = Record<string, string | undefined>;
export const SIGNING_SECRETS: string[];
export function macSigningMode(input: { env: Env; identity?: unknown }): { mode: "builder" | "ad-hoc"; problem?: string };
export function releaseSigningMode(input: { present: Record<string, boolean>; requireSigning: boolean }): { mode: "developer-id" | "ad-hoc" } | { error: string };
