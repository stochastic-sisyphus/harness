import Database from "better-sqlite3"
import type { Task, Event, Artifact, Memory } from "./types.js"

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    parentTaskId TEXT,
    title TEXT NOT NULL,
    objective TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    priority INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL,
    FOREIGN KEY (parentTaskId) REFERENCES tasks(id)
  );

  CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
  CREATE INDEX IF NOT EXISTS idx_tasks_parentTaskId ON tasks(parentTaskId);

  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    taskId TEXT NOT NULL,
    runId TEXT,
    type TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    createdAt TEXT NOT NULL,
    FOREIGN KEY (taskId) REFERENCES tasks(id)
  );

  CREATE INDEX IF NOT EXISTS idx_events_taskId ON events(taskId);

  CREATE TABLE IF NOT EXISTS artifacts (
    id TEXT PRIMARY KEY,
    taskId TEXT NOT NULL,
    runId TEXT,
    kind TEXT NOT NULL,
    uri TEXT NOT NULL,
    hash TEXT,
    summary TEXT NOT NULL,
    metadata TEXT NOT NULL DEFAULT '{}',
    createdAt TEXT NOT NULL,
    FOREIGN KEY (taskId) REFERENCES tasks(id)
  );

  CREATE INDEX IF NOT EXISTS idx_artifacts_taskId ON artifacts(taskId);

  CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    scope TEXT NOT NULL,
    text TEXT NOT NULL,
    embedding TEXT,
    sourceTaskId TEXT,
    sourceArtifactId TEXT,
    confidence REAL NOT NULL DEFAULT 1.0,
    freshness REAL NOT NULL DEFAULT 1.0,
    createdAt TEXT NOT NULL,
    lastUsedAt TEXT,
    FOREIGN KEY (sourceTaskId) REFERENCES tasks(id),
    FOREIGN KEY (sourceArtifactId) REFERENCES artifacts(id)
  );

  CREATE INDEX IF NOT EXISTS idx_memories_kind_scope ON memories(kind, scope);
