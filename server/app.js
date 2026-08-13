'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const PORT = Number(process.env.PORT) || 3004;
const ROOT = path.join(__dirname, '..');
const DB_PATH = process.env.DB_PATH || path.join(ROOT, 'department_history.sqlite');
const SQLITE_BIN = process.env.SQLITE_BIN || 'sqlite3';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
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

function normalizeAfterNewUnitList(values) {
  if (values === null || values === undefined) return [];
  if (!Array.isArray(values)) {
    throw new Error('afterNewUnits must be an array');
  }

  return values.map((value, index) => {
    if (!value || typeof value !== 'object') {
      throw new Error(`afterNewUnits[${index}] must be an object`);
    }

    return {
      unitName: cleanText(value.unitName),
      collegeCode: cleanText(value.collegeCode),
      collegeName: cleanText(value.collegeName),
      departmentCode: cleanText(value.departmentCode),
      departmentName: cleanText(value.departmentName),
      unitCode: cleanText(value.unitCode),
    };
  });
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

function sendAdminAuthRequired(res) {
  res.writeHead(401, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'WWW-Authenticate': 'Basic realm="Department History Admin", charset="UTF-8"',
  });
  res.end('Admin authentication required');
}

function needsAdminAuth(urlPath) {
  return (
    urlPath === '/admin.html' ||
    urlPath === '/api/admin/bootstrap' ||
    urlPath === '/api/relations' ||
    urlPath.startsWith('/api/relations/')
  );
}

function isAuthorizedAdmin(req) {
  if (!ADMIN_PASSWORD) return false;

  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme !== 'Basic' || !encoded) return false;

  try {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const separatorIndex = decoded.indexOf(':');
    if (separatorIndex < 0) return false;
    const username = decoded.slice(0, separatorIndex);
    const password = decoded.slice(separatorIndex + 1);
    return username === ADMIN_USERNAME && password === ADMIN_PASSWORD;
  } catch (_error) {
    return false;
  }
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

function describeUnitForError(unitCode, unitsByCode) {
  const unit = unitsByCode.get(unitCode);
  if (!unit) return unitCode;
  const dto = buildUnitDto(unitCode, unitsByCode);
  return `${dto.path} (${dto.unitCode})`;
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
      afterNewUnits: payload.relation.afterNewUnits,
    };
  }

  return payload || {};
}

