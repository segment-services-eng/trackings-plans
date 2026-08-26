export interface ToolResultError {
  code:
    | "DIRTY_TREE"
    | "SEGMENT_API"
    | "GIT"
    | "VALIDATION"
    | "CONFIG"
    | "NOT_FOUND"
    | "PROD_WRITE_BLOCKED"
    | "GH_CLI"
    | "GITHUB_API"
    | "UNKNOWN";
  message: string;
  details?: unknown;
  remediation?: string;
}

export type ToolResult<T> =
  | { ok: true; data: T; warnings?: string[] }
  | { ok: false; error: ToolResultError };

export function ok<T>(data: T, warnings?: string[]): ToolResult<T> {
  return warnings ? { ok: true, data, warnings } : { ok: true, data };
}

export function err(
  code: ToolResultError["code"],
  message: string,
  extras?: { details?: unknown; remediation?: string },
): ToolResult<never> {
  return { ok: false, error: { code, message, ...extras } };
}
