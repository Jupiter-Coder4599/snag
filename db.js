// On-device SQLite database. Nothing here leaves the phone.
import * as SQLite from 'expo-sqlite';

const db = SQLite.openDatabaseSync('snag.db');

db.execSync(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    site TEXT DEFAULT 'instagram',
    code TEXT NOT NULL,
    url TEXT NOT NULL,
    status TEXT NOT NULL,
    total INTEGER DEFAULT 0,
    done INTEGER DEFAULT 0,
    username TEXT,
    error TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS videos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT,
    site TEXT DEFAULT 'instagram',
    kind TEXT DEFAULT 'video',
    saved_at INTEGER NOT NULL,
    account TEXT,
    post_url TEXT NOT NULL,
    post_code TEXT NOT NULL,
    video_host TEXT,
    trusted INTEGER NOT NULL,
    file_name TEXT,
    asset_id TEXT,
    status TEXT NOT NULL
  );
`);

// Older installs: add columns that newer versions use.
function addColumn(table, column, definition) {
  const cols = db.getAllSync(`PRAGMA table_info(${table})`).map((c) => c.name);
  if (!cols.includes(column)) db.execSync(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
addColumn('jobs', 'site', "TEXT DEFAULT 'instagram'");
addColumn('videos', 'site', "TEXT DEFAULT 'instagram'");
addColumn('videos', 'kind', "TEXT DEFAULT 'video'");

// ---------- download queue ----------

export function loadJobs() {
  return db.getAllSync('SELECT * FROM jobs ORDER BY created_at DESC LIMIT 200').map((r) => ({
    id: r.id,
    site: r.site || 'instagram',
    code: r.code,
    url: r.url,
    // Anything that was mid-download when the app closed starts over.
    status: r.status === 'finding' || r.status === 'saving' ? 'queued' : r.status,
    total: r.total || 0,
    done: r.done || 0,
    username: r.username,
    error: r.error,
    createdAt: r.created_at,
  }));
}

export function saveJobs(jobs) {
  db.withTransactionSync(() => {
    db.runSync('DELETE FROM jobs');
    for (const j of jobs.slice(0, 200)) {
      db.runSync(
        'INSERT INTO jobs (id, site, code, url, status, total, done, username, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [j.id, j.site || 'instagram', j.code, j.url, j.status, j.total || 0, j.done || 0, j.username ?? null, j.error ?? null, j.createdAt]
      );
    }
  });
}

// ---------- saved media (photos and videos) ----------

// status: 'saved' | 'blocked' | 'removed'
export function addVideo(v) {
  const res = db.runSync(
    `INSERT INTO videos (job_id, site, kind, saved_at, account, post_url, post_code, video_host, trusted, file_name, asset_id, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      v.jobId,
      v.site || 'instagram',
      v.kind || 'video',
      Date.now(),
      v.account ?? null,
      v.postUrl,
      v.postCode,
      v.videoHost ?? null,
      v.trusted ? 1 : 0,
      v.fileName ?? null,
      v.assetId ?? null,
      v.status,
    ]
  );
  return res.lastInsertRowId;
}

export function listVideos() {
  return db.getAllSync('SELECT * FROM videos ORDER BY saved_at DESC LIMIT 300');
}

export function setVideoStatus(id, status) {
  db.runSync('UPDATE videos SET status = ? WHERE id = ?', [status, id]);
}

export function deleteVideoRow(id) {
  db.runSync('DELETE FROM videos WHERE id = ?', [id]);
}
