'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const PORT = Number(process.env.PORT) || 3004;
const ROOT = path.join(__dirname, '..');
const DB_PATH = process.env.DB_PATH || path.join(ROOT, 'department_history.sqlite');
const SQLITE_BIN = process.env.SQLITE_BIN || 'sqlite3';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
};

const SQLITE_CSV_ROUTES = {
  '/dim_org_unit.csv': `
    SELECT
      unit_code,
      unit_name,
      unit_type,
      COALESCE(parent_unit_code, '') AS parent_code,
      CAST(is_temp_code AS TEXT) AS is_temp_code
    FROM curriculum_unit
    ORDER BY rowid;
  `,
  '/org_unit_relation.csv': `
    SELECT
      relation_id,
      change_year,
      COALESCE(prev_college_code, '') AS prev_college_code,
      COALESCE(prev_dept_code, '') AS prev_dept_code,
      COALESCE(prev_major_code, '') AS prev_major_code,
      COALESCE(after_college_code, '') AS after_college_code,
      COALESCE(after_dept_code, '') AS after_dept_code,
      COALESCE(after_major_code, '') AS after_major_code,
      change_type,
      COALESCE(valid_until, '') AS valid_until,
      COALESCE(note, '') AS note
    FROM v_org_unit_relation_legacy
    ORDER BY relation_id;
  `,
};

function serveSqliteCsv(urlPath, res) {
  const query = SQLITE_CSV_ROUTES[urlPath];
  if (!query || !fs.existsSync(DB_PATH)) {
    return false;
  }

  execFile(
    SQLITE_BIN,
    ['-header', '-csv', DB_PATH, query],
    { encoding: 'utf8' },
    (error, stdout, stderr) => {
      if (error) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(stderr || error.message || 'SQLite query failed');
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(stdout);
    }
  );

  return true;
}

function serveStaticFile(filePath, res) {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }

    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/' || urlPath === '') {
    urlPath = '/index.html';
  }

  if (serveSqliteCsv(urlPath, res)) {
    return;
  }

  const filePath = path.normalize(path.join(ROOT, urlPath));
  if (!filePath.startsWith(ROOT + path.sep) && filePath !== ROOT) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  serveStaticFile(filePath, res);
});

server.listen(PORT, '127.0.0.1', () => {
  const sourceLabel = fs.existsSync(DB_PATH) ? `SQLite: ${path.basename(DB_PATH)}` : 'static CSV files';
  console.log(`[편제변경이력] http://localhost:${PORT} (${sourceLabel})`);
});
