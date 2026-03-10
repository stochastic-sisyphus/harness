import { Langfuse } from 'langfuse'
import type { LangfuseTraceClient, LangfuseSpanClient } from 'langfuse'

// ── Client init ────────────────────────────────────────────

let client: Langfuse | null = null

function getClient(): Langfuse | null {
  if (client !== null) return client

  const secretKey = process.env.LANGFUSE_SECRET_KEY
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY
  const host = process.env.LANGFUSE_HOST

  if (!secretKey || !publicKey || !host) {
    return null
  }

  client = new Langfuse({ secretKey, publicKey, baseUrl: host })
  return client
}

// ── Exported API ───────────────────────────────────────────

export function createTrace(
  name: string,
  metadata?: Record<string, unknown>,
): LangfuseTraceClient | null {
  const lf = getClient()
  if (!lf) return null
  return lf.trace({ name, metadata })
}

export function createSpan(
  trace: LangfuseTraceClient | null,
  name: string,
  input?: unknown,
): LangfuseSpanClient | null {
  if (!trace) return null
  return trace.span({ name, input })
}

export function endSpan(
  span: LangfuseSpanClient | null,
  output?: unknown,
  level?: 'DEFAULT' | 'DEBUG' | 'WARNING' | 'ERROR',
): void {
  if (!span) return
  span.end({ output, level })
}

export async function flushTraces(): Promise<void> {
  const lf = getClient()
  if (!lf) return
  await lf.flushAsync()
}
