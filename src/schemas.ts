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
