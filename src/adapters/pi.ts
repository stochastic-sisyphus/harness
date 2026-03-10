import { spawn, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type {
  ExecutorAdapter,
  ExecutorCapabilities,
  RunInput,
  RunHandle,
  RunStatus,
  RunResult,
  ArtifactRef,
} from "../types.js"

const execFileAsync = promisify(execFile)

interface ProcessRecord {
  process: ChildProcess
  stdout: string
  stderr: string
  exitCode: number | null
  exited: boolean
  cwd: string
}

export class PiAdapter implements ExecutorAdapter {
  readonly id = "pi"
  private processes = new Map<string, ProcessRecord>()

  async capabilities(): Promise<ExecutorCapabilities> {
    return {
      tools: ["shell", "edit", "read", "write", "git", "browser"],
      supportsStreaming: true,
      supportsStructuredOutput: true,
      supportsSubtasks: true,
      sandboxKinds: ["workspace"],
    }
  }

  async run(input: RunInput): Promise<RunHandle> {
    const runId = randomUUID()

    const prompt = this.buildPrompt(input)
    const args = ["-p", "--mode", "json", "--no-session", prompt]

    const env = { ...process.env, ...input.workspace.env }
    const child = spawn("omp", args, {
      cwd: input.workspace.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    })

    const record: ProcessRecord = {
      process: child,
      stdout: "",
      stderr: "",
      exitCode: null,
      exited: false,
      cwd: input.workspace.cwd,
    }

    child.stdout!.on("data", (chunk: Buffer) => {
      record.stdout += chunk.toString()
    })

    child.stderr!.on("data", (chunk: Buffer) => {
      record.stderr += chunk.toString()
    })

    child.on("close", (code) => {
      record.exitCode = code
      record.exited = true
    })

    child.on("error", (err) => {
      record.stderr += `\nspawn error: ${err.message}`
      record.exited = true
      record.exitCode = record.exitCode ?? 1
    })

    this.processes.set(runId, record)
    return { runId }
  }

  async poll(runId: string): Promise<RunStatus> {
    const record = this.getRecord(runId)

    if (!record.exited) {
      return { state: "running" }
    }

    return {
      state: record.exitCode === 0 ? "completed" : "failed",
    }
  }

  async cancel(runId: string): Promise<void> {
    const record = this.getRecord(runId)
    if (record.exited) return

    record.process.kill("SIGTERM")

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        if (!record.exited) {
          record.process.kill("SIGKILL")
        }
        resolve()
      }, 5_000)

      const check = setInterval(() => {
        if (record.exited) {
          clearTimeout(timeout)
          clearInterval(check)
          resolve()
        }
      }, 100)
    })
  }

  async collect(runId: string): Promise<RunResult> {
    const record = this.getRecord(runId)

    if (!record.exited) {
      throw new Error(`Run ${runId} is still in progress`)
    }

    const parsed = this.tryParseJson(record.stdout)
    const artifacts = await this.collectArtifacts(runId, record.cwd)

    const summary =
      parsed?.summary ??
      parsed?.result ??
      (record.stdout.slice(0, 500) || record.stderr.slice(0, 500) || "No output")

    const status = record.exitCode === 0 ? "completed" : "failed"

    const result: RunResult = {
      status,
      summary: typeof summary === "string" ? summary : JSON.stringify(summary),
      outputs: parsed ?? { raw: record.stdout },
      artifacts,
      proposedMemories: parsed?.proposedMemories ?? [],
      followups: parsed?.followups ?? [],
      diagnostics: {
        toolCalls: parsed?.diagnostics?.toolCalls ?? 0,
        durationSec: parsed?.diagnostics?.durationSec ?? 0,
        exitSignals: record.exitCode !== 0
          ? [`exit_code_${record.exitCode}`]
          : undefined,
      },
    }

    this.processes.delete(runId)
    return result
  }

  private buildPrompt(input: RunInput): string {
    const parts: string[] = []

    parts.push(`OBJECTIVE: ${input.workerSpec.objective}`)

    if (input.workerSpec.instructions.length > 0) {
      parts.push(`\nINSTRUCTIONS:\n${input.workerSpec.instructions.map((i) => `- ${i}`).join("\n")}`)
    }

    if (input.workerSpec.completionCriteria.length > 0) {
      parts.push(`\nCOMPLETION CRITERIA:\n${input.workerSpec.completionCriteria.map((c) => `- ${c}`).join("\n")}`)
    }

    if (input.context.taskSummary) {
      parts.push(`\nCONTEXT:\n${input.context.taskSummary}`)
    }

    if (input.context.relevantMemories.length > 0) {
      const memories = input.context.relevantMemories
        .map((m) => `- [${m.relevance.toFixed(2)}] ${m.text}`)
        .join("\n")
      parts.push(`\nRELEVANT MEMORIES:\n${memories}`)
    }

    return parts.join("\n")
  }

  private async collectArtifacts(runId: string, cwd: string): Promise<ArtifactRef[]> {
    const artifacts: ArtifactRef[] = []

    try {
      const { stdout } = await execFileAsync("git", ["diff", "--name-only", "HEAD"], { cwd })
      const files = stdout.trim().split("\n").filter(Boolean)

      for (const file of files) {
        artifacts.push({
          artifactId: `${runId}:${file}`,
          kind: "file",
          uri: `file://${cwd}/${file}`,
          summary: `Modified: ${file}`,
        })
      }
    } catch {
      // Not a git repo or no changes -- that's fine
    }

    return artifacts
  }

  private getRecord(runId: string): ProcessRecord {
    const record = this.processes.get(runId)
    if (!record) {
      throw new Error(`Unknown run: ${runId}`)
    }
    return record
  }

  private tryParseJson(raw: string): Record<string, any> | null {
    try {
      return JSON.parse(raw)
    } catch {
      // Try to find a JSON object in the output (omp may prefix with non-JSON)
      const match = raw.match(/\{[\s\S]*\}/)
      if (match) {
        try {
          return JSON.parse(match[0])
        } catch {
          return null
        }
      }
      return null
    }
  }
}
