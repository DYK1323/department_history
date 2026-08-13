'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const PORT = Number(process.env.PORT) || 3004;
const ROOT = path.join(__dirname, '..');
const DB_PATH = process.env.DB_PATH || path.join(ROOT, 'department_history.sqlite');
const SQLITE_BIN = process.env.SQLITE_BIN || 'sqlite3';
const CSV_EXPORT_DIR = process.env.CSV_EXPORT_DIR
  ? path.resolve(process.env.CSV_EXPORT_DIR)
  : ROOT;
const DISABLE_CSV_SYNC = process.env.DISABLE_CSV_SYNC === '1';

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

const CHANGE_TYPE_RULES = {
  created: { minPrev: 0, minAfter: 1 },
  closed: { minPrev: 1, minAfter: 0 },
  revised: { minPrev: 1, minAfter: 1 },
  renewed: { minPrev: 1, minAfter: 1 },
  merged: { minPrev: 1, minAfter: 1 },
  splitted: { minPrev: 1, minAfter: 1 },
};

const CHANGE_TYPE_LABELS = {
  renewed: '개편',
  revised: '명칭변경',
  splitted: '분리',
  merged: '통합',
  created: '신설',
  closed: '폐지',
};

const UNIT_TYPE_LABELS = {
  college: '단과대학',
  department: '학과(전공)',
  major: '학과(전공)',
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

function execSqlite(args, input) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      SQLITE_BIN,
      args,
      { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr || error.message || 'SQLite command failed'));
          return;
        }
        resolve(stdout);
      }
    );

    if (input !== undefined) {
      child.stdin.end(input);
    }
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
  await execSqlite([DB_PATH], sql);
}

function sqlValue(value) {
  if (value === null || value === undefined || value === '') return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  return `'${String(value).replace(/'/g, "''")}'`;
}

function cleanText(value) {
  return String(value ?? '').trim();
}

function nullableText(value) {
  const text = cleanText(value);
  return text || null;
}

function assertInteger(value, label, { allowNull = false } = {}) {
  if (allowNull && (value === null || value === undefined || value === '')) {
    return null;
  }
  const numeric = Number(value);
  if (!Number.isInteger(numeric)) {
    throw new Error(`${label} must be an integer`);
  }
  return numeric;
}

