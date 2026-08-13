PRAGMA foreign_keys = ON;

CREATE TABLE curriculum_unit (
  unit_code TEXT PRIMARY KEY,
  unit_name TEXT NOT NULL,
  unit_type TEXT NOT NULL CHECK (unit_type IN ('college', 'department', 'major')),
  parent_unit_code TEXT REFERENCES curriculum_unit(unit_code),
  is_temp_code INTEGER NOT NULL DEFAULT 0,
  active_from_year INTEGER,
  active_until_year INTEGER,
  note TEXT
);

CREATE TABLE change_event (
  event_id INTEGER PRIMARY KEY,
  change_year INTEGER NOT NULL,
  title TEXT,
  source_text TEXT,
  rule_revision_date TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE change_relation (
  relation_id INTEGER PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES change_event(event_id),
  change_type TEXT NOT NULL CHECK (
    change_type IN ('renewed', 'revised', 'closed', 'created', 'merged', 'splitted')
  ),
  retain_until_grad_year INTEGER,
  note TEXT,
  legacy_relation_id TEXT
);

CREATE TABLE change_relation_endpoint (
  endpoint_id INTEGER PRIMARY KEY,
  relation_id INTEGER NOT NULL REFERENCES change_relation(relation_id) ON DELETE CASCADE,
  side TEXT NOT NULL CHECK (side IN ('prev', 'after')),
  unit_code TEXT NOT NULL REFERENCES curriculum_unit(unit_code),
  college_code TEXT REFERENCES curriculum_unit(unit_code),
  department_code TEXT REFERENCES curriculum_unit(unit_code),
  major_code TEXT REFERENCES curriculum_unit(unit_code),
  sort_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE (relation_id, side, unit_code)
);

CREATE TABLE unit_alias (
  alias_id INTEGER PRIMARY KEY,
  unit_code TEXT NOT NULL REFERENCES curriculum_unit(unit_code),
  alias_name TEXT NOT NULL,
  source TEXT,
  UNIQUE (unit_code, alias_name)
);

CREATE INDEX idx_change_event_year
  ON change_event(change_year);

CREATE INDEX idx_change_relation_event
  ON change_relation(event_id);

CREATE INDEX idx_endpoint_relation_side
  ON change_relation_endpoint(relation_id, side);

CREATE INDEX idx_endpoint_unit
  ON change_relation_endpoint(unit_code);

CREATE INDEX idx_endpoint_side_unit
  ON change_relation_endpoint(side, unit_code);

CREATE VIEW v_org_unit_relation_legacy AS
SELECT
  cr.relation_id AS relation_id,
  ce.change_year AS change_year,
  prev.college_code AS prev_college_code,
  prev.department_code AS prev_dept_code,
  prev.major_code AS prev_major_code,
  after.college_code AS after_college_code,
  after.department_code AS after_dept_code,
  after.major_code AS after_major_code,
  cr.change_type AS change_type,
  CASE
    WHEN cr.retain_until_grad_year IS NULL THEN ''
    ELSE CAST(cr.retain_until_grad_year AS TEXT)
  END AS valid_until,
  COALESCE(cr.note, '') AS note
FROM change_relation cr
JOIN change_event ce ON ce.event_id = cr.event_id
LEFT JOIN change_relation_endpoint prev
  ON prev.relation_id = cr.relation_id AND prev.side = 'prev'
LEFT JOIN change_relation_endpoint after
  ON after.relation_id = cr.relation_id AND after.side = 'after';

CREATE TABLE unit_rollup_cache (
  as_of_year INTEGER NOT NULL,
  source_unit_code TEXT NOT NULL REFERENCES curriculum_unit(unit_code),
  current_unit_code TEXT REFERENCES curriculum_unit(unit_code),
  status TEXT NOT NULL CHECK (status IN ('resolved', 'ambiguous', 'orphan', 'cycle')),
  reason TEXT,
  PRIMARY KEY (as_of_year, source_unit_code)
);
