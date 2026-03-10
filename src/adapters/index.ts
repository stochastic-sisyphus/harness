import type { ExecutorAdapter } from "../types.js"
import { PiAdapter } from "./pi.js"
import { OpenCodeAdapter } from "./opencode.js"
import { OpenHandsAdapter } from "./openhands.js"
import { ClaudeAdapter } from "./claude.js"

export { PiAdapter, OpenCodeAdapter, OpenHandsAdapter, ClaudeAdapter }

export function createAdapters(): Map<string, ExecutorAdapter> {
  const adapters = new Map<string, ExecutorAdapter>()

  const pi = new PiAdapter()
  adapters.set(pi.id, pi)

  const opencode = new OpenCodeAdapter()
  adapters.set(opencode.id, opencode)

  const openhands = new OpenHandsAdapter()
  adapters.set(openhands.id, openhands)

  const claude = new ClaudeAdapter()
  adapters.set(claude.id, claude)

  return adapters
}
