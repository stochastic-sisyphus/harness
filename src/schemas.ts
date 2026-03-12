import { z } from "zod"

export const DecisionSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  tags: z.array(z.string()),
  summary: z.string(),
})

export const BootArtifactSchema = z.object({
  generated: z.string().datetime(),
  project: z.string(),
  sessionContext: z.string().nullable(),
  decisions: z.array(DecisionSchema),
  openThreads: z.array(z.string()),
})

export const ProofSchema = z.object({
  testsRan: z.boolean(),
  testsPassed: z.boolean(),
  lintClean: z.boolean(),
  notes: z.string().optional(),
})

export const PromotedMemorySchema = z.object({
  kind: z.enum(["semantic", "procedural", "episodic"]),
  scope: z.enum(["global", "repo", "branch", "task", "user"]),
  text: z.string(),
})

export const CloseoutArtifactSchema = z.object({
  timestamp: z.string().datetime(),
  project: z.string(),
  changes: z.object({
    filesChanged: z.array(z.string()),
    commits: z.array(z.string()),
  }),
  proof: ProofSchema,
  promoted: z.array(PromotedMemorySchema),
  next: z.array(z.string()),
})

export type BootArtifact = z.infer<typeof BootArtifactSchema>
export type CloseoutArtifact = z.infer<typeof CloseoutArtifactSchema>
export type PromotedMemory = z.infer<typeof PromotedMemorySchema>

// ── Agent Behavior Config ─────────────────────────────────

export const IdentitySchema = z.object({
  role: z.string().default("engineer"),
  mission: z.string().default(""),
  nonGoals: z.array(z.string()).default([]),
})

export const BehaviorSchema = z.object({
  tone: z.string().default("terse"),
  brevity: z.enum(["minimal", "moderate", "verbose"]).default("minimal"),
  escalationRules: z.array(z.string()).default(["ask before destructive actions"]),
  askVsAssume: z.enum(["ask", "assume", "ask-destructive-only"]).default("ask-destructive-only"),
})

export const ToolPolicySchema = z.object({
  allow: z.array(z.string()).default([]),
  deny: z.array(z.string()).default([]),
  requireApproval: z.array(z.string()).default([]),
})

export const StopConditionsSchema = z.object({
  testCmd: z.string().optional(),
  lintCmd: z.string().optional(),
  lintTarget: z.string().optional(),
  required: z.array(z.string()).default(["testCmd"]),
})

export const ExecutionSchema = z.object({
  toolPolicy: ToolPolicySchema.default({}),
  stopConditions: StopConditionsSchema.default({}),
  verificationRequired: z.boolean().default(true),
  maxRetries: z.number().default(2),
})

export const CompactionSchema = z.object({
  threshold: z.number().min(0).max(100).default(75),
  preserveSections: z.array(z.string()).default([]),
})

export const ContextSchema = z.object({
  bootFiles: z.array(z.string()).default([".claude-session-notes.md"]),
  ignorePatterns: z.array(z.string()).default(["node_modules", ".git", "dist"]),
  compaction: CompactionSchema.default({}),
})

export const ModelSchema = z.object({
  default: z.string().default("claude-sonnet-4-6"),
  temperature: z.number().min(0).max(1).default(0),
  maxTokens: z.number().default(16384),
  toolChoice: z.enum(["auto", "required", "none"]).default("auto"),
})

export const OutputsSchema = z.object({
  artifactDir: z.string().default(".harness"),
  requiredArtifacts: z.array(z.string()).default(["closeout.json"]),
  format: z.enum(["json", "yaml"]).default("json"),
  definitionOfDone: z.array(z.string()).default(["tests pass", "lint clean", "closeout valid"]),
})

export const MemorySchema = z.object({
  persist: z.object({
    preferences: z.boolean().default(true),
    operatingRules: z.boolean().default(true),
    decisions: z.boolean().default(true),
  }).default({}),
  neverPersist: z.array(z.string()).default(["raw chat", "debug output", "temp state"]),
  sessionStateFile: z.string().default(".claude-session-notes.md"),
})

export const AgentConfigSchema = z.object({
  version: z.string().default("1.0.0"),
  identity: IdentitySchema.default({}),
  behavior: BehaviorSchema.default({}),
  execution: ExecutionSchema.default({}),
  context: ContextSchema.default({}),
  model: ModelSchema.default({}),
  outputs: OutputsSchema.default({}),
  memory: MemorySchema.default({}),
})

export type AgentConfig = z.infer<typeof AgentConfigSchema>