function normalizeCodeList(values, label) {
  const source = Array.isArray(values) ? values : [];
  const normalized = source.map(value => cleanText(value)).filter(Boolean);
  const uniqueCodes = [...new Set(normalized)];

  if (normalized.length !== uniqueCodes.length) {
    throw new Error(`${label} contains duplicate unit codes`);
  }

  return uniqueCodes;
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

async function syncCsvExports() {
  if (DISABLE_CSV_SYNC) return;

  fs.mkdirSync(CSV_EXPORT_DIR, { recursive: true });
  const dimCsv = await sqliteQueryCsv(SQLITE_CSV_ROUTES['/dim_org_unit.csv']);
  const relationCsv = await sqliteQueryCsv(SQLITE_CSV_ROUTES['/org_unit_relation.csv']);
  fs.writeFileSync(path.join(CSV_EXPORT_DIR, 'dim_org_unit.csv'), dimCsv, 'utf8');
  fs.writeFileSync(path.join(CSV_EXPORT_DIR, 'org_unit_relation.csv'), relationCsv, 'utf8');
}

async function loadUnits() {
  const units = await sqliteQueryJson(`
    SELECT
      unit_code,
      unit_name,
      unit_type,
      COALESCE(parent_unit_code, '') AS parent_unit_code,
      CAST(is_temp_code AS INTEGER) AS is_temp_code
    FROM curriculum_unit
    ORDER BY rowid;
  `);
  return {
    units,
    unitsByCode: new Map(units.map(unit => [unit.unit_code, unit])),
  };
}

function buildPathCodes(unitCode, unitsByCode) {
  const pathCodes = [];
  let current = unitCode;
  const seen = new Set();

  while (current && !seen.has(current)) {
    seen.add(current);
    pathCodes.unshift(current);
    current = cleanText(unitsByCode.get(current)?.parent_unit_code);
  }

  return pathCodes;
}

function buildUnitDto(unitCode, unitsByCode) {
  const unit = unitsByCode.get(unitCode);
  if (!unit) throw new Error(`Unknown unit code: ${unitCode}`);

  const pathCodes = buildPathCodes(unitCode, unitsByCode);
  const pathNames = pathCodes.map(code => unitsByCode.get(code)?.unit_name || code);
  const collegeCode = pathCodes.find(code => unitsByCode.get(code)?.unit_type === 'college') || '';
  const departmentCode = pathCodes.find(code => unitsByCode.get(code)?.unit_type === 'department') || '';

  return {
    unitCode: unit.unit_code,
    unitName: unit.unit_name,
    unitType: unit.unit_type,
    unitTypeLabel: UNIT_TYPE_LABELS[unit.unit_type] || unit.unit_type,
    parentUnitCode: cleanText(unit.parent_unit_code),
    pathCodes,
    path: pathNames.join(' > '),
    isTempCode: Number(unit.is_temp_code) === 1,
    collegeCode,
    departmentCode,
  };
}

function deriveEndpoint(unitCode, unitsByCode) {
  const unit = buildUnitDto(unitCode, unitsByCode);
  const majorCode = unit.unitType === 'major'
    ? unit.unitCode
    : (unit.pathCodes.find(code => unitsByCode.get(code)?.unit_type === 'major') || '');

  return {
    unitCode: unit.unitCode,
    unitName: unit.unitName,
    unitType: unit.unitType,
    unitTypeLabel: unit.unitTypeLabel,
    collegeCode: unit.collegeCode,
    departmentCode: unit.departmentCode,
    majorCode,
    pathCodes: unit.pathCodes,
    path: unit.path,
    isTempCode: unit.isTempCode,
  };
}

function relationExpansionCount(prevCount, afterCount) {
  if (prevCount > 0 && afterCount > 0) return prevCount * afterCount;
  return Math.max(prevCount, afterCount);
}

function normalizeRelationPayload(payload) {
  if (payload && typeof payload === 'object' && payload.relation) {
    return {
      changeYear: payload.changeYear,
      changeType: payload.relation.changeType,
      retainUntilGradYear: payload.relation.retainUntilGradYear,
      note: payload.relation.note,
      prevUnitCodes: payload.relation.prevUnitCodes,
      afterUnitCodes: payload.relation.afterUnitCodes,
    };
  }

  return payload || {};
}

function validateRelationPayload(payload) {
  const normalized = normalizeRelationPayload(payload);
  const changeYear = assertInteger(normalized.changeYear, 'changeYear');
  const changeType = cleanText(normalized.changeType);
  const prevUnitCodes = normalizeCodeList(normalized.prevUnitCodes, 'prevUnitCodes');
  const afterUnitCodes = normalizeCodeList(normalized.afterUnitCodes, 'afterUnitCodes');
  const retainUntilGradYear = assertInteger(
    normalized.retainUntilGradYear,
    'retainUntilGradYear',
    { allowNull: true }
  );

  if (!CHANGE_TYPE_RULES[changeType]) {
    throw new Error('changeType is invalid');
  }

  const rule = CHANGE_TYPE_RULES[changeType];
  if (prevUnitCodes.length < rule.minPrev) {
    throw new Error('prevUnitCodes does not satisfy the minimum count for this change type');
  }
  if (afterUnitCodes.length < rule.minAfter) {
    throw new Error('afterUnitCodes does not satisfy the minimum count for this change type');
  }

  const overlap = prevUnitCodes.find(code => afterUnitCodes.includes(code));
  if (overlap) {
    throw new Error(`Unit code cannot appear on both sides of one relation: ${overlap}`);
  }

  if (prevUnitCodes.length > 1 && afterUnitCodes.length > 1) {
    throw new Error('N x M relations are not supported in v1. Split this rule into separate entries.');
  }

  return {
    changeYear,
    changeType,
    retainUntilGradYear,
    note: nullableText(normalized.note),
    prevUnitCodes,
    afterUnitCodes,
  };
}

async function loadBootstrapData() {
  if (!fs.existsSync(DB_PATH)) {
    throw new Error('SQLite database does not exist');
  }

  const { units, unitsByCode } = await loadUnits();
  const yearRows = await sqliteQueryJson(`
    SELECT
      change_year,
      COUNT(*) AS relation_count
    FROM change_relation
    GROUP BY change_year
    ORDER BY change_year DESC;
  `);

  const recentRelationRows = await sqliteQueryJson(`
    SELECT
      cr.relation_id,
      cr.change_year,
      cr.change_type,
      cr.retain_until_grad_year,
      COALESCE(cr.note, '') AS relation_note,
      endpoint.side,
      endpoint.sort_order,
      endpoint.unit_code
    FROM change_relation cr
    LEFT JOIN change_relation_endpoint endpoint ON endpoint.relation_id = cr.relation_id
    ORDER BY cr.relation_id DESC, endpoint.side, endpoint.sort_order
    LIMIT 120;
  `);

  const groupedRecent = new Map();
  recentRelationRows.forEach(row => {
    const relationId = Number(row.relation_id);
    if (!groupedRecent.has(relationId)) {
      groupedRecent.set(relationId, {
        relationId,
        changeYear: Number(row.change_year),
        changeType: row.change_type,
        retainUntilGradYear: row.retain_until_grad_year === null ? null : Number(row.retain_until_grad_year),
        note: cleanText(row.relation_note) || null,
        prev: [],
        after: [],
      });
    }
    if (row.side === 'prev' || row.side === 'after') {
      groupedRecent.get(relationId)[row.side].push(row.unit_code);
    }
  });

  return {
    units: units.map(unit => buildUnitDto(unit.unit_code, unitsByCode)),
    changeTypes: Object.entries(CHANGE_TYPE_LABELS).map(([code, label]) => ({ code, label })),
    years: yearRows.map(row => Number(row.change_year)).sort((a, b) => a - b),
    relationCountsByYear: yearRows.reduce((acc, row) => {
      acc[String(row.change_year)] = Number(row.relation_count);
      return acc;
    }, {}),
    recentRelations: [...groupedRecent.values()].slice(0, 12).map(relation => {
      const prev = relation.prev.map(code => deriveEndpoint(code, unitsByCode));
      const after = relation.after.map(code => deriveEndpoint(code, unitsByCode));
      return {
        relationId: relation.relationId,
        changeYear: relation.changeYear,
        changeType: relation.changeType,
        changeTypeLabel: CHANGE_TYPE_LABELS[relation.changeType] || relation.changeType,
        retainUntilGradYear: relation.retainUntilGradYear,
        note: relation.note,
        expansionCount: relationExpansionCount(prev.length, after.length),
        prev,
        after,
      };
    }),
  };
}

async function insertRelation(payload) {
  if (!fs.existsSync(DB_PATH)) {
    throw new Error('SQLite database does not exist');
  }

  const relation = validateRelationPayload(payload);
  const { unitsByCode } = await loadUnits();
  const prevEndpoints = relation.prevUnitCodes.map(code => deriveEndpoint(code, unitsByCode));
  const afterEndpoints = relation.afterUnitCodes.map(code => deriveEndpoint(code, unitsByCode));

  const ids = await sqliteQueryJson(`
    SELECT
      (SELECT COALESCE(MAX(relation_id), 0) FROM change_relation) AS max_relation_id,
      (SELECT COALESCE(MAX(endpoint_id), 0) FROM change_relation_endpoint) AS max_endpoint_id;
  `);
  const currentIds = ids[0] || { max_relation_id: 0, max_endpoint_id: 0 };
  const relationId = currentIds.max_relation_id + 1;
  let endpointId = currentIds.max_endpoint_id + 1;

  const statements = ['PRAGMA foreign_keys = ON;', 'BEGIN IMMEDIATE;'];
  statements.push(`
    INSERT INTO change_relation (
      relation_id,
      change_year,
      change_type,
      retain_until_grad_year,
      note,
      legacy_relation_id
    ) VALUES (
      ${sqlValue(relationId)},
      ${sqlValue(relation.changeYear)},
      ${sqlValue(relation.changeType)},
      ${sqlValue(relation.retainUntilGradYear)},
      ${sqlValue(relation.note)},
      NULL
    );
  `);

  prevEndpoints.forEach((endpoint, index) => {
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
        ${sqlValue(index)}
      );
    `);
    endpointId += 1;
  });

  afterEndpoints.forEach((endpoint, index) => {
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
        ${sqlValue(index)}
      );
    `);
    endpointId += 1;
  });

  statements.push('COMMIT;');
  await sqliteRun(statements.join('\n'));
  await syncCsvExports();

  return {
    relationId,
    changeYear: relation.changeYear,
    relation: {
      changeType: relation.changeType,
      changeTypeLabel: CHANGE_TYPE_LABELS[relation.changeType] || relation.changeType,
      retainUntilGradYear: relation.retainUntilGradYear,
      note: relation.note,
      prev: prevEndpoints,
      after: afterEndpoints,
      expansionCount: relationExpansionCount(prevEndpoints.length, afterEndpoints.length),
    },
  };
}

async function handleApi(req, res, urlPath) {
  if (urlPath === '/api/admin/bootstrap') {
    if (req.method !== 'GET') {
      sendJson(res, 405, { ok: false, error: 'Method not allowed' });
      return true;
    }

    try {
      sendJson(res, 200, { ok: true, ...(await loadBootstrapData()) });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error.message || 'Bootstrap load failed' });
    }
    return true;
  }

  if (urlPath === '/api/relations') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'Method not allowed' });
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

  sendJson(res, 404, { ok: false, error: 'Not found' });
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
  const sourceLabel = fs.existsSync(DB_PATH)
    ? `SQLite: ${path.basename(DB_PATH)}`
    : 'static CSV files';
  const exportLabel = DISABLE_CSV_SYNC
    ? 'CSV sync disabled'
    : `CSV export: ${CSV_EXPORT_DIR}`;
  console.log(`[department-history] http://localhost:${PORT} (${sourceLabel}, ${exportLabel})`);
});
