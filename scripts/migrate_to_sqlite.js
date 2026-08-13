'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SCHEMA_PATH = path.join(ROOT, 'schema.sql');
const DIM_PATH = path.join(ROOT, 'dim_org_unit.csv');
const RELATION_PATH = path.join(ROOT, 'org_unit_relation.csv');
const DEFAULT_OUT = path.join(ROOT, 'department_history.sqlite');

function parseArgs(argv) {
  const options = {
    out: DEFAULT_OUT,
    sqliteBin: 'sqlite3',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out') {
      if (!argv[i + 1]) {
        throw new Error('--out requires a path');
      }
      options.out = path.resolve(argv[i + 1]);
      i += 1;
    } else if (arg === '--sqlite-bin') {
      if (!argv[i + 1]) {
        throw new Error('--sqlite-bin requires a value');
      }
      options.sqliteBin = argv[i + 1];
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        value += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        value += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(value);
      value = '';
    } else if (ch === '\n') {
      row.push(value.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      value = '';
    } else {
      value += ch;
    }
  }

  if (value.length > 0 || row.length > 0) {
    row.push(value.replace(/\r$/, ''));
    rows.push(row);
  }

  return rows.filter((currentRow) => currentRow.some((cell) => cell !== ''));
}

function readCsv(filePath) {
  const text = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  const rows = parseCsv(text);
  const [header, ...dataRows] = rows;

  return dataRows.map((cells) => {
    const record = {};
    for (let i = 0; i < header.length; i += 1) {
      record[header[i]] = (cells[i] || '').trim();
    }
    return record;
  });
}

function sqlValue(value) {
  if (value === null || value === undefined) {
    return 'NULL';
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : 'NULL';
  }
  if (value === '') {
    return 'NULL';
  }
  return `'${String(value).replace(/'/g, "''")}'`;
}

function inferUnitCode(record, prefix) {
  return record[`${prefix}_major_code`]
    || record[`${prefix}_dept_code`]
    || record[`${prefix}_college_code`]
    || '';
}

function validateUnitPath(record, prefix, unitsByCode) {
  const collegeCode = record[`${prefix}_college_code`];
  const departmentCode = record[`${prefix}_dept_code`];
  const majorCode = record[`${prefix}_major_code`];
  const unitCode = inferUnitCode(record, prefix);

  if (!unitCode) {
    return;
  }

  if (!unitsByCode.has(unitCode)) {
    throw new Error(`${record.relation_id}: ${prefix} unit_code ${unitCode} not found`);
  }
  if (collegeCode && unitsByCode.get(collegeCode)?.unit_type !== 'college') {
    throw new Error(`${record.relation_id}: ${prefix} college_code ${collegeCode} is not college`);
  }
  if (departmentCode && unitsByCode.get(departmentCode)?.unit_type !== 'department') {
    throw new Error(`${record.relation_id}: ${prefix} dept_code ${departmentCode} is not department`);
  }
  if (majorCode && unitsByCode.get(majorCode)?.unit_type !== 'major') {
    throw new Error(`${record.relation_id}: ${prefix} major_code ${majorCode} is not major`);
  }

  if (majorCode && unitCode !== majorCode) {
    throw new Error(`${record.relation_id}: ${prefix} unit_code should match major_code`);
  }
  if (!majorCode && departmentCode && unitCode !== departmentCode) {
    throw new Error(`${record.relation_id}: ${prefix} unit_code should match dept_code`);
  }
  if (!majorCode && !departmentCode && collegeCode && unitCode !== collegeCode) {
    throw new Error(`${record.relation_id}: ${prefix} unit_code should match college_code`);
  }
}

