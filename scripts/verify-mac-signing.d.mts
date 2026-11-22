export interface CodesignDisplay {
  signed: boolean;
  adhoc: boolean;
  authority?: string;
  teamId?: string;
  runtime: boolean;
  timestamp: boolean;
}
export function isMachOHeader(buf: Buffer): boolean;
export function parseCodesignDisplay(text: string): CodesignDisplay;
export function signatureProblems(file: string, sig: CodesignDisplay, mode: "ad-hoc" | "developer-id", teamId: string | undefined): string[];
export function gatekeeperVerdict(status: number | null, output: string): "notarized" | "disabled" | "rejected";
export function verifyMacSigning(distDir: string, mode: "ad-hoc" | "developer-id"): string[];
