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
  sessionId?: string
}

export class ClaudeAdapter implements ExecutorAdapter {
  readonly id = "claude"
  private processes = new Map<string, ProcessRecord>()

  async capabilities(): Promise<ExecutorCapabilities> {
    return {
      tools: ["shell", "edit", "read", "write", "git", "browser"],
      supportsStreaming: false,
      supportsStructuredOutput: false,
      supportsSubtasks: true,
      sandboxKinds: ["none", "workspace"],
    }
  }

  async run(input: RunInput): Promise<RunHandle> {
    const runId = randomUUID()

    const prompt = this.buildPrompt(input)
    const args = ["-p", prompt]

    const env = { ...process.env, ...input.workspace.env }
    const child = spawn("claude", args, {
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
      // Extract session ID from output for resume support
      if (!record.sessionId) {
        const id = this.extractSessionId(record.stdout)
        if (id) record.sessionId = id
      }
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

    const artifacts = await this.collectArtifacts(runId, record.cwd)

    // Claude -p outputs plain text — use stdout directly as the summary
    const summary =
      record.stdout.trim().slice(0, 2000) ||
      record.stderr.trim().slice(0, 500) ||
      "No output"

    const status = record.exitCode === 0 ? "completed" : "failed"

    const result: RunResult = {
      status,
      summary,
      outputs: {
        raw: record.stdout,
        sessionId: record.sessionId,
      },
      artifacts,
      proposedMemories: [],
      followups: [],
      diagnostics: {
        toolCalls: 0,
        durationSec: 0,
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

    parts.push(`\nWORKSPACE:\n- cwd: ${input.workspace.cwd}`)

    const envKeys = Object.keys(input.workspace.env)
    if (envKeys.length > 0) {
      parts.push(`- env: ${envKeys.join(", ")}`)
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

  /** Extract session ID from claude output for --resume support */
  private extractSessionId(raw: string): string | null {
    const match = raw.match(/session[_-]?id["\s:]+([a-zA-Z0-9_-]{8,})/i)
    return match?.[1] ?? null
  }

  private getRecord(runId: string): ProcessRecord {
    const record = this.processes.get(runId)
    if (!record) {
      throw new Error(`Unknown run: ${runId}`)
    }
    return record
  }
}
