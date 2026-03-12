import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { join, basename } from "node:path"
import { homedir } from "node:os"

const DECISIONS_DIR = join(homedir(), ".claude", "decisions")

async function readFileSafe(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8")
  } catch {
    return null
  }
}

function extractTags(yaml: string): string[] {
  const match = yaml.match(/^tags:\s*\[([^\]]*)\]/m)
  if (!match?.[1]) return []
  return match[1].split(",").map((t) => t.trim())
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
  const sessionSection = sessionNotes ?? "No prior session notes found."

  let decisionSection = "No decisions recorded for this project."
  try {
    const files = await readdir(DECISIONS_DIR)
    const matched: string[] = []
    for (const file of files.filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))) {
      const content = await readFileSafe(join(DECISIONS_DIR, file))
      if (content && extractTags(content).includes(projectName)) {
        matched.push(content.trim())
      }
    }
    if (matched.length > 0) {
      decisionSection = matched.join("\n\n---\n\n")
    }
  } catch {
    // DECISIONS_DIR missing — use default
  }

  const threads = sessionNotes ? extractOpenThreads(sessionNotes) : []
  const threadsSection = threads.length > 0 ? threads.join("\n") : "No open threads found."

  const content = `# Boot Artifact
Generated: ${new Date().toISOString()}
Project: ${projectDir}

## Session Context
${sessionSection}

## Relevant Decisions
${decisionSection}

## Open Threads
${threadsSection}
`

  const outPath = join(harnessDir, "boot.md")
  await writeFile(outPath, content, "utf8")
  return outPath
}
