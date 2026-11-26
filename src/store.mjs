// 持久化存储层：Node 24 内置 node:sqlite
// 表：sessions, messages, jobs(索引), tasks, task_steps, evidence, tickets, ticket_events
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const DB_PATH = process.env.DB_PATH || path.resolve('data/workbench.db');

let db = null;

export function getDB() {
  if (db) return db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL;');
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT DEFAULT '新会话',
      owner TEXT,
      pinned INTEGER DEFAULT 0,
      archived INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT,
      reasoning_content TEXT,
      tool_calls TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_msg_session ON messages(session_id);

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT DEFAULT 'running',
      session_id TEXT,
      owner TEXT,
      days INTEGER DEFAULT 7,
      conclusion TEXT,
      error TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      finished_at TEXT
    );

    CREATE TABLE IF NOT EXISTS task_steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      seq INTEGER,
      type TEXT,
      name TEXT,
      result TEXT,
      evidence_id TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_step_task ON task_steps(task_id);

    CREATE TABLE IF NOT EXISTS evidence (
      id TEXT PRIMARY KEY,
      task_id TEXT,
      session_id TEXT,
      owner TEXT,
      job_ids TEXT,
      tool_name TEXT,
      query TEXT,
      window TEXT,
      source TEXT,
      data_collected_at TEXT,
      key_fields TEXT,
      calculation TEXT,
      conclusion TEXT,
      kind TEXT DEFAULT 'fact',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_ev_task ON evidence(task_id);

    CREATE TABLE IF NOT EXISTS tickets (
      id TEXT PRIMARY KEY,
      action TEXT NOT NULL,
      job_id INTEGER,
      reason TEXT,
      status TEXT DEFAULT 'pending',
      owner TEXT,
      task_id TEXT,
      session_id TEXT,
      evidence_id TEXT,
      conclusion TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_tk_status ON tickets(status);

    CREATE TABLE IF NOT EXISTS ticket_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id TEXT NOT NULL,
      event TEXT NOT NULL,
      note TEXT,
      actor TEXT DEFAULT 'user',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_tev_ticket ON ticket_events(ticket_id);
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS login_sessions (
      sid TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      hpc_token TEXT NOT NULL,
      token_exp INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  // 个人模型配置（API Key 加密存储）
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_llm_config (
      owner TEXT PRIMARY KEY,
      base_url TEXT,
      api_key_enc TEXT,
      model TEXT,
      version INTEGER DEFAULT 1,
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);
  // 兼容旧库
  try { db.exec('ALTER TABLE sessions ADD COLUMN pinned INTEGER DEFAULT 0'); } catch {}
  try { db.exec('ALTER TABLE sessions ADD COLUMN archived INTEGER DEFAULT 0'); } catch {}
  try { db.exec('ALTER TABLE sessions ADD COLUMN owner TEXT'); } catch {}
  try { db.exec('ALTER TABLE tasks ADD COLUMN owner TEXT'); } catch {}
  try { db.exec('ALTER TABLE evidence ADD COLUMN owner TEXT'); } catch {}
  try { db.exec('ALTER TABLE tickets ADD COLUMN owner TEXT'); } catch {}
  try { db.exec('ALTER TABLE messages ADD COLUMN suggest TEXT'); } catch {}

  // 首次导入：从 data/sessions/*.json 导入旧会话
  importLegacySessions(db);
  // 首次导入：从 data/tickets/tickets.jsonl 导入旧工单
  importLegacyTickets(db);
}

function importLegacySessions(db) {
  const dir = path.resolve('data/sessions');
  if (!fs.existsSync(dir)) return;
  const count = db.prepare('SELECT COUNT(*) as c FROM sessions').get().c;
  if (count > 0) return; // 已导入过
  const insS = db.prepare('INSERT OR IGNORE INTO sessions (id, title, updated_at) VALUES (?,?,?)');
  const insM = db.prepare('INSERT INTO messages (session_id, role, content, reasoning_content) VALUES (?,?,?,?)');
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
    const id = f.replace('.json', '');
    try {
      const hist = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (!Array.isArray(hist) || !hist.length) continue;
      const lastUser = [...hist].reverse().find(m => m.role === 'user');
      const title = (lastUser?.content || '新会话').slice(0, 30);
      const mtime = fs.statSync(path.join(dir, f)).mtime.toISOString().slice(0, 19).replace('T', ' ');
      insS.run(id, title, mtime);
      for (const m of hist) {
        insM.run(id, m.role, m.content || '', m.reasoning_content || null, m.tool_calls ? JSON.stringify(m.tool_calls) : null);
      }
    } catch {}
  }
}

function importLegacyTickets(db) {
  const fp = path.resolve('data/tickets/tickets.jsonl');
  if (!fs.existsSync(fp)) return;
  const count = db.prepare('SELECT COUNT(*) as c FROM tickets').get().c;
  if (count > 0) return;
  const ins = db.prepare('INSERT OR IGNORE INTO tickets (id, action, job_id, reason, status, created_at) VALUES (?,?,?,?,?,?)');
  const insEv = db.prepare('INSERT INTO ticket_events (ticket_id, event, note) VALUES (?,?,?)');
  for (const line of fs.readFileSync(fp, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const t = JSON.parse(line);
      if (!t.工单号) continue;
      const statusMap = { '待人工确认': 'pending', '处理中': 'in_progress', '已完成': 'resolved', '已取消': 'cancelled' };
      ins.run(t.工单号, t.操作 || 'unknown', t.目标作业 || null, t.依据 || '', statusMap[t.状态] || 'pending',
        (t.生成时间 || '').replace(/\//g, '-').slice(0, 19) || null);
      insEv.run(t.工单号, 'created', t.依据 || '');
    } catch {}
  }
}

// ===== 会话 =====
export function listSessions({ q, limit = 50, owner } = {}) {
  const db = getDB();
  // owner 未传 → 不按用户过滤（兼容）；传了 → 只返回该用户会话（未归属历史不出现）
  const where = owner != null ? 'WHERE s.owner = ?' : '';
  const base = owner != null ? [owner] : [];
  const order = `ORDER BY s.pinned DESC, s.updated_at DESC LIMIT ?`;
  let rows;
  if (q) {
    rows = db.prepare(`SELECT s.*, m.preview FROM sessions s
      LEFT JOIN (SELECT session_id, content as preview, ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY id DESC) rn FROM messages WHERE role='user') m
      ON m.session_id = s.id AND m.rn = 1
      ${where} AND (s.title LIKE ? OR m.preview LIKE ?) ${order}`).all(...base, `%${q}%`, `%${q}%`, limit);
  } else {
    rows = db.prepare(`SELECT s.*, m.preview FROM sessions s
      LEFT JOIN (SELECT session_id, content as preview, ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY id DESC) rn FROM messages WHERE role='user') m
      ON m.session_id = s.id AND m.rn = 1
      ${where} ${order}`).all(...base, limit);
  }
  return rows;
}

// 校验会话归属：返回会话，不属于该 owner（或 owner 为 null 时要求会话无归属）则 null
export function getSession(id) {
  const db = getDB();
  const s = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
  if (!s) return null;
  s.messages = db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY id').all(id);
  return s;
}
// 只取会话元信息（不带消息），用于快速归属校验
export function getSessionMeta(id) {
  const db = getDB();
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) || null;
}

export function createSession(title = '新会话', owner = null) {
  const db = getDB();
  const id = 's-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  db.prepare('INSERT INTO sessions (id, title, owner) VALUES (?,?,?)').run(id, title, owner);
  return id;
}

export function renameSession(id, title) {
  const db = getDB();
  db.prepare(`UPDATE sessions SET title=?, updated_at=datetime('now') WHERE id=?`).run(title, id);
}

export function updateSession(id, fields) {
  const db = getDB();
  const sets = [];
  const vals = [];
  if (fields.title != null) { sets.push('title=?'); vals.push(fields.title); }
  if (fields.pinned != null) { sets.push('pinned=?'); vals.push(fields.pinned ? 1 : 0); }
  if (fields.archived != null) { sets.push('archived=?'); vals.push(fields.archived ? 1 : 0); }
  if (!sets.length) return;
  sets.push("updated_at=datetime('now')");
  vals.push(id);
  db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id=?`).run(...vals);
}

export function deleteSession(id) {
  const db = getDB();
  db.prepare('DELETE FROM messages WHERE session_id=?').run(id);
  db.prepare('DELETE FROM sessions WHERE id=?').run(id);
}

export function addMessage(sessionId, role, content, { reasoning, toolCalls, suggest } = {}) {
  const db = getDB();
  db.prepare('INSERT INTO messages (session_id, role, content, reasoning_content, tool_calls, suggest) VALUES (?,?,?,?,?,?)')
    .run(sessionId, role, content || '', reasoning || null, toolCalls ? JSON.stringify(toolCalls) : null, suggest ? JSON.stringify(suggest) : null);
  db.prepare(`UPDATE sessions SET updated_at=datetime('now') WHERE id=?`).run(sessionId);
}

export function getSessionHistory(sessionId) {
  const db = getDB();
  return db.prepare('SELECT role, content, reasoning_content, tool_calls, suggest FROM messages WHERE session_id=? ORDER BY id').all(sessionId)
    .map(m => {
      const o = { role: m.role, content: m.content || '' };
      if (m.reasoning_content) o.reasoning_content = m.reasoning_content;
      if (m.tool_calls) { try { o.tool_calls = JSON.parse(m.tool_calls); } catch {} }
      if (m.suggest) { try { o.suggest = JSON.parse(m.suggest); } catch {} }
      return o;
    });
}

// ===== 登录会话（服务端存储 HPC token）=====
export function createLoginSession({ sid, username, hpc_token, token_exp }) {
  const db = getDB();
  db.prepare('INSERT OR REPLACE INTO login_sessions (sid, username, hpc_token, token_exp) VALUES (?,?,?,?)')
    .run(sid, username, hpc_token, token_exp);
}

export function getLoginSession(sid) {
  const db = getDB();
  return db.prepare('SELECT * FROM login_sessions WHERE sid=?').get(sid) || null;
}

export function deleteLoginSession(sid) {
  const db = getDB();
  db.prepare('DELETE FROM login_sessions WHERE sid=?').run(sid);
}

// ===== 个人模型配置 =====
// 存储加密后的 api_key_enc；读取时返回密文（不还原），由 server 层解密后使用
export function getUserLlmConfig(owner) {
  const db = getDB();
  return db.prepare('SELECT * FROM user_llm_config WHERE owner=?').get(owner) || null;
}
export function saveUserLlmConfig({ owner, baseUrl, apiKeyEnc, model, version }) {
  const db = getDB();
  db.prepare(`INSERT OR REPLACE INTO user_llm_config (owner, base_url, api_key_enc, model, version, updated_at)
              VALUES (?,?,?,?,?,datetime('now'))`)
    .run(owner, baseUrl || null, apiKeyEnc || null, model || null, version || 1);
}

// ===== 分析任务 =====
export function createTask({ id, title, sessionId, days, owner }) {
  const db = getDB();
  db.prepare('INSERT OR REPLACE INTO tasks (id, title, session_id, owner, days, status) VALUES (?,?,?,?,?,?)')
    .run(id, title, sessionId || null, owner || null, days || 7, 'running');
}

export function listTasks({ status, owner } = {}) {
  const db = getDB();
  // owner 未传 → 不过滤（兼容）；传了 → 只返回该用户任务
  if (status && owner != null) return db.prepare('SELECT * FROM tasks WHERE status=? AND owner=? ORDER BY created_at DESC').all(status, owner);
  if (owner != null) return db.prepare('SELECT * FROM tasks WHERE owner=? ORDER BY created_at DESC LIMIT 100').all(owner);
  if (status) return db.prepare('SELECT * FROM tasks WHERE status=? ORDER BY created_at DESC').all(status);
  return db.prepare('SELECT * FROM tasks ORDER BY created_at DESC LIMIT 100').all();
}

export function getTask(id) {
  const db = getDB();
  const t = db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
  if (!t) return null;
  t.steps = db.prepare('SELECT * FROM task_steps WHERE task_id=? ORDER BY seq').all(id);
  t.evidence = db.prepare('SELECT * FROM evidence WHERE task_id=? ORDER BY created_at').all(id);
  return t;
}

export function updateTask(id, fields) {
  const db = getDB();
  const sets = Object.keys(fields).map(k => `${k}=?`);
  if (sets.length) db.prepare(`UPDATE tasks SET ${sets.join(',')} WHERE id=?`).run(...Object.values(fields), id);
}

export function addTaskStep(taskId, seq, type, name, result, evidenceId) {
  const db = getDB();
  db.prepare('INSERT INTO task_steps (task_id, seq, type, name, result, evidence_id) VALUES (?,?,?,?,?,?)')
    .run(taskId, seq, type, name, result || null, evidenceId || null);
}

export function deleteTask(id) {
  const db = getDB();
  db.prepare('DELETE FROM task_steps WHERE task_id=?').run(id);
  db.prepare('DELETE FROM evidence WHERE task_id=?').run(id);
  db.prepare('DELETE FROM tasks WHERE id=?').run(id);
}

// ===== 证据 =====
export function createEvidence(fields) {
  const db = getDB();
  const id = 'E' + Date.now().toString(36).toUpperCase() + Math.floor(Math.random() * 100);
  db.prepare(`INSERT INTO evidence (id, task_id, session_id, owner, job_ids, tool_name, query, window, source, data_collected_at, key_fields, calculation, conclusion, kind)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, fields.taskId || null, fields.sessionId || null, fields.owner || null, fields.jobIds || null, fields.toolName || '',
      fields.query || '', fields.window || '', fields.source || 'local-cache',
      fields.dataCollectedAt || null, fields.keyFields || null, fields.calculation || null,
      fields.conclusion || '', fields.kind || 'fact');
  return id;
}

export function getEvidence(id) {
  return getDB().prepare('SELECT * FROM evidence WHERE id=?').get(id) || null;
}

export function listEvidence({ taskId, sessionId, owner } = {}) {
  const db = getDB();
  if (taskId) return db.prepare('SELECT * FROM evidence WHERE task_id=? ORDER BY created_at').all(taskId);
  if (sessionId) return db.prepare('SELECT * FROM evidence WHERE session_id=? ORDER BY created_at').all(sessionId);
  if (owner != null) return db.prepare('SELECT * FROM evidence WHERE owner=? ORDER BY created_at DESC LIMIT 100').all(owner);
  return db.prepare('SELECT * FROM evidence ORDER BY created_at DESC LIMIT 100').all();
}

// ===== 工单 =====
export function createTicket({ id, action, jobId, reason, status, owner, taskId, sessionId, evidenceId, conclusion }) {
  const db = getDB();
  db.prepare(`INSERT OR REPLACE INTO tickets (id, action, job_id, reason, status, owner, task_id, session_id, evidence_id, conclusion)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, action, jobId || null, reason || '', status || 'pending',
    owner || null, taskId || null, sessionId || null, evidenceId || null, conclusion || null);
  // 创建事件的操作者由服务端当前身份填写
  db.prepare('INSERT INTO ticket_events (ticket_id, event, note, actor) VALUES (?,?,?,?)').run(id, 'created', reason || '', owner || 'system');
  return id;
}

export function listTickets({ status, q, owner, limit = 50 } = {}) {
  const db = getDB();
  let sql = 'SELECT * FROM tickets WHERE 1=1', params = [];
  if (owner != null) { sql += ' AND owner=?'; params.push(owner); }
  if (status) { sql += ' AND status=?'; params.push(status); }
  if (q) { sql += ' AND (id LIKE ? OR reason LIKE ?)'; params.push(`%${q}%`, `%${q}%`); }
  sql += ' ORDER BY updated_at DESC LIMIT ?'; params.push(limit);
  return db.prepare(sql).all(...params);
}

export function getTicket(id) {
  const db = getDB();
  const t = db.prepare('SELECT * FROM tickets WHERE id=?').get(id);
  if (!t) return null;
  t.events = db.prepare('SELECT * FROM ticket_events WHERE ticket_id=? ORDER BY created_at').all(id);
  return t;
}

export function updateTicket(id, { status, note, actor = 'user' }) {
  const db = getDB();
  if (status) db.prepare(`UPDATE tickets SET status=?, updated_at=datetime('now') WHERE id=?`).run(status, id);
  // actor 由服务端当前身份传入，不再信任前端
  db.prepare('INSERT INTO ticket_events (ticket_id, event, note, actor) VALUES (?,?,?,?)').run(id, status ? `status→${status}` : 'note', note || '', actor || 'user');
}

export function deleteTicket(id) {
  const db = getDB();
  db.prepare('DELETE FROM ticket_events WHERE ticket_id=?').run(id);
  db.prepare('DELETE FROM tickets WHERE id=?').run(id);
}

// ===== 启动时标记中断任务 =====
export function markInterruptedTasks() {
  const db = getDB();
  db.prepare(`UPDATE tasks SET status='interrupted', error='服务重启，任务被中断' WHERE status='running'`).run();
}
