import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { join, basename } from "node:path"
import { homedir } from "node:os"
import { BootArtifactSchema, type BootArtifact } from "./schemas.js"

const DECISIONS_DIR = join(homedir(), ".claude", "decisions")

async function readFileSafe(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8")
  } catch {
    return null
  }
}

function extractDecision(yaml: string): { id: string; title: string; status: string; tags: string[]; summary: string } | null {
  const id = yaml.match(/^id:\s*(.+)$/m)?.[1]?.trim()
  const title = yaml.match(/^title:\s*(.+)$/m)?.[1]?.trim()
  if (!id || !title) return null

  const status = yaml.match(/^status:\s*(.+)$/m)?.[1]?.trim() ?? "unknown"
  const summary = yaml.match(/^summary:\s*(.+)$/m)?.[1]?.trim() ?? ""

  // Parse tags from inline [a, b] or block form
  const inlineTags = yaml.match(/^tags:\s*\[([^\]]*)\]/m)
  let tags: string[] = []
  if (inlineTags?.[1]) {
    tags = inlineTags[1].split(",").map((t) => t.trim()).filter(Boolean)
  } else {
    const blockMatch = yaml.match(/^tags:\s*\n((?:\s+-\s+.+\n?)*)/m)
    if (blockMatch?.[1]) {
      tags = blockMatch[1].split("\n").map((l) => l.replace(/^\s+-\s+/, "").trim()).filter(Boolean)
    }
  }

  return { id, title, status, tags, summary }
}

function extractOpenThreads(notes: string): string[] {
  return notes
    .split("\n")
    .filter((line) => /⏳|TODO|BLOCKED/.test(line))
    .map((line) => line.trim())
    .filter(Boolean)
}

export async function generateBoot(projectDir: string): Promise<string> {
  const projectName = basename(projectDir)
  const harnessDir = join(projectDir, ".harness")
  await mkdir(harnessDir, { recursive: true })

  const sessionNotes = await readFileSafe(join(projectDir, ".claude-session-notes.md"))

  const decisions: BootArtifact["decisions"] = []
  try {
    const files = await readdir(DECISIONS_DIR)
    for (const file of files.filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))) {
      const content = await readFileSafe(join(DECISIONS_DIR, file))
      if (!content) continue
      const decision = extractDecision(content)
      if (decision && decision.tags.includes(projectName)) {
        decisions.push(decision)
      }
    }
  } catch {
    // DECISIONS_DIR missing — skip
  }

  const openThreads = sessionNotes ? extractOpenThreads(sessionNotes) : []

  const artifact: BootArtifact = {
    generated: new Date().toISOString(),
    project: projectDir,
    sessionContext: sessionNotes,
    decisions,
    openThreads,
  }

  BootArtifactSchema.parse(artifact)

  const outPath = join(harnessDir, "boot.json")
  await writeFile(outPath, JSON.stringify(artifact, null, 2), "utf8")
  return outPath
}
