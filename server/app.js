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

const CHANGE_TYPE_RULES = {
  created: { minPrev: 0, minAfter: 1 },
  closed: { minPrev: 1, minAfter: 0 },
  revised: { minPrev: 1, minAfter: 1 },
  renewed: { minPrev: 1, minAfter: 1 },
  merged: { minPrev: 1, minAfter: 1 },
  splitted: { minPrev: 1, minAfter: 1 },
};

function execSqlite(args, input) {
  return new Promise((resolve, reject) => {
    execFile(SQLITE_BIN, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message || 'SQLite command failed'));
        return;
      }
      resolve(stdout);
    }).stdin?.end(input);
  });
}

function execSqliteWithInput(args, input) {
  return new Promise((resolve, reject) => {
    const child = execFile(SQLITE_BIN, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message || 'SQLite command failed'));
        return;
      }
      resolve(stdout);
    });

    child.stdin.end(input);
  });
}

async function sqliteQueryCsv(query) {
  return execSqlite(['-header', '-csv', DB_PATH, query]);
}

async function sqliteQueryJson(query) {
  const output = await execSqlite(['-json', DB_PATH, query]);
  return output.trim() ? JSON.parse(output) : [];
}

async function sqliteRun(sql) {
  await execSqliteWithInput([DB_PATH], sql);
}

async function syncCsvExports() {
  const dimCsv = await sqliteQueryCsv(SQLITE_CSV_ROUTES['/dim_org_unit.csv']);
  const relationCsv = await sqliteQueryCsv(SQLITE_CSV_ROUTES['/org_unit_relation.csv']);
  fs.writeFileSync(path.join(ROOT, 'dim_org_unit.csv'), dimCsv, 'utf8');
  fs.writeFileSync(path.join(ROOT, 'org_unit_relation.csv'), relationCsv, 'utf8');
}

function sqlValue(value) {
  if (value === null || value === undefined || value === '') {
    return 'NULL';
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : 'NULL';
  }
  return `'${String(value).replace(/'/g, "''")}'`;
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
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

async function serveSqliteCsv(urlPath, res) {
  const query = SQLITE_CSV_ROUTES[urlPath];
  if (!query || !fs.existsSync(DB_PATH)) {
    return false;
  }

  try {
    const csv = await sqliteQueryCsv(query);
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(csv);
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(error.message || 'SQLite query failed');
  }

  return true;
}

function normalizeUnitCodeList(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(value => String(value || '').trim())
    .filter(Boolean))];
}

function deriveEndpointPath(unitCode, unitsByCode) {
  const unit = unitsByCode.get(unitCode);
  if (!unit) {
    throw new Error(`Unknown unit code: ${unitCode}`);
  }

  let current = unitCode;
  const seen = new Set();
  let collegeCode = '';
  let departmentCode = '';
  let majorCode = '';

  while (current && !seen.has(current)) {
    seen.add(current);
    const currentUnit = unitsByCode.get(current);
    if (!currentUnit) break;

    if (currentUnit.unit_type === 'college') {
      collegeCode = current;
    } else if (currentUnit.unit_type === 'department') {
      departmentCode = current;
    } else if (currentUnit.unit_type === 'major') {
      majorCode = current;
    }

    current = currentUnit.parent_unit_code || '';
  }

  return {
    unitCode,
    collegeCode,
    departmentCode,
    majorCode,
  };
}

function validatePayload(payload) {
  const changeYear = Number(payload.changeYear);
  const retainUntil = payload.retainUntilGradYear === '' || payload.retainUntilGradYear === null || payload.retainUntilGradYear === undefined
    ? null
    : Number(payload.retainUntilGradYear);
  const changeType = String(payload.changeType || '').trim();
  const prevUnitCodes = normalizeUnitCodeList(payload.prevUnitCodes);
  const afterUnitCodes = normalizeUnitCodeList(payload.afterUnitCodes);

  if (!Number.isInteger(changeYear)) {
    throw new Error('changeYear must be an integer');
  }
  if (!CHANGE_TYPE_RULES[changeType]) {
    throw new Error('changeType is invalid');
  }
  if (retainUntil !== null && !Number.isInteger(retainUntil)) {
    throw new Error('retainUntilGradYear must be an integer');
  }

  const rule = CHANGE_TYPE_RULES[changeType];
  if (prevUnitCodes.length < rule.minPrev) {
    throw new Error('prevUnitCodes does not satisfy the minimum count for this change type');
  }
  if (afterUnitCodes.length < rule.minAfter) {
    throw new Error('afterUnitCodes does not satisfy the minimum count for this change type');
  }

  return {
    changeYear,
    changeType,
    retainUntilGradYear: retainUntil,
    note: String(payload.note || '').trim(),
    prevUnitCodes,
    afterUnitCodes,
  };
}

