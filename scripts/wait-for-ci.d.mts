export interface WorkflowRun {
  id: number;
  run_number: number;
  run_attempt?: number;
  head_sha: string;
  head_branch: string | null;
  event: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  created_at: string;
}
export const APPEAR_TIMEOUT_MS: number;
export const MAX_WAIT_MS: number;
export const POLL_MS: number;
export function ciVerdict(input: { sha: string; runs: WorkflowRun[]; waitedMs: number; appearTimeoutMs?: number; maxWaitMs?: number }): { state: "pass" | "fail" | "wait"; message: string };
