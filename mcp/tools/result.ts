export type ToolResult<T> =
  | { ok: true; data: T; warnings?: string[] }
  | {
      ok: false;
      error: {
        code:
          | "DIRTY_TREE"
          | "SEGMENT_API"
          | "GIT"
          | "VALIDATION"
          | "CONFIG"
          | "NOT_FOUND"
          | "PROD_WRITE_BLOCKED"
          | "UNKNOWN";
        message: string;
        details?: unknown;
        remediation?: string;
      };
    };

export function ok<T>(data: T, warnings?: string[]): ToolResult<T> {
  return warnings ? { ok: true, data, warnings } : { ok: true, data };
}

export function err(
  code: Extract<ToolResult<unknown>, { ok: false }>["error"]["code"],
  message: string,
  extras?: { details?: unknown; remediation?: string },
): ToolResult<never> {
  return { ok: false, error: { code, message, ...extras } };
}
