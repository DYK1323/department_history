# 편제 데이터 마이그레이션 및 스키마 설계안

## 1. 목표

현재 CSV 기반 데이터를 SQLite 원본 저장소로 옮기되, 단순 저장소 변경이 아니라 다음 목적을 만족하는 편제 계보 데이터 모델로 정리한다.

- 편제개편 입력 폼에서 사용자가 개편 사건과 이전·이후 편제단위를 자연스럽게 입력할 수 있다.
- 현재 조회 화면의 연도별 흐름도는 기존과 같은 결과를 렌더링할 수 있다.
- 학생의 실제 소속 코드가 과거 편제명이든 현재 편제명이든, 기준 학년도 현재 대표 편제단위로 집계할 수 있다.
- 학생 집계 매핑은 별도 수기 테이블로 관리하지 않고, 편제 관계 그래프에서 산출한다.
- CSV는 원본 저장소가 아니라 가져오기·내보내기 형식으로 둔다.

## 2. 핵심 판단

`student_mapping_rule` 같은 학생용 매핑 테이블을 원천 데이터로 따로 관리하지 않는다. 편제 관계와 학생 집계 매핑이 따로 관리되면 일관성이 깨질 수 있기 때문이다.

원천 데이터는 다음 두 축이다.

- 편제단위 마스터
- 편제개편 사건과 그 사건에 속한 이전·이후 편제단위 관계

현재 기준 집계 매핑은 다음처럼 파생한다.

```text
resolve_current_unit(source_unit_code, as_of_year)
```

예를 들어 `한국어교육학과`, `국제개발협력전공`, `글로벌한국학전공`이 같은 계보에서 2027학년도 기준 `글로벌한국학전공`으로 귀결된다면, 학생 원장 소속이 어느 쪽이든 집계 기준은 `글로벌한국학전공`으로 산출한다.

## 3. 현행 CSV 구조

### `dim_org_unit.csv`

```text
unit_code
unit_name
unit_type
parent_code
is_temp_code
```

현재 편제단위 마스터 역할을 한다.

### `org_unit_relation.csv`

```text
relation_id
change_year
prev_college_code
prev_dept_code
prev_major_code
after_college_code
after_dept_code
after_major_code
change_type
valid_until
note
```

현재는 한 행에 이전 경로와 이후 경로가 함께 들어 있다. 화면 렌더링은 `prev_major_code || prev_dept_code || prev_college_code`를 source로, `after_major_code || after_dept_code || after_college_code`를 target으로 사용한다.

이 구조는 조회에는 충분하지만 입력 폼에는 조금 불편하다. 예를 들어 통합, 분리, 복수 이전 단위가 하나의 개편 사건에 묶이는 경우를 사건 단위로 다루기 어렵다.

## 4. 제안 스키마

### 4-1. `curriculum_unit`

편제단위 마스터.

```sql
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
```

현행 `dim_org_unit.csv`를 거의 그대로 옮긴다. `active_from_year`, `active_until_year`는 당장 비워도 되며, 나중에 검증이나 입력 UX에 필요할 때 채운다.

주의: `active_from_year`, `active_until_year`는 관계 그래프의 원천이 아니라 편제단위의 참고 속성이다. 학생 집계용 현재 대표 단위는 이 필드가 아니라 `change_relation`과 `change_relation_endpoint`에서 산출한다.

### 4-2. `change_event`

편제개편 사건.

```sql
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
```

예:

```text
2023학년도 편제개편
2027학년도 편제개편
학칙 제n조 개정
```

입력 폼에서는 사용자가 먼저 `change_event`를 만들고, 그 아래에 관계 묶음을 추가한다.

### 4-3. `change_relation`

하나의 개편 관계 묶음.

```sql
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
```

`retain_until_grad_year`는 현행 CSV의 `valid_until`을 더 명확하게 이름 붙인 필드다. 값이 `9999`인 경우는 별도 정책이 필요하다.

권장 해석:

- `NULL`: 존속기한 없음 또는 해당 없음
- 정수 연도: 해당 학년도 졸업자까지 기존 편제단위 유지
- `9999`: 현 재적생 졸업 시까지 유지 같은 비정형 장기 유지

`retain_until_grad_year`는 관계 묶음 단위 속성으로 둔다. 하나의 relation 안에 있는 이전 endpoint들이 서로 다른 존속기한을 가져야 한다면 같은 relation에 넣지 말고 relation을 분리한다. 이 값은 상세 패널이나 학칙 근거 표시에는 쓰지만, 기본 학생 집계 rollup에서는 간선 추적 여부를 막는 조건으로 쓰지 않는다.

### 4-4. `change_relation_endpoint`

관계 묶음의 이전·이후 편제단위.

```sql
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
```

이 테이블이 중요한 이유는 N:M 관계를 자연스럽게 표현하기 위해서다.

예:

- 통합: `prev` 여러 개, `after` 하나
- 분리: `prev` 하나, `after` 여러 개
- 개편/명칭변경: `prev` 하나, `after` 하나
- 신설: `prev` 없음, `after` 하나 이상
- 폐지: `prev` 하나 이상, `after` 없음

