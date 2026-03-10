import { randomUUID } from "node:crypto"
import Letta from "@letta-ai/letta-client"
import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents.js"
import type {
  AssistantMessage,
  LettaResponse,
} from "@letta-ai/letta-client/resources/agents/messages.js"
import { Db } from "./db.js"
import { Supervisor } from "./supervisor.js"
import type { Task, Memory, Artifact, ProposedTask, RunResult } from "./types.js"

const ORCHESTRATOR_AGENT_NAME = "harness-orchestrator"

// Executor descriptions sent to Letta so it can make informed routing decisions.
const EXECUTOR_DESCRIPTIONS: Record<string, string> = {
  pi: "Fast, minimal, focused coding tasks — short-lived file edits, quick scripting, low-overhead",
  opencode: "LSP-aware refactoring, renaming, type fixes, language-server-powered navigation",
  openhands: "Autonomous multi-step tasks requiring a sandbox: installs, running tests, browser automation, containers",
  claude: "Conversational reasoning, multi-agent coordination, spawning subagents, complex planning",
}

interface SubtaskPlan {
  title: string
  objective: string
  executor: string
  reason: string
  priority: number
}

function now(): string {
  return new Date().toISOString()
}

export class LettaOrchestrator {
  private db: Db
  private supervisor: Supervisor
  private client: Letta

  constructor(db: Db, supervisor: Supervisor) {
    this.db = db
    this.supervisor = supervisor

    const baseURL = process.env.LETTA_BASE_URL ?? "https://letta.schrodingers.lol"
    this.client = new Letta({ baseURL })
  }

  async orchestrate(taskId: string): Promise<RunResult> {
    const task = this.db.getTask(taskId)
    if (!task) throw new Error(`Task not found: ${taskId}`)

    this.db.updateTaskStatus(taskId, "running")

    try {
      // Gather context the same way Supervisor does
      const memories = this.retrieveMemories(task)
      const artifacts = this.db.listArtifactsByTask(taskId)

      // Get or create the persistent orchestrator agent
      const agentId = await this.resolveOrchestratorAgent()

      // Build the planning prompt and send it to Letta
      const message = this.buildPlanningMessage(task, memories, artifacts)
      const response = await this.client.agents.messages.create(agentId, {
        messages: [{ role: "user", content: message }],
      }) as LettaResponse

      // Extract Letta's assistant reply
      const replyText = (response.messages ?? [])
        .filter((m): m is AssistantMessage => m.message_type === "assistant_message")
        .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
        .join("\n")
        .trim()

      if (!replyText) {
        throw new Error("Letta orchestrator returned no plan")
      }

      // Parse subtasks from the reply
      const subtasks = this.parsePlan(replyText)

      if (subtasks.length === 0) {
        throw new Error("Letta returned no subtasks in its plan")
      }

      // Persist a plan artifact
      this.db.createArtifact({
        id: randomUUID(),
        taskId,
        kind: "plan",
        uri: `letta://orchestrator/${agentId}`,
        summary: `Orchestrator plan: ${subtasks.length} subtask(s)`,
        metadata: { subtasks },
        createdAt: now(),
      })

      // Create and run each subtask through the Supervisor
      const subtaskResults: RunResult[] = []

      for (const sub of subtasks) {
        const subtaskId = randomUUID()
        const ts = now()

        this.db.createTask({
          id: subtaskId,
          parentTaskId: taskId,
          title: sub.title,
          objective: sub.objective,
          status: "queued",
          priority: sub.priority,
          createdAt: ts,
          updatedAt: ts,
        })

        // Temporarily override executor selection by injecting the executor hint
        // into the objective — Supervisor.selectExecutor uses keyword matching.
        // We stamp a comment that won't confuse the actual agent but will match
        // the routing regexes where possible. For explicit routing we call
        // supervisor.runTask and rely on the hinted objective.
        const hintedTask = this.db.getTask(subtaskId)
        if (hintedTask && sub.executor && sub.executor !== "pi") {
          // Patch the objective with a routing hint so selectExecutor picks it up
          const patched = `${sub.objective} [executor:${sub.executor}]`
          this.db.updateTask({
            id: subtaskId,
            title: hintedTask.title,
            objective: patched,
            status: hintedTask.status,
            priority: hintedTask.priority,
          })
        }

        await this.supervisor.runTask(subtaskId)

        const subtaskEvents = this.db.listEventsByTask(subtaskId)
        const completion = subtaskEvents.find((e) => e.type === "run_completed")
        const subtaskArtifacts = this.db.listArtifactsByTask(subtaskId)

        subtaskResults.push({
          status: completion?.payload?.status as RunResult["status"] ?? "failed",
          summary: String(completion?.payload?.summary ?? ""),
          outputs: { subtaskId, executor: sub.executor },
          artifacts: subtaskArtifacts.map((a) => ({
            artifactId: a.id,
            kind: a.kind,
            uri: a.uri,
            summary: a.summary,
          })),
          proposedMemories: [],
          followups: [],
          diagnostics: { toolCalls: 0, durationSec: 0 },
        })
      }

      const allCompleted = subtaskResults.every((r) => r.status === "completed")
      const finalStatus: RunResult["status"] = allCompleted ? "completed" : "failed"

      const summaryLines = subtaskResults.map((r, i) =>
        `[${subtasks[i]?.executor ?? "?"}] ${subtasks[i]?.title ?? "?"}: ${r.status} — ${r.summary.slice(0, 120)}`
      )

      const finalResult: RunResult = {
        status: finalStatus,
        summary: summaryLines.join("\n"),
        outputs: { subtaskCount: subtasks.length, subtaskResults },
        artifacts: subtaskResults.flatMap((r) => r.artifacts),
        proposedMemories: [],
        followups: [],
        diagnostics: {
          toolCalls: 0,
          durationSec: 0,
        },
      }

      this.db.createEvent({
        id: randomUUID(),
        taskId,
        type: "orchestration_completed",
        payload: {
          status: finalResult.status,
          subtaskCount: subtasks.length,
          summary: finalResult.summary,
        },
        createdAt: now(),
      })

      this.db.updateTaskStatus(taskId, finalStatus)
      return finalResult
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.db.createEvent({
        id: randomUUID(),
        taskId,
        type: "error",
        payload: { message },
        createdAt: now(),
      })
      this.db.updateTaskStatus(taskId, "failed")

      return {
        status: "failed",
        summary: message,
        outputs: { error: message },
        artifacts: [],
        proposedMemories: [],
        followups: [],
        diagnostics: { toolCalls: 0, durationSec: 0 },
      }
    }
  }