function validateAfterNewUnits(drafts, unitsByCode, usedCodes) {
  const createdColleges = new Map();
  const createdDepartments = new Map();

  return drafts.map((draft, index) => {
    if (!draft.unitName) {
      throw new Error(`afterNewUnits[${index}].unitName is required`);
    }
    if (!draft.collegeCode) {
      throw new Error(`afterNewUnits[${index}].collegeCode is required`);
    }
    if (!draft.unitCode) {
      throw new Error(`afterNewUnits[${index}].unitCode is required`);
    }
    if (usedCodes.has(draft.unitCode) || unitsByCode.has(draft.unitCode)) {
      const detail = unitsByCode.has(draft.unitCode)
        ? describeUnitForError(draft.unitCode, unitsByCode)
        : draft.unitCode;
      throw new Error(`afterNewUnits[${index}].unitCode already exists: ${detail}`);
    }

    const college = unitsByCode.get(draft.collegeCode);
    if (college) {
      if (college.unit_type !== 'college') {
        throw new Error(`afterNewUnits[${index}].collegeCode is invalid: ${draft.collegeCode}`);
      }
    } else {
      if (!draft.collegeName) {
        throw new Error(`afterNewUnits[${index}].collegeName is required for new college`);
      }
      const existingCollegeDraft = createdColleges.get(draft.collegeCode);
      if (existingCollegeDraft && existingCollegeDraft.unitName !== draft.collegeName) {
        throw new Error(`afterNewUnits[${index}].collegeCode has conflicting names: ${draft.collegeCode}`);
      }
      createdColleges.set(draft.collegeCode, {
        unitCode: draft.collegeCode,
        unitName: draft.collegeName,
        unitType: 'college',
        parentUnitCode: '',
      });
    }

    const departmentCode = draft.departmentCode || '';
    let parentUnitCode = draft.collegeCode;
    if (departmentCode) {
      const department = unitsByCode.get(departmentCode);
      if (department) {
        if (department.unit_type !== 'department') {
          throw new Error(`afterNewUnits[${index}].departmentCode is invalid: ${departmentCode}`);
        }
        const departmentPath = buildPathCodes(departmentCode, unitsByCode);
        if (!departmentPath.includes(draft.collegeCode)) {
          throw new Error(`afterNewUnits[${index}].departmentCode does not belong to ${draft.collegeCode}`);
        }
      } else {
        if (!draft.departmentName) {
          throw new Error(`afterNewUnits[${index}].departmentName is required for new department`);
        }
        const existingDepartmentDraft = createdDepartments.get(departmentCode);
        if (
          existingDepartmentDraft &&
          (
            existingDepartmentDraft.unitName !== draft.departmentName ||
            existingDepartmentDraft.parentUnitCode !== draft.collegeCode
          )
        ) {
          throw new Error(`afterNewUnits[${index}].departmentCode has conflicting definitions: ${departmentCode}`);
        }
        createdDepartments.set(departmentCode, {
          unitCode: departmentCode,
          unitName: draft.departmentName,
          unitType: 'department',
          parentUnitCode: draft.collegeCode,
        });
      }
      parentUnitCode = departmentCode;
    }

    if (college && draft.collegeName) {
      const detail = describeUnitForError(draft.collegeCode, unitsByCode);
      throw new Error(`afterNewUnits[${index}].collegeCode already exists: ${detail}`);
    }

    if (departmentCode && unitsByCode.has(departmentCode) && draft.departmentName) {
      const detail = describeUnitForError(departmentCode, unitsByCode);
      throw new Error(`afterNewUnits[${index}].departmentCode already exists: ${detail}`);
    }

    usedCodes.add(draft.unitCode);
    return {
      unitName: draft.unitName,
      unitType: departmentCode ? 'major' : 'department',
      collegeCode: draft.collegeCode,
      collegeName: draft.collegeName || '',
      departmentCode,
      departmentName: draft.departmentName || '',
      unitCode: draft.unitCode,
      parentUnitCode,
    };
  });
}

function validateRelationPayload(payload, unitsByCode = null) {
  const normalized = normalizeRelationPayload(payload);
  const changeYear = assertInteger(normalized.changeYear, 'changeYear');
  const changeType = cleanText(normalized.changeType);
  const prevUnitCodes = normalizeCodeList(normalized.prevUnitCodes, 'prevUnitCodes');
  const afterUnitCodes = normalizeCodeList(normalized.afterUnitCodes, 'afterUnitCodes');
  const afterNewUnits = normalizeAfterNewUnitList(normalized.afterNewUnits);
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
  const usedAfterCodes = new Set([...prevUnitCodes, ...afterUnitCodes]);
  const validatedAfterNewUnits = unitsByCode
    ? validateAfterNewUnits(afterNewUnits, unitsByCode, usedAfterCodes)
    : afterNewUnits;
  const finalAfterUnitCodes = [
    ...afterUnitCodes,
    ...validatedAfterNewUnits.map(unit => unit.unitCode),
  ];

  if (finalAfterUnitCodes.length < rule.minAfter) {
    throw new Error('afterUnitCodes does not satisfy the minimum count for this change type');
  }

  const overlap = prevUnitCodes.find(code => finalAfterUnitCodes.includes(code));
  if (overlap) {
    throw new Error(`Unit code cannot appear on both sides of one relation: ${overlap}`);
  }

  if (prevUnitCodes.length > 1 && finalAfterUnitCodes.length > 1) {
    throw new Error('N x M relations are not supported in v1. Split this rule into separate entries.');
  }

  return {
    changeYear,
    changeType,
    retainUntilGradYear,
    note: nullableText(normalized.note),
    prevUnitCodes,
    afterUnitCodes: finalAfterUnitCodes,
    afterNewUnits: validatedAfterNewUnits,
  };
}