현재 CSV의 한 행은 보통 다음처럼 변환된다.

```text
change_relation 1개
change_relation_endpoint(prev) 0~1개
change_relation_endpoint(after) 0~1개
```

여러 CSV 행이 같은 사건과 같은 관계 묶음에 속해야 하는 경우는 마이그레이션 후 입력 폼에서 점진적으로 합칠 수 있다. 최초 마이그레이션은 원본 보존을 우선해 CSV 행 하나를 relation 하나로 옮긴다.

endpoint에는 경로 일관성 검증이 필요하다. `unit_code`는 `major_code`, `department_code`, `college_code` 중 가장 구체적인 non-null 코드와 같아야 한다. 또한 `college_code`는 `college`, `department_code`는 `department`, `major_code`는 `major` 타입이어야 한다. SQLite의 단순 `CHECK`만으로는 다른 행의 `unit_type`과 parent 관계까지 확인하기 어렵기 때문에, 마이그레이션 스크립트나 저장 API에서 검증한다.

### 4-5. `unit_alias`

선택 사항. 명칭 검색과 과거 명칭 대응을 위한 별칭.

```sql
CREATE TABLE unit_alias (
  alias_id INTEGER PRIMARY KEY,
  unit_code TEXT NOT NULL REFERENCES curriculum_unit(unit_code),
  alias_name TEXT NOT NULL,
  source TEXT,
  UNIQUE (unit_code, alias_name)
);
```

초기에는 만들지 않아도 되지만, 학칙 문구와 사용자 검색어가 현재 마스터 명칭과 다를 때 유용하다.

### 4-6. 권장 인덱스

초기 데이터 규모에서는 없어도 동작하지만, 입력 폼 검색과 rollup 산출을 고려하면 다음 인덱스를 기본 DDL에 포함하는 편이 좋다.

```sql
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
```

## 5. 조회 화면용 호환 View

기존 `index.html` 렌더링은 당장 `org_unit_relation.csv` 형태를 기대한다. SQLite 전환 후에도 같은 형태를 만들 수 있도록 호환 view를 둔다.

```sql
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
```

주의: N:M 관계를 relation 하나에 여러 endpoint로 표현하면 legacy view는 행을 펼쳐야 한다. 초기 마이그레이션에서는 CSV 한 행을 relation 하나로 유지하므로 문제가 적다. 이후 입력 폼에서 진짜 N:M 묶음을 만들면 export 시에는 이전·이후 endpoint 조합을 행으로 펼치거나, 새 조회 로직이 endpoint 구조를 직접 읽도록 개선해야 한다.

## 6. 현재 기준 집계 매핑 산출

학생 집계용 원천 테이블을 따로 만들지 않고, 관계 그래프에서 산출한다.

### 함수 개념

```text
resolve_current_unit(source_unit_code, as_of_year)
```

기본 규칙:

1. `change_year <= as_of_year`인 관계만 사용한다.
2. `prev -> after` 방향의 그래프를 만든다.
3. source에서 출발해 이후 편제단위를 따라간다.
4. 더 이상 이후 편제단위가 없거나, `as_of_year` 스냅숏에 존재하는 말단 단위를 반환한다.
5. 여러 경로가 하나로 합쳐지면 같은 대표 단위로 집계된다.

`변경없음`은 별도 관계 행으로 저장하지 않는다. 화면에서 연도 사이에 같은 편제단위가 계속 존재할 때 파생되는 carry edge로 처리한다.

### 분리 관계 처리

`splitted`처럼 하나의 이전 단위가 여러 이후 단위로 갈라지는 경우는 자동으로 하나의 대표 단위를 고를 수 없다.

정책 후보:

- 학생 원장 소속이 이미 분리 이후 전공 코드라면 그 전공의 현재 대표 단위로 산출한다.
- 학생 원장 소속이 분리 이전 단위라면 `ambiguous`로 반환하고 수동 확인 대상에 올린다.
- 특정 분리 관계에 대표 endpoint를 지정하는 보조 필드를 둔다.

보조 필드가 필요하면 다음처럼 확장할 수 있다.

```sql
ALTER TABLE change_relation_endpoint ADD COLUMN is_rollup_default INTEGER NOT NULL DEFAULT 0;
```

단, 이 필드는 학생 매핑 원천이 아니라 분리 관계의 대표값 선택 정책이다.

### 산출 View 또는 캐시

집계가 자주 필요하면 파생 테이블을 둘 수 있다.

```sql
CREATE TABLE unit_rollup_cache (
  as_of_year INTEGER NOT NULL,
  source_unit_code TEXT NOT NULL REFERENCES curriculum_unit(unit_code),
  current_unit_code TEXT REFERENCES curriculum_unit(unit_code),
  status TEXT NOT NULL CHECK (status IN ('resolved', 'ambiguous', 'orphan', 'cycle')),
  reason TEXT,
  PRIMARY KEY (as_of_year, source_unit_code)
);
```

