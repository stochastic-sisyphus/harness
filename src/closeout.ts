import { mkdir, readFile, copyFile } from "node:fs/promises"
import { join } from "node:path"

const REQUIRED_SECTIONS = ["## Changes", "## Proof", "## Promoted", "## Next"] as const

export async function validateCloseout(
  projectDir: string,
): Promise<{ valid: boolean; errors: string[] }> {
  const closeoutPath = join(projectDir, ".harness", "closeout.md")
  let content: string
  try {
    content = await readFile(closeoutPath, "utf8")
  } catch {
    return { valid: false, errors: [`closeout.md not found at ${closeoutPath}`] }
  }

  const errors = REQUIRED_SECTIONS
    .filter((section) => !content.includes(section))
    .map((section) => `Missing required section: ${section}`)

  return { valid: errors.length === 0, errors }
}

export async function archiveCloseout(projectDir: string): Promise<string> {
  const harnessDir = join(projectDir, ".harness")
  const closeoutsDir = join(harnessDir, "closeouts")
  await mkdir(closeoutsDir, { recursive: true })

  const date = new Date().toISOString().replace(/[:.]/g, "-")
  const archivePath = join(closeoutsDir, `${date}.md`)
  await copyFile(join(harnessDir, "closeout.md"), archivePath)
  return archivePath
}
