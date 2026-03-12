import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { AgentConfigSchema, type AgentConfig } from "./schemas.js"

export async function loadConfig(projectDir: string): Promise<AgentConfig> {
  const configPath = join(projectDir, ".harness", "config.json")

  let raw: unknown = {}
  try {
    const content = await readFile(configPath, "utf8")
    raw = JSON.parse(content)
  } catch {
    // No config file — use all defaults
  }

  return AgentConfigSchema.parse(raw)
}

export function defaultConfig(): AgentConfig {
  return AgentConfigSchema.parse({})
}
