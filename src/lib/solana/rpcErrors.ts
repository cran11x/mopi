/** True for an RPC refusing access (HTTP 401/403, "Access forbidden"). */
export function isRpcForbidden(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /\b40[13]\b|Access forbidden|Unauthorized|forbidden/i.test(msg)
}
