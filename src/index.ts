#!/usr/bin/env node

import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { spawnSync } from "node:child_process"

import { initDb } from "./db.js"
import { Supervisor } from "./supervisor.js"
import { LettaOrchestrator } from "./orchestrator.js"
import { Validator } from "./validator.js"
import { createAdapters } from "./adapters/index.js"
import { generateBoot } from "./boot.js"
import { validateCloseout, archiveCloseout } from "./closeout.js"

const DB_DIR = join(homedir(), ".harness")
const DB_PATH = join(DB_DIR, "harness.db")
const GUM = join(homedir(), ".local/share/mise/shims/gum")

// ── Terroir palette ───────────────────────────────────────
const C = {
  bg: "#2A1B16",
  accent1: "#778C89",
  muted: "#A68A7B",
  text: "#CABAB0",
  bright: "#DCCCBD",
  green: "#778C89",
  red: "#A0522D",
  yellow: "#C8A96E",
  dim: "#605E5C",
}

// ── gum helpers ───────────────────────────────────────────

function gum(args: string[], input?: string): string {
  const result = spawnSync(GUM, args, {
    input,
    encoding: "utf8",
    stdio: input !== undefined ? ["pipe", "pipe", "inherit"] : ["inherit", "pipe", "inherit"],
  })
  return (result.stdout ?? "").trim()
}

function print(text: string): void {
  process.stdout.write(text + "\n")
}

function gumStyle(text: string, opts: { fg?: string; bold?: boolean; border?: string; padding?: string; margin?: string; width?: number } = {}): string {
  const args = ["style"]
  if (opts.fg) args.push("--foreground", opts.fg)
  if (opts.bold) args.push("--bold")
  if (opts.border) args.push("--border", opts.border)
  if (opts.padding) args.push("--padding", opts.padding)
  if (opts.margin) args.push("--margin", opts.margin)
  if (opts.width) args.push("--width", String(opts.width))
  args.push(text)
  const result = spawnSync(GUM, args, { encoding: "utf8" })
  return (result.stdout ?? "").trimEnd()
}

function gumTable(rows: string[][], headers: string[]): void {
  const allRows = [headers, ...rows]
  const csv = allRows.map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(",")).join("\n")
  spawnSync(GUM, ["table", "--border", "rounded", "--border.foreground", C.dim], {
    input: csv,
    encoding: "utf8",
    stdio: ["pipe", "inherit", "inherit"],
  })
}

function gumTableStr(rows: string[][], headers: string[]): string {
  const allRows = [headers, ...rows]
  const csv = allRows.map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(",")).join("\n")
  const result = spawnSync(GUM, ["table", "--border", "rounded", "--border.foreground", C.dim], {
    input: csv,
    encoding: "utf8",
  })
  return (result.stdout ?? "").trimEnd()
}

function gumInput(placeholder: string, prompt = "> "): string {
  const result = spawnSync(GUM, [
    "input",
    "--placeholder", placeholder,
    "--prompt", prompt,
    "--prompt.foreground", C.accent1,
    "--placeholder.foreground", C.dim,
    "--width", "72",
  ], {
    encoding: "utf8",
    stdio: ["inherit", "pipe", "inherit"],
  })
  return (result.stdout ?? "").trim()
}

function gumChoose(options: string[], header?: string): string {
  const args = ["choose", "--cursor", "→ ", "--cursor.foreground", C.accent1, "--selected.foreground", C.bright, "--height", "10"]
  if (header) args.push("--header", header, "--header.foreground", C.muted)
  args.push(...options)
  const result = spawnSync(GUM, args, {
    encoding: "utf8",
    stdio: ["inherit", "pipe", "inherit"],
  })
  return (result.stdout ?? "").trim()
}

function gumFilter(options: string[], placeholder = "Filter..."): string {
  const result = spawnSync(GUM, [
    "filter",
    "--placeholder", placeholder,
    "--prompt", "> ",
    "--prompt.foreground", C.accent1,
    "--match.foreground", C.bright,
    "--indicator.foreground", C.accent1,
    "--height", "12",
  ], {
    input: options.join("\n"),
    encoding: "utf8",
    stdio: ["pipe", "pipe", "inherit"],
  })
  return (result.stdout ?? "").trim()
}

