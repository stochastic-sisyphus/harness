import { mkdir, readFile, copyFile, writeFile } from "node:fs/promises"
import { join, basename } from "node:path"
import { CloseoutArtifactSchema, type CloseoutArtifact } from "./schemas.js"

export async function validateCloseout(
  projectDir: string,
): Promise<{ valid: boolean; errors: string[] }> {
  const closeoutPath = join(projectDir, ".harness", "closeout.json")
  let raw: string
  try {
    raw = await readFile(closeoutPath, "utf8")
  } catch {
    return { valid: false, errors: [`closeout.json not found at ${closeoutPath}`] }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { valid: false, errors: ["closeout.json is not valid JSON"] }
  }

  const result = CloseoutArtifactSchema.safeParse(parsed)
  if (!result.success) {
    const errors = result.error.issues.map(
      (issue) => `${issue.path.join(".")}: ${issue.message}`,
    )
    return { valid: false, errors }
  }

  return { valid: true, errors: [] }
}

export async function archiveCloseout(projectDir: string): Promise<string> {
  const harnessDir = join(projectDir, ".harness")
  const closeoutsDir = join(harnessDir, "closeouts")
  await mkdir(closeoutsDir, { recursive: true })

  const date = new Date().toISOString().replace(/[:.]/g, "-")
  const archivePath = join(closeoutsDir, `${date}.json`)
  await copyFile(join(harnessDir, "closeout.json"), archivePath)
  return archivePath
}

export async function writeCloseoutTemplate(projectDir: string): Promise<string> {
  const harnessDir = join(projectDir, ".harness")
  await mkdir(harnessDir, { recursive: true })

  const template: CloseoutArtifact = {
    timestamp: new Date().toISOString(),
    project: basename(projectDir),
    changes: { filesChanged: [], commits: [] },
    proof: { testsRan: false, testsPassed: false, lintClean: false },
    promoted: [],
    next: [],
  }

  const outPath = join(harnessDir, "closeout.json")
  await writeFile(outPath, JSON.stringify(template, null, 2), "utf8")
  return outPath
}
