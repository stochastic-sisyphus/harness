import type {
  Task,
  RunInput,
  RunResult,
  ExecutorAdapter,
  Memory,
  ProposedTask,
  ProposedMemory,
  Artifact,
  ArtifactRef,
  MemoryRef,
  AttemptRef,
  OutputContract,
  WorkerSpec,
  WorkspaceSpec,
  RunLimits,
} from './types.js'
import { Db } from './db.js'
import { Validator, type ValidationResult } from './validator.js'
import { createTrace, createSpan, endSpan, flushTraces } from './observability.js'

function uuid(): string {
  return crypto.randomUUID()
}

function now(): string {
  return new Date().toISOString()
}

const POLL_INTERVAL_MS = 2000

export class Supervisor {
  private executors: Map<string, ExecutorAdapter>
  private db: Db
  private validator: Validator

  constructor(
    db: Db,
    executors: Map<string, ExecutorAdapter>,
    validator: Validator,
  ) {
    this.db = db
    this.executors = executors
    this.validator = validator
  }

  // ── Main loop ──────────────────────────────────────────────

  async runTask(taskId: string): Promise<void> {
    const task = this.db.getTask(taskId)
    if (!task) throw new Error(`Task not found: ${taskId}`)

    this.db.updateTaskStatus(taskId, 'running')

    const trace = createTrace('runTask', { taskId, title: task.title, objective: task.objective })

    try {
      // 1-3: Gather context, build input
      const memoriesSpan = createSpan(trace, 'retrieveMemories', { taskId })
      const memories = this.retrieveMemories(task)
      endSpan(memoriesSpan, { count: memories.length })

      const artifacts = this.db.listArtifactsByTask(taskId)
      const priorAttempts = this.getPriorAttempts(task)

      const buildSpan = createSpan(trace, 'buildRunInput', { taskId, memoriesCount: memories.length, artifactsCount: artifacts.length })
      const input = this.buildRunInput(task, memories, artifacts, priorAttempts)
      endSpan(buildSpan, { taskId: input.taskId })

      // 4: Execute
      const executor = this.selectExecutor(task)
      const runSpan = createSpan(trace, 'adapter.run', { executorId: executor.id, input })
      const handle = await executor.run(input)

      // Poll until done
      let status = await executor.poll(handle.runId)
      while (status.state === 'running') {
        await sleep(POLL_INTERVAL_MS)
        status = await executor.poll(handle.runId)
      }

      // 5: Collect result
      const result = await executor.collect(handle.runId)
      endSpan(runSpan, { runId: handle.runId, status: result.status })

      // 6: Validate against contract
      const validateSpan = createSpan(trace, 'validator.validate', { runId: handle.runId })
      const validation = this.validateResult(task, result, input.contract)
      endSpan(validateSpan, { valid: validation.valid, errors: validation.errors }, validation.valid ? 'DEFAULT' : 'WARNING')

      if (!validation.valid) {
        this.persistEvent(taskId, handle.runId, 'validation_failed', {
          errors: validation.errors,
        })
        this.db.updateTaskStatus(taskId, 'failed')
        return
      }

      // 7-8: Process outputs
      const processSpan = createSpan(trace, 'processResult', { runId: handle.runId, status: result.status })
      this.processResult(task, handle.runId, result)
      endSpan(processSpan, { artifactsWritten: result.artifacts.length, memoriesProposed: result.proposedMemories.length, followups: result.followups.length })

      // 9: Mark completed
      this.db.updateTaskStatus(taskId, result.status === 'completed' ? 'completed' : 'failed')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.persistEvent(taskId, undefined, 'error', { message })
      this.db.updateTaskStatus(taskId, 'failed')
    } finally {
      await flushTraces()
    }
  }

  // ── Build RunInput ─────────────────────────────────────────

  buildRunInput(
    task: Task,
    memories: Memory[],
    artifacts: Artifact[],
    priorAttempts: AttemptRef[],
  ): RunInput {
    const memoryRefs: MemoryRef[] = memories.map((m) => ({
      memoryId: m.id,
      text: m.text,
      relevance: m.confidence,
    }))

    const artifactRefs: ArtifactRef[] = artifacts.map((a) => ({
      artifactId: a.id,
      kind: a.kind,
      uri: a.uri,
      summary: a.summary,
    }))

    const workerSpec: WorkerSpec = {
      objective: task.objective,
      instructions: [],
      allowedTools: [],
      forbiddenActions: [],
      completionCriteria: [],
    }

    const workspace: WorkspaceSpec = {
      cwd: '.',
      writablePaths: ['.'],
      env: {},
    }

    const contract: OutputContract = {
      requiredArtifacts: [],
      requiredFields: [],
      resultSchema: {},
    }

    const limits: RunLimits = {
      maxDurationSec: 300,
      maxToolCalls: 100,
    }

    return {
      taskId: task.id,
      workerSpec,
      workspace,
      context: {
        taskSummary: `${task.title}: ${task.objective}`,
        relevantMemories: memoryRefs,
        parentArtifacts: artifactRefs,
        priorAttempts,
      },
      contract,
      limits,
    }
  }