async function insertRelation(payload) {
  if (!fs.existsSync(DB_PATH)) {
    throw new Error('SQLite database does not exist');
  }

  const units = await sqliteQueryJson(`
    SELECT unit_code, unit_type, parent_unit_code
    FROM curriculum_unit
    ORDER BY rowid;
  `);
  const unitsByCode = new Map(units.map(unit => [unit.unit_code, unit]));

  const validated = validatePayload(payload);
  const prevEndpoints = validated.prevUnitCodes.map(code => deriveEndpointPath(code, unitsByCode));
  const afterEndpoints = validated.afterUnitCodes.map(code => deriveEndpointPath(code, unitsByCode));

  const ids = await sqliteQueryJson(`
    SELECT
      (SELECT COALESCE(MAX(event_id), 0) FROM change_event) AS max_event_id,
      (SELECT COALESCE(MAX(relation_id), 0) FROM change_relation) AS max_relation_id,
      (SELECT COALESCE(MAX(endpoint_id), 0) FROM change_relation_endpoint) AS max_endpoint_id;
  `);
  const currentIds = ids[0] || { max_event_id: 0, max_relation_id: 0, max_endpoint_id: 0 };

  const existingEvents = await sqliteQueryJson(`
    SELECT event_id
    FROM change_event
    WHERE change_year = ${sqlValue(validated.changeYear)}
    ORDER BY event_id
    LIMIT 1;
  `);

  const eventId = existingEvents[0]?.event_id || currentIds.max_event_id + 1;
  const relationId = currentIds.max_relation_id + 1;
  let endpointId = currentIds.max_endpoint_id + 1;

  const statements = ['PRAGMA foreign_keys = ON;', 'BEGIN;'];

  if (!existingEvents.length) {
    statements.push(`
      INSERT INTO change_event (event_id, change_year, title)
      VALUES (
        ${sqlValue(eventId)},
        ${sqlValue(validated.changeYear)},
        ${sqlValue(`${validated.changeYear}학년도 편제개편`)}
      );
    `);
  }

  statements.push(`
    INSERT INTO change_relation (
      relation_id,
      event_id,
      change_type,
      retain_until_grad_year,
      note,
      legacy_relation_id
    ) VALUES (
      ${sqlValue(relationId)},
      ${sqlValue(eventId)},
      ${sqlValue(validated.changeType)},
      ${sqlValue(validated.retainUntilGradYear)},
      ${sqlValue(validated.note)},
      NULL
    );
  `);

  for (const endpoint of prevEndpoints) {
    statements.push(`
      INSERT INTO change_relation_endpoint (
        endpoint_id,
        relation_id,
        side,
        unit_code,
        college_code,
        department_code,
        major_code,
        sort_order
      ) VALUES (
        ${sqlValue(endpointId)},
        ${sqlValue(relationId)},
        'prev',
        ${sqlValue(endpoint.unitCode)},
        ${sqlValue(endpoint.collegeCode)},
        ${sqlValue(endpoint.departmentCode)},
        ${sqlValue(endpoint.majorCode)},
        ${sqlValue(endpointId - currentIds.max_endpoint_id - 1)}
      );
    `);
    endpointId += 1;
  }

  for (const endpoint of afterEndpoints) {
    statements.push(`
      INSERT INTO change_relation_endpoint (
        endpoint_id,
        relation_id,
        side,
        unit_code,
        college_code,
        department_code,
        major_code,
        sort_order
      ) VALUES (
        ${sqlValue(endpointId)},
        ${sqlValue(relationId)},
        'after',
        ${sqlValue(endpoint.unitCode)},
        ${sqlValue(endpoint.collegeCode)},
        ${sqlValue(endpoint.departmentCode)},
        ${sqlValue(endpoint.majorCode)},
        ${sqlValue(endpointId - currentIds.max_endpoint_id - 1)}
      );
    `);
    endpointId += 1;
  }

  statements.push('COMMIT;');
  await sqliteRun(statements.join('\n'));
  await syncCsvExports();

  return {
    relationId,
    eventId,
  };
}

async function handleApi(req, res, urlPath) {
  if (urlPath !== '/api/relations') {
    sendJson(res, 404, { error: 'Not found' });
    return true;
  }

  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return true;
  }

  try {
    const body = await readRequestBody(req);
    const payload = body ? JSON.parse(body) : {};
    const result = await insertRelation(payload);
    sendJson(res, 201, { ok: true, ...result });
  } catch (error) {
    sendJson(res, 400, { ok: false, error: error.message || 'Request failed' });
  }

  return true;
}

const server = http.createServer(async (req, res) => {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/' || urlPath === '') {
    urlPath = '/index.html';
  }

  if (urlPath.startsWith('/api/')) {
    await handleApi(req, res, urlPath);
    return;
  }

  if (await serveSqliteCsv(urlPath, res)) {
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