  // ── Letta agent lifecycle ──────────────────────────────────

  private async resolveOrchestratorAgent(): Promise<string> {
    const page = await this.client.agents.list({ name: ORCHESTRATOR_AGENT_NAME })
    for await (const agent of page) {
      const a = agent as AgentState
      if (a.name === ORCHESTRATOR_AGENT_NAME) return a.id
    }
    const created = await this.client.agents.create({
      name: ORCHESTRATOR_AGENT_NAME,
    }) as AgentState
    return created.id
  }

  // ── Planning message ───────────────────────────────────────

  private buildPlanningMessage(
    task: Task,
    memories: Memory[],
    artifacts: Artifact[],
  ): string {
    const parts: string[] = []

    parts.push("You are the orchestrator for the Harness autonomous agent system.")
    parts.push("Your job is to decompose the task below into ordered subtasks and assign each to the best executor.")
    parts.push("")

    parts.push(`TASK OBJECTIVE:\n${task.objective}`)

    if (memories.length > 0) {
      const memLines = memories
        .slice(0, 20)
        .map((m) => `- [${m.confidence.toFixed(2)}] ${m.text}`)
        .join("\n")
      parts.push(`\nRELEVANT MEMORIES:\n${memLines}`)
    }

    if (artifacts.length > 0) {
      const artLines = artifacts
        .map((a) => `- ${a.kind}: ${a.summary} (${a.uri})`)
        .join("\n")
      parts.push(`\nPRIOR ARTIFACTS:\n${artLines}`)
    }

    parts.push("\nAVAILABLE EXECUTORS:")
    for (const [id, desc] of Object.entries(EXECUTOR_DESCRIPTIONS)) {
      parts.push(`- ${id}: ${desc}`)
    }

    parts.push(`
RESPONSE FORMAT — reply with ONLY a JSON array, nothing else:
[
  {
    "title": "short subtask title",
    "objective": "full objective for the executor",
    "executor": "pi | opencode | openhands | claude",
    "reason": "why this executor",
    "priority": 0
  }
]

Order the subtasks so dependencies come first. Use priority 0 for normal, higher numbers for more important.`)

    return parts.join("\n")
  }

  // ── Plan parsing ───────────────────────────────────────────

  private parsePlan(raw: string): SubtaskPlan[] {
    // Strip any markdown code fences
    const cleaned = raw
      .replace(/^```(?:json)?\s*/im, "")
      .replace(/\s*```$/im, "")
      .trim()

    // Find the first JSON array in the response
    const arrayStart = cleaned.indexOf("[")
    const arrayEnd = cleaned.lastIndexOf("]")

    if (arrayStart === -1 || arrayEnd === -1) {
      throw new Error(`Letta plan did not contain a JSON array. Raw reply:\n${raw.slice(0, 500)}`)
    }

    const jsonSlice = cleaned.slice(arrayStart, arrayEnd + 1)

    let parsed: unknown
    try {
      parsed = JSON.parse(jsonSlice)
    } catch (e) {
      throw new Error(`Failed to parse Letta plan JSON: ${e instanceof Error ? e.message : String(e)}\nRaw:\n${jsonSlice.slice(0, 500)}`)
    }

    if (!Array.isArray(parsed)) {
      throw new Error("Letta plan JSON was not an array")
    }

    return parsed.map((item, i) => {
      if (typeof item !== "object" || item === null) {
        throw new Error(`Subtask at index ${i} is not an object`)
      }
      const obj = item as Record<string, unknown>
      return {
        title: String(obj.title ?? `Subtask ${i + 1}`),
        objective: String(obj.objective ?? ""),
        executor: String(obj.executor ?? "pi"),
        reason: String(obj.reason ?? ""),
        priority: typeof obj.priority === "number" ? obj.priority : 0,
      }
    })
  }

  // ── Memory retrieval (mirrors Supervisor logic) ────────────

  private retrieveMemories(task: Task): Memory[] {
    const all: Memory[] = []
    const kinds = ["semantic", "procedural", "episodic"] as const
    const scopes = ["task", "repo", "global"] as const

    for (const kind of kinds) {
      for (const scope of scopes) {
        all.push(...this.db.listMemories(kind, scope))
      }
    }

    const lineageIds = this.getLineageIds(task)

    const filtered = all.filter((m) => {
      if (m.scope === "task") {
        return m.sourceTaskId != null && lineageIds.has(m.sourceTaskId)
      }
      return true
    })

    filtered.sort((a, b) => {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence
      return b.freshness - a.freshness
    })

    return filtered
  }

  private getLineageIds(task: Task): Set<string> {
    const ids = new Set<string>()
    let current: Task | undefined = task
    while (current) {
      ids.add(current.id)
      current = current.parentTaskId
        ? this.db.getTask(current.parentTaskId)
        : undefined
    }
    return ids
  }
}