`

export function initDb(path: string): Db {
  const db = new Database(path)
  db.pragma("journal_mode = WAL")
  db.pragma("foreign_keys = ON")
  db.exec(SCHEMA)
  return new Db(db)
}

export class Db {
  private db: Database.Database

  private stmts: {
    insertTask: Database.Statement
    getTask: Database.Statement
    listTasksByStatus: Database.Statement
    listSubtasks: Database.Statement
    updateTaskStatus: Database.Statement
    updateTask: Database.Statement

    insertEvent: Database.Statement
    listEventsByTask: Database.Statement

    insertArtifact: Database.Statement
    getArtifact: Database.Statement
    listArtifactsByTask: Database.Statement

    insertMemory: Database.Statement
    getMemory: Database.Statement
    listMemories: Database.Statement
    touchMemory: Database.Statement
  }

  constructor(db: Database.Database) {
    this.db = db

    this.stmts = {
      insertTask: db.prepare(`
        INSERT INTO tasks (id, parentTaskId, title, objective, status, priority, createdAt, updatedAt)
        VALUES (@id, @parentTaskId, @title, @objective, @status, @priority, @createdAt, @updatedAt)
      `),
      getTask: db.prepare("SELECT * FROM tasks WHERE id = ?"),
      listTasksByStatus: db.prepare("SELECT * FROM tasks WHERE status = ? ORDER BY priority DESC"),
      listSubtasks: db.prepare("SELECT * FROM tasks WHERE parentTaskId = ? ORDER BY priority DESC"),
      updateTaskStatus: db.prepare("UPDATE tasks SET status = ?, updatedAt = ? WHERE id = ?"),
      updateTask: db.prepare(`
        UPDATE tasks SET title = @title, objective = @objective, status = @status,
        priority = @priority, updatedAt = @updatedAt WHERE id = @id
      `),

      insertEvent: db.prepare(`
        INSERT INTO events (id, taskId, runId, type, payload, createdAt)
        VALUES (@id, @taskId, @runId, @type, @payload, @createdAt)
      `),
      listEventsByTask: db.prepare("SELECT * FROM events WHERE taskId = ? ORDER BY createdAt ASC"),

      insertArtifact: db.prepare(`
        INSERT INTO artifacts (id, taskId, runId, kind, uri, hash, summary, metadata, createdAt)
        VALUES (@id, @taskId, @runId, @kind, @uri, @hash, @summary, @metadata, @createdAt)
      `),
      getArtifact: db.prepare("SELECT * FROM artifacts WHERE id = ?"),
      listArtifactsByTask: db.prepare("SELECT * FROM artifacts WHERE taskId = ? ORDER BY createdAt ASC"),

      insertMemory: db.prepare(`
        INSERT INTO memories (id, kind, scope, text, embedding, sourceTaskId, sourceArtifactId, confidence, freshness, createdAt, lastUsedAt)
        VALUES (@id, @kind, @scope, @text, @embedding, @sourceTaskId, @sourceArtifactId, @confidence, @freshness, @createdAt, @lastUsedAt)
      `),
      getMemory: db.prepare("SELECT * FROM memories WHERE id = ?"),
      listMemories: db.prepare("SELECT * FROM memories WHERE kind = ? AND scope = ? ORDER BY confidence DESC"),
      touchMemory: db.prepare("UPDATE memories SET lastUsedAt = ? WHERE id = ?"),
    }
  }

  close(): void {
    this.db.close()
  }

  // Tasks

  createTask(task: Task): void {
    this.stmts.insertTask.run(task)
  }

  getTask(id: string): Task | undefined {
    return this.stmts.getTask.get(id) as Task | undefined
  }

  listTasksByStatus(status: Task["status"]): Task[] {
    return this.stmts.listTasksByStatus.all(status) as Task[]
  }

  listSubtasks(parentTaskId: string): Task[] {
    return this.stmts.listSubtasks.all(parentTaskId) as Task[]
  }

  updateTaskStatus(id: string, status: Task["status"]): void {
    this.stmts.updateTaskStatus.run(status, new Date().toISOString(), id)
  }

  updateTask(task: Pick<Task, "id" | "title" | "objective" | "status" | "priority">): void {
    this.stmts.updateTask.run({ ...task, updatedAt: new Date().toISOString() })
  }

  // Events

  createEvent(event: Event): void {
    this.stmts.insertEvent.run({
      ...event,
      payload: JSON.stringify(event.payload),
    })
  }

  listEventsByTask(taskId: string): Event[] {
    return (this.stmts.listEventsByTask.all(taskId) as Array<Event & { payload: string }>).map(
      (row) => ({ ...row, payload: JSON.parse(row.payload) })
    )
  }

  // Artifacts

  createArtifact(artifact: Artifact): void {
    this.stmts.insertArtifact.run({
      ...artifact,
      metadata: JSON.stringify(artifact.metadata),
    })
  }

  getArtifact(id: string): Artifact | undefined {
    const row = this.stmts.getArtifact.get(id) as (Artifact & { metadata: string }) | undefined
    if (!row) return undefined
    return { ...row, metadata: JSON.parse(row.metadata) }
  }

  listArtifactsByTask(taskId: string): Artifact[] {
    return (this.stmts.listArtifactsByTask.all(taskId) as Array<Artifact & { metadata: string }>).map(
      (row) => ({ ...row, metadata: JSON.parse(row.metadata) })
    )
  }

  // Memories

  createMemory(memory: Memory): void {
    this.stmts.insertMemory.run({
      ...memory,
      embedding: memory.embedding ? JSON.stringify(memory.embedding) : null,
    })
  }

  getMemory(id: string): Memory | undefined {
    const row = this.stmts.getMemory.get(id) as (Memory & { embedding: string | null }) | undefined
    if (!row) return undefined
    return { ...row, embedding: row.embedding ? JSON.parse(row.embedding) : undefined }
  }

  listMemories(kind: Memory["kind"], scope: Memory["scope"]): Memory[] {
    return (this.stmts.listMemories.all(kind, scope) as Array<Memory & { embedding: string | null }>).map(
      (row) => ({ ...row, embedding: row.embedding ? JSON.parse(row.embedding) : undefined })
    )
  }

  touchMemory(id: string): void {
    this.stmts.touchMemory.run(new Date().toISOString(), id)
  }
}
