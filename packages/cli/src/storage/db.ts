import initSqlJs, { type Database } from "sql.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { applySchema } from "./schema.js";

const GROUNDCTL_DIR = join(homedir(), ".groundctl");
const DB_PATH = join(GROUNDCTL_DIR, "db.sqlite");

let _db: Database | null = null;
let _dbPath: string = DB_PATH;

export function getDbPath(): string {
  return _dbPath;
}

export function getGroundctlDir(): string {
  return GROUNDCTL_DIR;
}

export async function openDb(path?: string): Promise<Database> {
  if (_db) return _db;

  const dbPath = path ?? DB_PATH;
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
