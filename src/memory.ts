import type { Task, Memory } from "./types.js"
import type { Db } from "./db.js"

const MEMORY_KINDS = ["semantic", "procedural", "episodic"] as const
const MEMORY_SCOPES = ["global", "repo", "branch", "task", "user"] as const

interface ScoredMemory extends Memory {
  score: number
}

/**
 * Hybrid retrieval model for task-relevant memories.
 *
 * 1. Local task context: parent task, sibling artifacts, prior attempts
 * 2. Repo-scoped semantic memory
 * 3. Procedural memory (global)
 *
 * For MVP: text matching instead of embedding search.
 * Re-ranked by confidence * freshness, with used memories touched.
 */
export function retrieveForTask(db: Db, task: Task): Memory[] {
  const seen = new Set<string>()
  const scored: ScoredMemory[] = []

  const addMemory = (m: Memory, boost: number) => {
    if (seen.has(m.id)) return
    seen.add(m.id)
    scored.push({ ...m, score: m.confidence * m.freshness * boost })
  }

  // --- Layer 1: Local task context ---
  // Task-scoped memories from this task's lineage
  const lineageIds = getLineageIds(db, task)
  const taskMemories = db.listMemories("episodic", "task")
  for (const m of taskMemories) {
    if (m.sourceTaskId && lineageIds.has(m.sourceTaskId)) {
      addMemory(m, 1.5)
    }
  }

  // Sibling artifacts context: semantic memories tied to parent
  if (task.parentTaskId) {
    for (const kind of MEMORY_KINDS) {
      const memories = db.listMemories(kind, "task")
      for (const m of memories) {
        if (m.sourceTaskId === task.parentTaskId) {
          addMemory(m, 1.2)
        }
      }
    }
  }

  // --- Layer 2: Repo-scoped semantic memory ---
  const repoSemantic = db.listMemories("semantic", "repo")
  for (const m of repoSemantic) {
    if (textMatch(m.text, task.objective)) {
      addMemory(m, 1.0)
    }
  }

  const repoEpisodic = db.listMemories("episodic", "repo")
  for (const m of repoEpisodic) {
    if (textMatch(m.text, task.objective)) {
      addMemory(m, 0.8)
    }
  }

  // --- Layer 3: Procedural memory (global) ---
  const globalProcedural = db.listMemories("procedural", "global")
  for (const m of globalProcedural) {
    addMemory(m, 0.7)
  }

  // Re-rank by score (confidence * freshness * layer boost)
  scored.sort((a, b) => b.score - a.score)

  // Touch used memories
  for (const m of scored) {
    db.touchMemory(m.id)
  }

  return scored
}

function getLineageIds(db: Db, task: Task): Set<string> {
  const ids = new Set<string>()
  let current: Task | undefined = task
  while (current) {
    ids.add(current.id)
    current = current.parentTaskId
      ? db.getTask(current.parentTaskId)
      : undefined
  }
  return ids
}

/**
 * Simple text-match heuristic: check if any significant words
 * from the query appear in the memory text.
 * MVP stand-in for semantic/embedding search.
 */
function textMatch(memoryText: string, query: string): boolean {
  const stopWords = new Set([
    "the", "a", "an", "is", "are", "was", "were", "be", "been",
    "being", "have", "has", "had", "do", "does", "did", "will",
    "would", "could", "should", "may", "might", "can", "shall",
    "to", "of", "in", "for", "on", "with", "at", "by", "from",
    "as", "into", "through", "during", "before", "after", "and",
    "but", "or", "nor", "not", "no", "so", "if", "then", "than",
    "that", "this", "it", "its",
  ])

  const queryWords = query
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 2 && !stopWords.has(w))

  const lowerMemory = memoryText.toLowerCase()
  const matchCount = queryWords.filter((w) => lowerMemory.includes(w)).length

  return matchCount >= Math.max(1, Math.floor(queryWords.length * 0.3))
}