function gumPager(content: string): void {
  spawnSync(GUM, ["pager", "--border.foreground", C.dim, "--help.foreground", C.muted], {
    input: content,
    encoding: "utf8",
    stdio: ["pipe", "inherit", "inherit"],
  })
}

function gumConfirm(prompt: string): boolean {
  const result = spawnSync(GUM, [
    "confirm",
    "--prompt.foreground", C.muted,
    "--selected.background", C.accent1,
    "--unselected.foreground", C.dim,
    prompt,
  ], {
    encoding: "utf8",
    stdio: ["inherit", "pipe", "inherit"],
  })
  return result.status === 0
}

function pressAnyKey(): void {
  spawnSync(GUM, ["input", "--placeholder", "press enter to continue", "--prompt", "", "--width", "32"], {
    encoding: "utf8",
    stdio: ["inherit", "pipe", "inherit"],
  })
}

// ── DB helpers ────────────────────────────────────────────

function getDb() {
  mkdirSync(DB_DIR, { recursive: true })
  return initDb(DB_PATH)
}

function getAllTasks(db: ReturnType<typeof initDb>) {
  const statuses = ["queued", "running", "blocked", "completed", "failed"] as const
  const all = []
  for (const status of statuses) {
    all.push(...db.listTasksByStatus(status))
  }
  return all
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function statusColor(status: string): string {
  switch (status) {
    case "completed": return C.green
    case "failed": return C.red
    case "running": return C.yellow
    default: return C.dim
  }
}

// ── Screens ───────────────────────────────────────────────

async function screenRunTask(): Promise<void> {
  print(gumStyle("Run a Task", { fg: C.accent1, bold: true }))
  print("")

  const objective = gumInput("What should the agent do?")
  if (!objective) {
    print(gumStyle("No objective provided.", { fg: C.muted }))
    pressAnyKey()
    return
  }

  const mode = gumChoose(
    [
      "Direct (supervisor picks executor)",
      "Orchestrated (Letta plans, agents execute)",
    ],
    "How should this run?",
  )
  if (!mode) {
    print(gumStyle("Cancelled.", { fg: C.muted }))
    pressAnyKey()
    return
  }

  const db = getDb()
  try {
    const taskId = crypto.randomUUID()
    const ts = new Date().toISOString()

    db.createTask({
      id: taskId,
      title: objective.slice(0, 80),
      objective,
      status: "queued",
      priority: 0,
      createdAt: ts,
      updatedAt: ts,
    })

    print("")
    print(gumStyle(`Task ${taskId.slice(0, 8)}`, { fg: C.dim }))
    print(gumStyle(objective, { fg: C.bright, bold: true }))
    print("")
    print(gumStyle("Running...", { fg: C.muted }))

    const adapters = createAdapters()
    const validator = new Validator()
    const supervisor = new Supervisor(db, adapters, validator)

    if (mode.startsWith("Orchestrated")) {
      const orchestrator = new LettaOrchestrator(db, supervisor)
      await orchestrator.orchestrate(taskId)
    } else {
      await supervisor.runTask(taskId)
    }

    const task = db.getTask(taskId)
    const events = db.listEventsByTask(taskId)

    print("")

    const statusLine = task
      ? gumStyle(`Status: ${task.status.toUpperCase()}`, { fg: statusColor(task.status), bold: true })
      : gumStyle("Status: unknown", { fg: C.dim })

    const completion = events.find((e) => e.type === "run_completed")
    const failure = events.find((e) => e.type === "error" || e.type === "validation_failed")

    const summaryText = completion?.payload?.summary
      ? String(completion.payload.summary)
      : ""

    const errorText = failure?.payload
      ? `Error: ${typeof failure.payload.message === "string" ? failure.payload.message : JSON.stringify(failure.payload.errors ?? failure.payload)}`
      : ""

    const cardLines = [statusLine]
    if (summaryText) cardLines.push("", gumStyle(summaryText, { fg: C.text }))
    if (errorText) cardLines.push("", gumStyle(errorText, { fg: C.red }))

    spawnSync(GUM, [
      "style",
      "--border", "rounded",
      "--border.foreground", C.accent1,
      "--padding", "1 2",
      "--margin", "0 1",
      cardLines.join("\n"),
    ], { encoding: "utf8", stdio: ["inherit", "inherit", "inherit"] })
  } finally {
    db.close()
  }

  print("")
  pressAnyKey()
}

function screenViewTasks(): void {
  const db = getDb()
  try {
    print(gumStyle("View Tasks", { fg: C.accent1, bold: true }))
    print("")

    const tasks = getAllTasks(db)
    if (tasks.length === 0) {
      print(gumStyle("No tasks yet.", { fg: C.muted }))
      pressAnyKey()
      return
    }

    const rows = tasks.map((t) => [
      t.id.slice(0, 8),
      t.title.slice(0, 48),
      t.status,
      String(t.priority),
      relativeTime(t.updatedAt),
    ])

    gumTable(rows, ["ID", "Title", "Status", "Priority", "Updated"])
    print("")

    const filterOptions = tasks.map((t) => `${t.id.slice(0, 8)}  ${t.title.slice(0, 48)}  [${t.status}]`)
    const picked = gumFilter(filterOptions, "Filter to view detail...")
    if (!picked) { pressAnyKey(); return }

    const shortId = picked.split(" ")[0]
    const task = tasks.find((t) => t.id.startsWith(shortId))
    if (!task) { pressAnyKey(); return }

    print("")
    const color = statusColor(task.status)
    const lines = [
      gumStyle(`ID       ${task.id.slice(0, 8)}`, { fg: C.muted }),
      gumStyle(`Title    ${task.title}`, { fg: C.bright, bold: true }),
      gumStyle(`Status   ${task.status.toUpperCase()}`, { fg: color, bold: true }),
      gumStyle(`Priority ${task.priority}`, { fg: C.text }),
      gumStyle(`Created  ${relativeTime(task.createdAt)}`, { fg: C.text }),
      gumStyle(`Updated  ${relativeTime(task.updatedAt)}`, { fg: C.text }),
      "",
      gumStyle(task.objective, { fg: C.text }),
    ]

    spawnSync(GUM, [
      "style",
      "--border", "rounded",
      "--border.foreground", C.accent1,
      "--padding", "1 2",
      "--margin", "0 1",
      lines.join("\n"),
    ], { encoding: "utf8", stdio: ["inherit", "inherit", "inherit"] })
  } finally {
    db.close()
  }

  print("")
  pressAnyKey()
}

function screenViewMemories(): void {
  const db = getDb()
  try {
    print(gumStyle("View Memories", { fg: C.accent1, bold: true }))
    print("")

    const kinds = ["semantic", "procedural", "episodic"] as const
    const scopes = ["global", "repo", "branch", "task", "user"] as const

    const rows: string[][] = []
    for (const kind of kinds) {
      for (const scope of scopes) {
        for (const m of db.listMemories(kind, scope)) {
          rows.push([
            m.kind,
            m.scope,
            m.confidence.toFixed(2),
            m.text.slice(0, 60) + (m.text.length > 60 ? "…" : ""),
          ])
        }
      }
    }

    if (rows.length === 0) {
      print(gumStyle("No memories yet.", { fg: C.muted }))
      pressAnyKey()
      return
    }

    gumTable(rows, ["Kind", "Scope", "Confidence", "Text"])
    print("")

    const filterOptions = rows.map((r) => `${r[0]}  ${r[1]}  ${r[2]}  ${r[3]}`)
    gumFilter(filterOptions, "Filter memories...")
  } finally {
    db.close()
  }

  print("")
  pressAnyKey()
}

async function screenBoot(): Promise<void> {
  print(gumStyle("Generate Boot Artifact", { fg: C.accent1, bold: true }))
  print("")
  await cmdBoot()
  print("")
  pressAnyKey()
}

async function screenCloseout(): Promise<void> {
  print(gumStyle("Validate Closeout", { fg: C.accent1, bold: true }))
  print("")
  await cmdCloseout().catch(() => {})
  print("")
  pressAnyKey()
}

function screenTaskHistory(): void {
  const db = getDb()
  try {
    print(gumStyle("Task History", { fg: C.accent1, bold: true }))
    print("")

    const tasks = getAllTasks(db)
    if (tasks.length === 0) {
      print(gumStyle("No tasks yet.", { fg: C.muted }))
      pressAnyKey()
      return
    }

    const filterOptions = tasks.map((t) => `${t.id.slice(0, 8)}  ${t.title.slice(0, 48)}  [${t.status}]`)
    const picked = gumFilter(filterOptions, "Pick a task to view history...")
    if (!picked) { pressAnyKey(); return }

    const shortId = picked.split(" ")[0]
    const task = tasks.find((t) => t.id.startsWith(shortId))
    if (!task) { pressAnyKey(); return }

    const events = db.listEventsByTask(task.id)
    if (events.length === 0) {
      print("")
      print(gumStyle(`No events for task ${task.id.slice(0, 8)}.`, { fg: C.muted }))
      pressAnyKey()
      return
    }

    const lines = events.map((e) => {
      const payloadKeys = Object.keys(e.payload)
      const summary = payloadKeys.length > 0
        ? payloadKeys.map((k) => {
            const v = e.payload[k]
            const s = typeof v === "string" ? v : JSON.stringify(v)
            return `${k}: ${s.slice(0, 80)}`
          }).join("  |  ")
        : ""
      return `${relativeTime(e.createdAt).padEnd(10)}  ${e.type.padEnd(24)}  ${summary}`
    })

    const header = `${"Time".padEnd(10)}  ${"Type".padEnd(24)}  Summary`
    const separator = "-".repeat(Math.min(process.stdout.columns ?? 80, 120))
    const content = [
      gumStyle(`Task ${task.id.slice(0, 8)} — ${task.title}`, { fg: C.bright, bold: true }),
      separator,
      header,
      separator,
      ...lines,
    ].join("\n")

    gumPager(content)
  } finally {
    db.close()
  }
}

async function cmdBoot(projectDir?: string): Promise<void> {
  const dir = projectDir ?? process.cwd()
  print(gumStyle(`Generating boot artifact for ${dir}...`, { fg: C.muted }))
  const outPath = await generateBoot(dir)
  print(gumStyle(`Boot artifact written to ${outPath}`, { fg: C.green, bold: true }))
}

async function cmdCloseout(projectDir?: string): Promise<void> {
  const dir = projectDir ?? process.cwd()
  const { valid, errors } = await validateCloseout(dir)

  if (!valid) {
    print(gumStyle("Closeout validation failed:", { fg: C.red, bold: true }))
    for (const err of errors) {
      print(gumStyle(`  ${err}`, { fg: C.red }))
    }
    process.exit(1)
  }

  print(gumStyle("Closeout valid.", { fg: C.green, bold: true }))
  const archivePath = await archiveCloseout(dir)
  print(gumStyle(`Archived to ${archivePath}`, { fg: C.muted }))
}

// ── Header banner ─────────────────────────────────────────

function printBanner(): void {
  const banner = gumStyle("harness", {
    fg: C.bright,
    bold: true,
    border: "double",
    padding: "0 4",
    margin: "0 1",
  })
  print(banner)
  print(gumStyle("autonomous agent orchestrator", { fg: C.muted }))
  print("")
}

// ── Interactive TUI loop ──────────────────────────────────

const MENU_OPTIONS = [
  "Run a task",
  "View tasks",
  "View memories",
  "Task history",
  "Generate boot artifact",
  "Validate closeout",
  "Quit",
]

async function tui(): Promise<void> {
  // Clear and print banner once at start
  process.stdout.write("\x1b[2J\x1b[H") // clear screen
  printBanner()

  while (true) {
    const choice = gumChoose(MENU_OPTIONS, "What would you like to do?")

    if (!choice || choice === "Quit") {
      print(gumStyle("bye!", { fg: C.muted }))
      process.exit(0)
    }

    print("") // breathe before each screen

    switch (choice) {
      case "Run a task":
        await screenRunTask()
        break
      case "View tasks":
        screenViewTasks()
        break
      case "View memories":
        screenViewMemories()
        break
      case "Task history":
        screenTaskHistory()
        break
      case "Generate boot artifact":
        await screenBoot()
        break
      case "Validate closeout":
        await screenCloseout()
        break
    }

    // Clear and re-print banner before next menu iteration
    process.stdout.write("\x1b[2J\x1b[H")
    printBanner()
  }
}

// ── Non-interactive commands (scripting / mise tasks) ─────

async function cmdRun(objective: string): Promise<void> {
  const db = getDb()
  try {
    const taskId = crypto.randomUUID()
    const ts = new Date().toISOString()

    db.createTask({
      id: taskId,
      title: objective.slice(0, 80),
      objective,
      status: "queued",
      priority: 0,
      createdAt: ts,
      updatedAt: ts,
    })

    print(gumStyle(`Task ${taskId.slice(0, 8)}`, { fg: C.muted }))
    print(gumStyle(objective, { fg: C.bright, bold: true }))
    print("")
    print(gumStyle("Running...", { fg: C.muted }))

    const adapters = createAdapters()
    const validator = new Validator()
    const supervisor = new Supervisor(db, adapters, validator)

    await supervisor.runTask(taskId)

    const task = db.getTask(taskId)
    const events = db.listEventsByTask(taskId)

    if (task) {
      print("")
      print(gumStyle(`Status: ${task.status.toUpperCase()}`, { fg: statusColor(task.status), bold: true }))
    }

    const completion = events.find((e) => e.type === "run_completed")
    if (completion?.payload?.summary) {
      print(gumStyle(String(completion.payload.summary), { fg: C.text }))
    }

    const failure = events.find((e) => e.type === "error" || e.type === "validation_failed")
    if (failure?.payload) {
      const msg = failure.payload.message ?? failure.payload.errors
      print(gumStyle(`Error: ${typeof msg === "string" ? msg : JSON.stringify(msg)}`, { fg: C.red }))
    }
  } finally {
    db.close()
  }
}

function cmdTasks(): void {
  const db = getDb()
  try {
    const tasks = getAllTasks(db)
    if (tasks.length === 0) {
      print(gumStyle("No tasks.", { fg: C.muted }))
      return
    }
    const rows = tasks.map((t) => [
      t.id.slice(0, 8),
      t.title.slice(0, 48),
      t.status,
      String(t.priority),
      relativeTime(t.updatedAt),
    ])
    gumTable(rows, ["ID", "Title", "Status", "Priority", "Updated"])
  } finally {
    db.close()
  }
}

function cmdStatus(taskId?: string): void {
  const db = getDb()
  try {
    let task
    if (taskId) {
      task = db.getTask(taskId)
      if (!task) {
        const match = getAllTasks(db).find((t) => t.id.startsWith(taskId))
        if (!match) {
          print(gumStyle(`Task not found: ${taskId}`, { fg: C.red }))
          process.exit(1)
        }
        task = match
      }
    } else {
      const tasks = getAllTasks(db)
      if (tasks.length === 0) {
        print(gumStyle("No tasks.", { fg: C.muted }))
        return
      }
      task = tasks[tasks.length - 1]
    }

    const color = statusColor(task.status)
    const lines = [
      gumStyle(`ID       ${task.id.slice(0, 8)}`, { fg: C.muted }),
      gumStyle(`Title    ${task.title}`, { fg: C.bright, bold: true }),
      gumStyle(`Status   ${task.status.toUpperCase()}`, { fg: color, bold: true }),
      gumStyle(`Created  ${relativeTime(task.createdAt)}`, { fg: C.text }),
      gumStyle(`Updated  ${relativeTime(task.updatedAt)}`, { fg: C.text }),
    ]
    if (task.parentTaskId) {
      lines.push(gumStyle(`Parent   ${task.parentTaskId.slice(0, 8)}`, { fg: C.muted }))
    }
    lines.push(gumStyle(`\n${task.objective}`, { fg: C.text }))

    spawnSync(GUM, [
      "style",
      "--border", "rounded",
      "--border.foreground", C.accent1,
      "--padding", "1 2",
      "--margin", "0 1",
      lines.join("\n"),
    ], { encoding: "utf8", stdio: ["inherit", "inherit", "inherit"] })
  } finally {
    db.close()
  }
}

function cmdMemory(scope?: string): void {
  const db = getDb()
  try {
    const kinds = ["semantic", "procedural", "episodic"] as const
    const scopes = scope
      ? [scope as "global" | "repo" | "branch" | "task" | "user"]
      : (["global", "repo", "branch", "task", "user"] as const)

    const rows: string[][] = []
    for (const kind of kinds) {
      for (const s of scopes) {
        for (const m of db.listMemories(kind, s)) {
          rows.push([
            m.kind,
            m.scope,
            m.confidence.toFixed(2),
            m.text.slice(0, 60) + (m.text.length > 60 ? "…" : ""),
          ])
        }
      }
    }

    if (rows.length === 0) {
      print(gumStyle(scope ? `No memories in scope "${scope}".` : "No memories.", { fg: C.muted }))
      return
    }

    gumTable(rows, ["Kind", "Scope", "Confidence", "Text"])
  } finally {
    db.close()
  }
}

function cmdHistory(taskId: string): void {
  const db = getDb()
  try {
    let resolvedId = taskId
    if (!db.getTask(taskId)) {
      const match = getAllTasks(db).find((t) => t.id.startsWith(taskId))
      if (!match) {
        print(gumStyle(`Task not found: ${taskId}`, { fg: C.red }))
        process.exit(1)
      }
      resolvedId = match.id
    }

    const events = db.listEventsByTask(resolvedId)
    if (events.length === 0) {
      print(gumStyle(`No events for task ${resolvedId.slice(0, 8)}.`, { fg: C.muted }))
      return
    }

    const rows = events.map((e) => {
      const payloadKeys = Object.keys(e.payload)
      const summary = payloadKeys.length > 0
        ? payloadKeys.map((k) => {
            const v = e.payload[k]
            const s = typeof v === "string" ? v : JSON.stringify(v)
            return `${k}: ${s.slice(0, 60)}`
          }).join(" | ")
        : ""
      return [relativeTime(e.createdAt), e.type, summary.slice(0, 72)]
    })

    gumTable(rows, ["Time", "Type", "Summary"])
  } finally {
    db.close()
  }
}

// ── Main ──────────────────────────────────────────────────

const args = process.argv.slice(2)
const command = args[0]

// No args → interactive TUI
if (!command) {
  tui().catch((err) => {
    process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  })
} else {
  // Args present → non-interactive, for scripting/mise tasks
  switch (command) {
    case "run": {
      let objective = args.slice(1).join(" ")
      if (!objective) {
        objective = gumInput("What should I do?")
      }
      if (!objective) {
        print(gumStyle("No objective provided.", { fg: C.muted }))
        process.exit(1)
      }
      cmdRun(objective).catch((err) => {
        print(gumStyle(`Error: ${err instanceof Error ? err.message : String(err)}`, { fg: C.red }))
        process.exit(1)
      })
      break
    }

    case "status":
      cmdStatus(args[1])
      break

    case "tasks":
      cmdTasks()
      break

    case "memory":
      cmdMemory(args[1])
      break

    case "history": {
      if (!args[1]) {
        print(gumStyle("Usage: harness history <taskId>", { fg: C.muted }))
        process.exit(1)
      }
      cmdHistory(args[1])
      break
    }

    case "boot":
      cmdBoot(args[1]).catch((err) => {
        print(gumStyle(`Error: ${err instanceof Error ? err.message : String(err)}`, { fg: C.red }))
        process.exit(1)
      })
      break

    case "closeout":
      cmdCloseout(args[1]).catch((err) => {
        print(gumStyle(`Error: ${err instanceof Error ? err.message : String(err)}`, { fg: C.red }))
        process.exit(1)
      })
      break

    case "--help":
    case "-h":
    case "help":
      print(gumStyle("harness", { fg: C.bright, bold: true, border: "double", padding: "0 2" }))
      print("")
      print(gumStyle("USAGE", { fg: C.accent1, bold: true }))
      print(gumStyle("  harness               launch interactive TUI", { fg: C.text }))
      print(gumStyle("  harness run <task>     run a task directly", { fg: C.text }))
      print(gumStyle("  harness tasks          list all tasks", { fg: C.text }))
      print(gumStyle("  harness status [id]    show task status", { fg: C.text }))
      print(gumStyle("  harness memory [scope] list memories", { fg: C.text }))
      print(gumStyle("  harness history <id>   show task event log", { fg: C.text }))
      print(gumStyle("  harness boot [dir]      generate .harness/boot.md for project dir", { fg: C.text }))
      print(gumStyle("  harness closeout [dir]   validate + archive .harness/closeout.md", { fg: C.text }))
      break

    default:
      print(gumStyle(`Unknown command: ${command}`, { fg: C.red }))
      print(gumStyle("Run harness --help for usage.", { fg: C.muted }))
      process.exit(1)
  }
}