function buildExpandedUnitsByCode(unitsByCode, drafts) {
  const expanded = new Map(unitsByCode);
  const createdColleges = new Map();
  const createdDepartments = new Map();

  drafts.forEach(draft => {
    if (!expanded.has(draft.collegeCode) && !createdColleges.has(draft.collegeCode)) {
      const collegeName = draft.collegeName || draft.collegeCode;
      const collegeUnit = {
        unit_code: draft.collegeCode,
        unit_name: collegeName,
        unit_type: 'college',
        parent_unit_code: '',
        is_temp_code: 0,
      };
      expanded.set(draft.collegeCode, collegeUnit);
      createdColleges.set(draft.collegeCode, collegeUnit);
    }

    if (draft.departmentCode && !expanded.has(draft.departmentCode) && !createdDepartments.has(draft.departmentCode)) {
      const departmentName = draft.departmentName || draft.departmentCode;
      const departmentUnit = {
        unit_code: draft.departmentCode,
        unit_name: departmentName,
        unit_type: 'department',
        parent_unit_code: draft.collegeCode,
        is_temp_code: 0,
      };
      expanded.set(draft.departmentCode, departmentUnit);
      createdDepartments.set(draft.departmentCode, departmentUnit);
    }

    expanded.set(draft.unitCode, {
      unit_code: draft.unitCode,
      unit_name: draft.unitName,
      unit_type: draft.unitType,
      parent_unit_code: draft.parentUnitCode,
      is_temp_code: 0,
    });
  });
  return {
    unitsByCode: expanded,
    createdColleges: [...createdColleges.values()],
    createdDepartments: [...createdDepartments.values()],
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

  const relationRows = await sqliteQueryJson(`
    SELECT
      relation_id,
      change_year,
      COALESCE(prev_college_code, '') AS prev_college_code,
      COALESCE(prev_dept_code, '') AS prev_dept_code,
      COALESCE(prev_major_code, '') AS prev_major_code,
      COALESCE(after_college_code, '') AS after_college_code,
      COALESCE(after_dept_code, '') AS after_dept_code,
      COALESCE(after_major_code, '') AS after_major_code
    FROM v_org_unit_relation_legacy
    ORDER BY relation_id;
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

  const relationGraphRows = relationRows.map(row => ({
    year: Number(row.change_year),
    source: cleanText(row.prev_major_code) || cleanText(row.prev_dept_code) || cleanText(row.prev_college_code),
    target: cleanText(row.after_major_code) || cleanText(row.after_dept_code) || cleanText(row.after_college_code),
    prevPath: [
      cleanText(row.prev_college_code),
      cleanText(row.prev_dept_code),
      cleanText(row.prev_major_code),
    ].filter(Boolean),
    afterPath: [
      cleanText(row.after_college_code),
      cleanText(row.after_dept_code),
      cleanText(row.after_major_code),
    ].filter(Boolean),
  })).filter(row => row.year && (row.source || row.target));

  const activeUnitCodesByYear = buildActiveUnitCodesByYear(relationGraphRows, unitsByCode);

  return {
    units: units.map(unit => buildUnitDto(unit.unit_code, unitsByCode)),
    changeTypes: Object.entries(CHANGE_TYPE_LABELS).map(([code, label]) => ({ code, label })),
    years: yearRows.map(row => Number(row.change_year)).sort((a, b) => a - b),
    relationCountsByYear: yearRows.reduce((acc, row) => {
      acc[String(row.change_year)] = Number(row.relation_count);
      return acc;
    }, {}),
    activeUnitCodesByYear,
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

function buildActiveUnitCodesByYear(relationRows, unitsByCode) {
  const changeYears = [...new Set(relationRows.map(row => row.year))].sort((a, b) => a - b);
  if (!changeYears.length) return {};

  const firstChangeYear = changeYears[0];
  const snapshots = new Map();
  const base = new Map();

  relationRows
    .filter(row => row.year === firstChangeYear)
    .forEach(row => {
      if (!row.source) return;
      const path = row.prevPath.length ? row.prevPath : buildPathCodes(row.source, unitsByCode);
      base.set(row.source, path);
    });

  snapshots.set(firstChangeYear - 1, base);

  let previous = new Map(base);
  changeYears.forEach(year => {
    const next = new Map(previous);
    relationRows
      .filter(row => row.year === year)
      .forEach(row => {
        if (row.source) next.delete(row.source);
        if (row.target) {
          const path = row.afterPath.length ? row.afterPath : buildPathCodes(row.target, unitsByCode);
          next.set(row.target, path);
        }
      });
    snapshots.set(year, next);
    previous = next;
  });

  return [...snapshots.entries()].reduce((acc, [year, snapshot]) => {
    acc[String(year)] = [...snapshot.keys()];
    return acc;
  }, {});
}

async function insertRelation(payload) {
  if (!fs.existsSync(DB_PATH)) {
    throw new Error('SQLite database does not exist');
  }

  const { unitsByCode } = await loadUnits();
  const relation = validateRelationPayload(payload, unitsByCode);
  const expanded = buildExpandedUnitsByCode(unitsByCode, relation.afterNewUnits);
  const prevEndpoints = relation.prevUnitCodes.map(code => deriveEndpoint(code, expanded.unitsByCode));
  const afterEndpoints = relation.afterUnitCodes.map(code => deriveEndpoint(code, expanded.unitsByCode));

  const ids = await sqliteQueryJson(`
    SELECT
      (SELECT COALESCE(MAX(relation_id), 0) FROM change_relation) AS max_relation_id,
      (SELECT COALESCE(MAX(endpoint_id), 0) FROM change_relation_endpoint) AS max_endpoint_id;
  `);
  const currentIds = ids[0] || { max_relation_id: 0, max_endpoint_id: 0 };
  const relationId = currentIds.max_relation_id + 1;
  let endpointId = currentIds.max_endpoint_id + 1;

  const statements = ['PRAGMA foreign_keys = ON;', 'BEGIN IMMEDIATE;'];
  expanded.createdColleges.forEach(unit => {
    statements.push(`
      INSERT INTO curriculum_unit (
        unit_code,
        unit_name,
        unit_type,
        parent_unit_code,
        is_temp_code
      ) VALUES (
        ${sqlValue(unit.unit_code)},
        ${sqlValue(unit.unit_name)},
        'college',
        NULL,
        0
      );
    `);
  });
  expanded.createdDepartments.forEach(unit => {
    statements.push(`
      INSERT INTO curriculum_unit (
        unit_code,
        unit_name,
        unit_type,
        parent_unit_code,
        is_temp_code
      ) VALUES (
        ${sqlValue(unit.unit_code)},
        ${sqlValue(unit.unit_name)},
        'department',
        ${sqlValue(unit.parent_unit_code)},
        0
      );
    `);
  });
  relation.afterNewUnits.forEach(unit => {
    statements.push(`
      INSERT INTO curriculum_unit (
        unit_code,
        unit_name,
        unit_type,
        parent_unit_code,
        is_temp_code
      ) VALUES (
        ${sqlValue(unit.unitCode)},
        ${sqlValue(unit.unitName)},
        ${sqlValue(unit.unitType)},
        ${sqlValue(unit.parentUnitCode)},
        0
      );
    `);
  });
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

async function loadRelationDetail(relationId) {
  if (!fs.existsSync(DB_PATH)) {
    throw new Error('SQLite database does not exist');
  }

  const numericRelationId = assertInteger(relationId, 'relationId');
  const { unitsByCode } = await loadUnits();
  const rows = await sqliteQueryJson(`
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
    WHERE cr.relation_id = ${sqlValue(numericRelationId)}
    ORDER BY endpoint.side, endpoint.sort_order;
  `);

  if (!rows.length) {
    throw new Error(`Relation not found: ${numericRelationId}`);
  }

  const detail = {
    relationId: numericRelationId,
    changeYear: Number(rows[0].change_year),
    changeType: rows[0].change_type,
    changeTypeLabel: CHANGE_TYPE_LABELS[rows[0].change_type] || rows[0].change_type,
    retainUntilGradYear: rows[0].retain_until_grad_year === null ? null : Number(rows[0].retain_until_grad_year),
    note: cleanText(rows[0].relation_note) || null,
    prev: [],
    after: [],
  };

  rows.forEach(row => {
    if (row.side === 'prev' || row.side === 'after') {
      detail[row.side].push(deriveEndpoint(row.unit_code, unitsByCode));
    }
  });

  detail.expansionCount = relationExpansionCount(detail.prev.length, detail.after.length);
  return detail;
}

async function updateRelation(relationId, payload) {
  if (!fs.existsSync(DB_PATH)) {
    throw new Error('SQLite database does not exist');
  }

  const numericRelationId = assertInteger(relationId, 'relationId');
  const existing = await sqliteQueryJson(`
    SELECT relation_id
    FROM change_relation
    WHERE relation_id = ${sqlValue(numericRelationId)}
    LIMIT 1;
  `);
  if (!existing.length) {
    throw new Error(`Relation not found: ${numericRelationId}`);
  }

  const { unitsByCode } = await loadUnits();
  const relation = validateRelationPayload(payload, unitsByCode);
  const expanded = buildExpandedUnitsByCode(unitsByCode, relation.afterNewUnits);
  const prevEndpoints = relation.prevUnitCodes.map(code => deriveEndpoint(code, expanded.unitsByCode));
  const afterEndpoints = relation.afterUnitCodes.map(code => deriveEndpoint(code, expanded.unitsByCode));

  const ids = await sqliteQueryJson(`
    SELECT (SELECT COALESCE(MAX(endpoint_id), 0) FROM change_relation_endpoint) AS max_endpoint_id;
  `);
  let endpointId = Number((ids[0] || {}).max_endpoint_id || 0) + 1;

  const statements = ['PRAGMA foreign_keys = ON;', 'BEGIN IMMEDIATE;'];
  expanded.createdColleges.forEach(unit => {
    statements.push(`
      INSERT INTO curriculum_unit (
        unit_code,
        unit_name,
        unit_type,
        parent_unit_code,
        is_temp_code
      ) VALUES (
        ${sqlValue(unit.unit_code)},
        ${sqlValue(unit.unit_name)},
        'college',
        NULL,
        0
      );
    `);
  });
  expanded.createdDepartments.forEach(unit => {
    statements.push(`
      INSERT INTO curriculum_unit (
        unit_code,
        unit_name,
        unit_type,
        parent_unit_code,
        is_temp_code
      ) VALUES (
        ${sqlValue(unit.unit_code)},
        ${sqlValue(unit.unit_name)},
        'department',
        ${sqlValue(unit.parent_unit_code)},
        0
      );
    `);
  });
  relation.afterNewUnits.forEach(unit => {
    statements.push(`
      INSERT INTO curriculum_unit (
        unit_code,
        unit_name,
        unit_type,
        parent_unit_code,
        is_temp_code
      ) VALUES (
        ${sqlValue(unit.unitCode)},
        ${sqlValue(unit.unitName)},
        ${sqlValue(unit.unitType)},
        ${sqlValue(unit.parentUnitCode)},
        0
      );
    `);
  });
  statements.push(`
    UPDATE change_relation
    SET
      change_year = ${sqlValue(relation.changeYear)},
      change_type = ${sqlValue(relation.changeType)},
      retain_until_grad_year = ${sqlValue(relation.retainUntilGradYear)},
      note = ${sqlValue(relation.note)}
    WHERE relation_id = ${sqlValue(numericRelationId)};
  `);
  statements.push(`
    DELETE FROM change_relation_endpoint
    WHERE relation_id = ${sqlValue(numericRelationId)};
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
        ${sqlValue(numericRelationId)},
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
        ${sqlValue(numericRelationId)},
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

  const detail = await loadRelationDetail(numericRelationId);
  return {
    relationId: numericRelationId,
    changeYear: detail.changeYear,
    relation: {
      changeType: detail.changeType,
      changeTypeLabel: detail.changeTypeLabel,
      retainUntilGradYear: detail.retainUntilGradYear,
      note: detail.note,
      prev: detail.prev,
      after: detail.after,
      expansionCount: detail.expansionCount,
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

  const relationMatch = urlPath.match(/^\/api\/relations\/(\d+)$/);
  if (relationMatch) {
    const relationId = Number(relationMatch[1]);

    if (req.method === 'GET') {
      try {
        const detail = await loadRelationDetail(relationId);
        sendJson(res, 200, { ok: true, relation: detail });
      } catch (error) {
        sendJson(res, 404, { ok: false, error: error.message || 'Relation not found' });
      }
      return true;
    }

    if (req.method === 'PATCH') {
      try {
        const body = await readRequestBody(req);
        const payload = body ? JSON.parse(body) : {};
        const result = await updateRelation(relationId, payload);
        sendJson(res, 200, { ok: true, ...result });
      } catch (error) {
        const statusCode = String(error.message || '').includes('not found') ? 404 : 400;
        sendJson(res, statusCode, { ok: false, error: error.message || 'Request failed' });
      }
      return true;
    }

    sendJson(res, 405, { ok: false, error: 'Method not allowed' });
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

  if (needsAdminAuth(urlPath) && !isAuthorizedAdmin(req)) {
    sendAdminAuthRequired(res);
    return;
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