function buildDataSql(dimRows, relationRows) {
  const unitsByCode = new Map(dimRows.map((row) => [row.unit_code, row]));
  const years = [...new Set(relationRows.map((row) => row.change_year).filter(Boolean))]
    .sort((a, b) => Number(a) - Number(b));
  const eventIdByYear = new Map(years.map((year, index) => [year, index + 1]));

  const statements = ['PRAGMA foreign_keys = ON;', 'BEGIN;'];

  for (const row of dimRows) {
    const parentCode = row.parent_code || '';
    if (parentCode && !unitsByCode.has(parentCode)) {
      throw new Error(`unit ${row.unit_code}: parent_code ${parentCode} not found`);
    }

    statements.push(
      `INSERT INTO curriculum_unit (` +
        `unit_code, unit_name, unit_type, parent_unit_code, is_temp_code` +
      `) VALUES (` +
        `${sqlValue(row.unit_code)}, ${sqlValue(row.unit_name)}, ${sqlValue(row.unit_type)}, ` +
        `${sqlValue(parentCode)}, ${sqlValue(Number(row.is_temp_code || 0))}` +
      `);`
    );
  }

  for (const year of years) {
    statements.push(
      `INSERT INTO change_event (event_id, change_year, title) VALUES (` +
        `${sqlValue(eventIdByYear.get(year))}, ${sqlValue(Number(year))}, ${sqlValue(`${year}학년도 편제개편`)}` +
      `);`
    );
  }

  let endpointId = 1;
  for (const row of relationRows) {
    validateUnitPath(row, 'prev', unitsByCode);
    validateUnitPath(row, 'after', unitsByCode);

    const retainUntil = row.valid_until === '' ? null : Number(row.valid_until);
    const relationId = Number(row.relation_id);
    const eventId = eventIdByYear.get(row.change_year);
    if (!eventId) {
      throw new Error(`relation ${row.relation_id}: missing event for year ${row.change_year}`);
    }

    statements.push(
      `INSERT INTO change_relation (` +
        `relation_id, event_id, change_type, retain_until_grad_year, note, legacy_relation_id` +
      `) VALUES (` +
        `${sqlValue(relationId)}, ${sqlValue(eventId)}, ${sqlValue(row.change_type)}, ` +
        `${sqlValue(retainUntil)}, ${sqlValue(row.note)}, ${sqlValue(row.relation_id)}` +
      `);`
    );

    for (const side of ['prev', 'after']) {
      const unitCode = inferUnitCode(row, side);
      if (!unitCode) {
        continue;
      }

      statements.push(
        `INSERT INTO change_relation_endpoint (` +
          `endpoint_id, relation_id, side, unit_code, college_code, department_code, major_code, sort_order` +
        `) VALUES (` +
          `${sqlValue(endpointId)}, ${sqlValue(relationId)}, ${sqlValue(side)}, ${sqlValue(unitCode)}, ` +
          `${sqlValue(row[`${side}_college_code`])}, ${sqlValue(row[`${side}_dept_code`])}, ` +
          `${sqlValue(row[`${side}_major_code`])}, 0` +
        `);`
      );
      endpointId += 1;
    }
  }

  statements.push('COMMIT;');
  return {
    sql: statements.join('\n'),
    counts: {
      curriculumUnit: dimRows.length,
      changeEvent: years.length,
      changeRelation: relationRows.length,
    },
  };
}

function runSqlite(sqliteBin, dbPath, sql) {
  const result = spawnSync(sqliteBin, [dbPath], {
    input: sql,
    encoding: 'utf8',
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `sqlite3 exited with code ${result.status}`);
  }
}

function runScalar(sqliteBin, dbPath, query) {
  const result = spawnSync(sqliteBin, [dbPath, query], {
    encoding: 'utf8',
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `sqlite3 exited with code ${result.status}`);
  }
  return result.stdout.trim();
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: node scripts/migrate_to_sqlite.js [--out path] [--sqlite-bin sqlite3]');
    return;
  }

  const dimRows = readCsv(DIM_PATH);
  const relationRows = readCsv(RELATION_PATH);
  const schemaSql = fs.readFileSync(SCHEMA_PATH, 'utf8');
  const { sql: dataSql, counts } = buildDataSql(dimRows, relationRows);

  fs.mkdirSync(path.dirname(options.out), { recursive: true });
  if (fs.existsSync(options.out)) {
    fs.unlinkSync(options.out);
  }

  runSqlite(options.sqliteBin, options.out, `${schemaSql}\n${dataSql}`);

  const legacyRowCount = runScalar(options.sqliteBin, options.out, 'SELECT COUNT(*) FROM v_org_unit_relation_legacy;');
  const relationCount = runScalar(options.sqliteBin, options.out, 'SELECT COUNT(*) FROM change_relation;');
  const endpointCount = runScalar(options.sqliteBin, options.out, 'SELECT COUNT(*) FROM change_relation_endpoint;');

  console.log(`Created ${options.out}`);
  console.log(`curriculum_unit: ${counts.curriculumUnit}`);
  console.log(`change_event: ${counts.changeEvent}`);
  console.log(`change_relation: ${relationCount}`);
  console.log(`change_relation_endpoint: ${endpointCount}`);
  console.log(`legacy view rows: ${legacyRowCount}`);
}

main();
