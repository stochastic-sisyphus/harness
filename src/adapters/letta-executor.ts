// LettaAdapter — available as an executor adapter if you ever want Letta as a
// worker (i.e. a supervised agent that runs subtasks). It is NOT registered in
// createAdapters() by default because Letta now sits above the supervisor as
// the orchestrator (see src/orchestrator.ts). Add it back to createAdapters()
// if you want to route individual subtasks to Letta as a worker.

import { randomUUID } from "node:crypto"
import Letta from "@letta-ai/letta-client"
import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents.js"
import type {
  AssistantMessage,
  LettaResponse,
} from "@letta-ai/letta-client/resources/agents/messages.js"
import type {
  ExecutorAdapter,
  ExecutorCapabilities,
  RunInput,
  RunHandle,
  RunStatus,
  RunResult,
} from "../types.js"

interface RunRecord {
  agentId: string
  response: LettaResponse | null
  error: string | null
  done: boolean
  startedAt: number
}

export class LettaAdapter implements ExecutorAdapter {
  readonly id = "letta"
  private client: Letta
  private runs = new Map<string, RunRecord>()

  constructor() {
    const apiKey = process.env.LETTA_API_KEY
    const baseURL =
      process.env.LETTA_BASE_URL ?? "https://letta.schrodingers.lol"

    this.client = new Letta({
      apiKey,
      baseURL,
    })
  }

  async capabilities(): Promise<ExecutorCapabilities> {
    return {
      tools: ["read", "write", "shell", "edit"],
      supportsStreaming: false,
      supportsStructuredOutput: false,
      supportsSubtasks: true,
      sandboxKinds: ["none"],
    }
  }

  async run(input: RunInput): Promise<RunHandle> {
    const runId = randomUUID()

    // Fire-and-forget — poll() checks done flag
    this.executeAsync(runId, input).catch(() => {
      // error already captured inside executeAsync
    })

    return { runId }
  }

  private async executeAsync(runId: string, input: RunInput): Promise<void> {
    const record: RunRecord = {
      agentId: "",
      response: null,
      error: null,
      done: false,
      startedAt: Date.now(),
    }
    this.runs.set(runId, record)

    try {
      const agentName = `harness-task-${input.taskId}`
      const agentId = await this.resolveAgent(agentName)
      record.agentId = agentId

      const message = this.buildMessage(input)
      const response = await this.client.agents.messages.create(agentId, {
        messages: [{ role: "user", content: message }],
      })

      record.response = response as LettaResponse
    } catch (err) {
      record.error = err instanceof Error ? err.message : String(err)
    } finally {
      record.done = true
    }
  }

  async poll(runId: string): Promise<RunStatus> {
    const record = this.getRecord(runId)
    if (!record.done) return { state: "running" }
    return { state: record.error ? "failed" : "completed" }
  }

  async cancel(runId: string): Promise<void> {
    const record = this.getRecord(runId)
    // Letta processes messages synchronously from the client perspective;
    // we can't cancel a running HTTP call here, so just mark done.
    if (!record.done) {
      record.error = "cancelled"
      record.done = true
    }
  }

  async collect(runId: string): Promise<RunResult> {
    const record = this.getRecord(runId)
    if (!record.done) throw new Error(`Run ${runId} is still in progress`)

    const durationSec = Math.round((Date.now() - record.startedAt) / 1000)

    if (record.error) {
      return {
        status: "failed",
        summary: record.error,
        outputs: { raw: record.error },
        artifacts: [],
        proposedMemories: [],
        followups: [],
        diagnostics: { toolCalls: 0, durationSec },
      }
    }

    const messages = record.response?.messages ?? []

    const assistantText = messages
      .filter((m): m is AssistantMessage => m.message_type === "assistant_message")
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
      .join("\n")
      .trim()

    const toolCallCount = messages.filter(
      (m) => m.message_type === "tool_call_message",
    ).length

    const summary = assistantText || "No assistant response"

    this.runs.delete(runId)

    return {
      status: "completed",
      summary,
      outputs: {
        raw: assistantText,
        agentId: record.agentId,
        messageCount: messages.length,
      },
      artifacts: [],
      proposedMemories: [],
      followups: [],
      diagnostics: { toolCalls: toolCallCount, durationSec },
    }
  }

  /** Find an existing agent by name or create one. */
  private async resolveAgent(name: string): Promise<string> {
    const page = await this.client.agents.list({ name })
    // ArrayPage — iterate to find exact match
    for await (const agent of page) {
      const a = agent as AgentState
      if (a.name === name) return a.id
    }

    const created = await this.client.agents.create({ name }) as AgentState
    return created.id
  }

  private buildMessage(input: RunInput): string {
    const parts: string[] = []

    parts.push(`OBJECTIVE: ${input.workerSpec.objective}`)

    if (input.workerSpec.instructions.length > 0) {
      parts.push(
        `\nINSTRUCTIONS:\n${input.workerSpec.instructions.map((i) => `- ${i}`).join("\n")}`,
      )
    }

    if (input.workerSpec.completionCriteria.length > 0) {
      parts.push(
        `\nCOMPLETION CRITERIA:\n${input.workerSpec.completionCriteria.map((c) => `- ${c}`).join("\n")}`,
      )
    }

    if (input.context.taskSummary) {
      parts.push(`\nCONTEXT:\n${input.context.taskSummary}`)
    }

    if (input.context.relevantMemories.length > 0) {
      const mems = input.context.relevantMemories
        .map((m) => `- [${m.relevance.toFixed(2)}] ${m.text}`)
        .join("\n")
      parts.push(`\nRELEVANT MEMORIES:\n${mems}`)
    }

    return parts.join("\n")
  }

  private getRecord(runId: string): RunRecord {
    const record = this.runs.get(runId)
    if (!record) throw new Error(`Unknown run: ${runId}`)
    return record
  }
}
