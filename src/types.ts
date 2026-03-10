export type JsonSchema = Record<string, unknown>

export type MemoryRef = {
  memoryId: string
  text: string
  relevance: number
}

export type ArtifactRef = {
  artifactId: string
  kind: Artifact["kind"]
  uri: string
  summary: string
}

export type AttemptRef = {
  runId: string
  status: RunResult["status"]
  summary: string
  failureReason?: string
}

export type ArtifactRequirement = {
  kind: Artifact["kind"]
  description: string
  required: boolean
}

export type RunHandle = { runId: string }

export type RunStatus = {
  state: "running" | "completed" | "failed" | "blocked" | "cancelled"
  progress?: string
}

export type ExecutorCapabilities = {
  tools: ("shell" | "edit" | "read" | "write" | "git" | "browser")[]
  supportsStreaming: boolean
  supportsStructuredOutput: boolean
  supportsSubtasks: boolean
  sandboxKinds: ("none" | "workspace" | "container" | "vm")[]
}

export type WorkerSpec = {
  objective: string
  instructions: string[]
  allowedTools: string[]
  forbiddenActions: string[]
  completionCriteria: string[]
}

export type WorkspaceSpec = {
  cwd: string
  writablePaths: string[]
  env: Record<string, string>
  repo?: { branch?: string; commit?: string }
}

export type ContextBundle = {
  taskSummary: string
  relevantMemories: MemoryRef[]
  parentArtifacts: ArtifactRef[]
  priorAttempts: AttemptRef[]
}

export type OutputContract = {
  requiredArtifacts: ArtifactRequirement[]
  requiredFields: string[]
  resultSchema: JsonSchema
}

export type RunLimits = {
  maxDurationSec: number
  maxToolCalls: number
  maxCostUsd?: number
}

export type RunInput = {
  taskId: string
  workerSpec: WorkerSpec
  workspace: WorkspaceSpec
  context: ContextBundle
  contract: OutputContract
  limits: RunLimits
}

// The one actual interface — implemented by adapters
export interface ExecutorAdapter {
  id: string
  capabilities(): Promise<ExecutorCapabilities>
  run(input: RunInput): Promise<RunHandle>
  poll(runId: string): Promise<RunStatus>
  cancel(runId: string): Promise<void>
  collect(runId: string): Promise<RunResult>
}

export type RunResult = {
  status: "completed" | "failed" | "blocked" | "cancelled"
  summary: string
  outputs: Record<string, unknown>
  artifacts: ArtifactRef[]
  proposedMemories: ProposedMemory[]
  followups: ProposedTask[]
  diagnostics: {
    toolCalls: number
    durationSec: number
    testsPassed?: number
    testsFailed?: number
    exitSignals?: string[]
  }
}

export type Task = {
  id: string
  parentTaskId?: string
  title: string
  objective: string
  status: "queued" | "running" | "blocked" | "completed" | "failed"
  priority: number
  createdAt: string
  updatedAt: string
}

export type Event = {
  id: string
  taskId: string
  runId?: string
  type: string
  payload: Record<string, unknown>
  createdAt: string
}

export type Artifact = {
  id: string
  taskId: string
  runId?: string
  kind: "file" | "diff" | "log" | "report" | "test_result" | "plan"
  uri: string
  hash?: string
  summary: string
  metadata: Record<string, unknown>
  createdAt: string
}

export type Memory = {
  id: string
  kind: "semantic" | "procedural" | "episodic"
  scope: "global" | "repo" | "branch" | "task" | "user"
  text: string
  embedding?: number[]
  sourceTaskId?: string
  sourceArtifactId?: string
  confidence: number
  freshness: number
  createdAt: string
  lastUsedAt?: string
}

export type ProposedTask = {
  title: string
  objective: string
  reason: string
  dependencies: string[]
  requiredArtifacts: string[]
  priority: number
}

export type ProposedMemory = {
  kind: "semantic" | "procedural" | "episodic"
  scope: "global" | "repo" | "branch" | "task" | "user"
  text: string
  confidence: number
}
