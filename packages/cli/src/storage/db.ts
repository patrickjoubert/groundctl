import initSqlJs, { type Database } from "sql.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { applySchema } from "./schema.js";

const GLOBAL_DIR = join(homedir(), ".groundctl");
const GLOBAL_DB_PATH = join(GLOBAL_DIR, "db.sqlite");

let _db: Database | null = null;
let _dbPath: string = GLOBAL_DB_PATH;
let _groundctlDir: string = GLOBAL_DIR;

/**
 * Find the project-local .groundctl directory by walking up from cwd.
 * Returns the path to .groundctl/ if found alongside a .git/, otherwise null.
 */
function findProjectDir(startDir?: string): string | null {
  let dir = startDir ?? process.cwd();
  const root = dirname(dir); // stop at filesystem root

  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, ".groundctl"))) {
      return join(dir, ".groundctl");
    }
    // If there's a .git here but no .groundctl, this is a candidate
    if (existsSync(join(dir, ".git"))) {
      return join(dir, ".groundctl");
    }
    const parent = dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }

  return null;
}

export function getDbPath(): string {
  return _dbPath;
}

export function getGroundctlDir(): string {
  return _groundctlDir;
}

export async function openDb(explicitPath?: string): Promise<Database> {
  if (_db) return _db;

  let dbPath: string;

  if (explicitPath) {
    dbPath = explicitPath;
  } else {
    const projectDir = findProjectDir();
    if (projectDir) {
      _groundctlDir = projectDir;
      dbPath = join(projectDir, "db.sqlite");
    } else {
      _groundctlDir = GLOBAL_DIR;
      dbPath = GLOBAL_DB_PATH;
    }
  }

  _dbPath = dbPath;
  const dir = dirname(dbPath);

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const SQL = await initSqlJs();

  if (existsSync(dbPath)) {
    const buffer = readFileSync(dbPath);
    _db = new SQL.Database(buffer);
  } else {
    _db = new SQL.Database();
  }

  _db.run("PRAGMA journal_mode = WAL");
  _db.run("PRAGMA busy_timeout = 5000");
  applySchema(_db);
  saveDb();

  return _db;
}

export function saveDb(): void {
  if (!_db) return;
  const data = _db.export();
  const buffer = Buffer.from(data);
  const dir = dirname(_dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(_dbPath, buffer);
}

export function closeDb(): void {
  if (_db) {
    saveDb();
    _db.close();
    _db = null;
  }
}