이 테이블은 수기 관리하지 않는다. 관계 데이터가 바뀌면 재생성한다.

## 7. CSV 마이그레이션 전략

### 1단계: 그대로 적재

- `dim_org_unit.csv` → `curriculum_unit`
- `org_unit_relation.csv` → `change_event`, `change_relation`, `change_relation_endpoint`

초기에는 CSV 행 하나를 `change_relation` 하나로 옮긴다.

`change_event`는 `change_year`별 기본 이벤트로 자동 생성한다.

예:

```text
2023학년도 편제개편
2024학년도 편제개편
2027학년도 편제개편
```

### 2단계: 무결성 검사

- 모든 endpoint의 `unit_code`가 `curriculum_unit`에 존재하는지 확인
- `parent_unit_code`가 존재하는지 확인
- `college_code`, `department_code`, `major_code`의 타입이 맞는지 확인
- 폐지 관계는 after endpoint가 없어도 되는지 확인
- 신설 관계는 prev endpoint가 없어도 되는지 확인
- cycle이 생기는지 확인
- 같은 `change_year` 안에서 동일 source가 서로 다른 target으로 갈라지는 경우를 `splitted`로 해석할 수 있는지 확인

### 3단계: 조회 결과 회귀 검증

SQLite에서 legacy view를 export한 결과로 현재 화면과 같은 스냅숏을 만들 수 있어야 한다.

검증 기준:

- 연도별 편제단위 목록
- relation edge 수
- carry edge 수
- 대표 관계 경로
- 검색과 상세 패널에서 표시되는 기본 정보

### 4단계: 입력 폼 도입

입력 폼은 CSV 행을 직접 편집하지 않고 다음 순서로 저장한다.

1. `change_event`
2. `change_relation`
3. `change_relation_endpoint(prev)`
4. `change_relation_endpoint(after)`

저장 후 legacy view 또는 API 응답을 통해 기존 조회 화면이 갱신된다.

## 8. 입력 폼 UX에 필요한 데이터 구조

입력 폼은 다음 입력 방식을 지원하는 것이 좋다.

- 편제개편 학년도 선택
- 변경 유형 선택
- 이전 편제단위 다중 선택
- 이후 편제단위 다중 선택
- 존속기한 입력: `YYYY학년도 졸업자까지 유지`
- 근거 문구 또는 비고 입력

유형별 최소 endpoint 조건:

| 유형 | 이전 endpoint | 이후 endpoint |
| --- | --- | --- |
| `created` | 0개 | 1개 이상 |
| `closed` | 1개 이상 | 0개 |
| `revised` | 1개 | 1개 |
| `renewed` | 1개 이상 | 1개 이상 |
| `merged` | 2개 이상 권장 | 1개 이상 |
| `splitted` | 1개 이상 | 2개 이상 권장 |

현행 CSV와 완전 호환하려면 1:1 행 입력도 허용한다. 다만 폼 내부 모델은 처음부터 endpoint 다중 구조로 잡는 편이 좋다.

## 9. 2027 기준 집계 예시

관계 데이터에서 다음 흐름이 있다면:

```text
한국어교육학과 -> 글로벌한국학전공
국제개발협력전공 -> 글로벌한국학전공
글로벌한국학전공 -> 한국어교육전공 / 국제개발협력전공 등
```

기준 학년도와 관계 방향 정책에 따라 rollup 결과를 산출한다. 이때 중요한 것은 학생 원장 소속을 바꾸는 것이 아니라, 집계용 대표 편제단위를 산출하는 것이다.

```text
학생 원장 소속: 한국어교육학과
집계 기준: 2027학년도
집계 편제단위: 글로벌한국학전공 또는 이후 정책상 대표 단위
```

이 예시는 실제 정책 확정이 필요하다. 특히 `글로벌한국학전공`이 이후 다시 분리되는 관계가 있으면, 어떤 단위를 현재 대표로 볼지 정책을 정해야 한다.

## 10. 남은 결정 사항

- `renewed`, `revised`, `merged`, `splitted`가 rollup 산출에서 모두 같은 방향 간선으로 처리되는지
- `valid_until=9999`의 정식 의미
- 분리 관계에서 과거 단위 학생을 하나의 현재 대표 단위로 묶어야 하는지, 아니면 ambiguous로 둘지
- `글로벌한국학전공`처럼 이후 다시 분기되는 계보의 집계 대표 정책
- 임시 코드(`TMP-*`)를 언제 정식 코드로 승격하거나 정리할지
- SQLite를 브라우저에서 직접 읽을지, Node 서버 API를 둘지

## 11. 권장 다음 단계

1. 이 문서를 기준으로 스키마 확정
2. SQLite DDL 파일 작성
3. CSV → SQLite 마이그레이션 스크립트 작성
4. legacy view export가 현재 CSV와 동등한지 검증
5. `resolve_current_unit(source_unit_code, as_of_year)` 프로토타입 작성
6. 분리/통합/개편 대표 사례로 rollup 결과 검토
7. 편제개편 입력 폼 설계