  // ── Process RunResult ──────────────────────────────────────

  processResult(task: Task, runId: string, result: RunResult): void {
    // Persist artifacts
    for (const ref of result.artifacts) {
      this.db.createArtifact({
        id: uuid(),
        taskId: task.id,
        runId,
        kind: ref.kind,
        uri: ref.uri,
        summary: ref.summary,
        metadata: {},
        createdAt: now(),
      })
    }

    // Persist run completion event
    this.persistEvent(task.id, runId, 'run_completed', {
      status: result.status,
      summary: result.summary,
      diagnostics: result.diagnostics,
    })

    // Evaluate proposed memories (only from completed runs)
    if (result.status === 'completed' && result.proposedMemories.length) {
      this.handleProposedMemories(task, result.proposedMemories)
    }

    // Handle follow-up tasks
    if (result.followups.length) {
      this.handleProposedTasks(task, result.followups)
    }
  }

  // ── Executor selection ─────────────────────────────────────

  selectExecutor(task?: Task): ExecutorAdapter {
    if (this.executors.size === 0) throw new Error('No executors registered')

    const pi = this.executors.get('pi')

    if (task) {
      const objective = task.objective.toLowerCase()

      // Multi-step autonomous tasks → openhands
      if (/\b(sandbox|install|test|run tests|browser|web|container|autonomous)\b/.test(objective)) {
        const openhands = this.executors.get('openhands')
        if (openhands) return openhands
      }

      // LSP-aware work → opencode
      if (/\b(refactor|rename|types|lsp|language server|go to definition|signature)\b/.test(objective)) {
        const opencode = this.executors.get('opencode')
        if (opencode) return opencode
      }

      // Interactive, conversational, or multi-agent orchestration → claude
      if (/\b(subagent|spawn agents?|multi.?agent|claude subagent)\b/.test(objective)) {
        const claude = this.executors.get('claude')
        if (claude) return claude
      }
    }

    // Default → pi (fast, minimal, focused coding)
    if (pi) return pi

    // Last resort: first registered adapter
    return this.executors.values().next().value!
  }

  // ── Memory retrieval ───────────────────────────────────────

  private retrieveMemories(task: Task): Memory[] {
    const all: Memory[] = []

    // Gather from all memory kinds across relevant scopes
    const kinds = ['semantic', 'procedural', 'episodic'] as const
    const scopes = ['task', 'repo', 'global'] as const

    for (const kind of kinds) {
      for (const scope of scopes) {
        const memories = this.db.listMemories(kind, scope)
        all.push(...memories)
      }
    }

    // Filter task-scoped memories to lineage
    const lineageIds = this.getLineageIds(task)

    const filtered = all.filter((m) => {
      if (m.scope === 'task') {
        return m.sourceTaskId != null && lineageIds.has(m.sourceTaskId)
      }
      return true
    })

    // Sort by confidence desc, then freshness desc
    filtered.sort((a, b) => {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence
      return b.freshness - a.freshness
    })

    // Touch used memories
    for (const m of filtered) {
      this.db.touchMemory(m.id)
    }

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

  // ── Prior attempts ─────────────────────────────────────────

  private getPriorAttempts(task: Task): AttemptRef[] {
    const events = this.db.listEventsByTask(task.id)
    return events
      .filter((e) => e.type === 'run_completed')
      .map((e) => ({
        runId: e.runId ?? e.id,
        status: (e.payload.status as RunResult['status']) ?? 'failed',
        summary: (e.payload.summary as string) ?? '',
        failureReason: e.payload.status === 'failed'
          ? (e.payload.summary as string)
          : undefined,
      }))
  }

  // ── Validation ─────────────────────────────────────────────

  private validateResult(
    _task: Task,
    result: RunResult,
    contract: OutputContract,
  ): ValidationResult {
    return this.validator.validate(result, contract)
  }

  // ── Proposed task handling ─────────────────────────────────

  private handleProposedTasks(parent: Task, proposals: ProposedTask[]): void {
    for (const proposal of proposals) {
      const ts = now()
      this.db.createTask({
        id: uuid(),
        parentTaskId: parent.id,
        title: proposal.title,
        objective: proposal.objective,
        status: 'queued',
        priority: proposal.priority,
        createdAt: ts,
        updatedAt: ts,
      })
    }
  }

  // ── Proposed memory handling ───────────────────────────────

  private handleProposedMemories(
    task: Task,
    proposals: ProposedMemory[],
  ): void {
    const accepted = proposals.filter((m) => m.confidence > 0.5)
    for (const memory of accepted) {
      this.db.createMemory({
        id: uuid(),
        kind: memory.kind,
        scope: memory.scope,
        text: memory.text,
        confidence: memory.confidence,
        freshness: 1.0,
        sourceTaskId: task.id,
        createdAt: now(),
      })
    }
  }

  // ── Helpers ────────────────────────────────────────────────

  private persistEvent(
    taskId: string,
    runId: string | undefined,
    type: string,
    payload: Record<string, unknown>,
  ): void {
    this.db.createEvent({
      id: uuid(),
      taskId,
      runId,
      type,
      payload,
      createdAt: now(),
    })
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
