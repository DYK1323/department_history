# Schema Migration Plan v2

## 목표

편제변경 데이터를 현재 운영 개념에 맞게 단순화한다.

- `change_year`가 곧 편제개편 묶음이다.
- 같은 `change_year` 안에 관계 여러 건이 들어간다.
- 별도의 `change_event` 테이블은 두지 않는다.

## 최종 구조

### 1. `curriculum_unit`

편제단위 마스터.

- `unit_code`
- `unit_name`
- `unit_type`
- `parent_unit_code`
- `is_temp_code`

### 2. `change_relation`

개별 변경 관계 본체.

- `relation_id`
- `change_year`
- `change_type`
- `retain_until_grad_year`
- `note`
- `legacy_relation_id`

핵심 의미:

- CSV의 관계 1행 = `change_relation` 1행
- `change_year`는 관계가 속한 편제개편 학년도

### 3. `change_relation_endpoint`

각 관계의 전년도/다음연도 편제단위.

- `endpoint_id`
- `relation_id`
- `side`
- `unit_code`
- `college_code`
- `department_code`
- `major_code`
- `sort_order`

핵심 의미:

- `prev`는 변경 전 단위
- `after`는 변경 후 단위

## CSV -> SQLite 매핑

### `dim_org_unit.csv`

기존과 동일하게 `curriculum_unit`로 들어간다.

- CSV 1행 -> `curriculum_unit` 1행

### `org_unit_relation.csv`

기존 관계 CSV는 그대로 사용 가능하다.

- CSV 1행 -> `change_relation` 1행
- `prev_*` 컬럼이 있으면 `change_relation_endpoint(prev)` 1행
- `after_*` 컬럼이 있으면 `change_relation_endpoint(after)` 1행

즉 현재 CSV에서 반드시 바꿔야 하는 컬럼은 없다.

## 기존 CSV에서 변경이 필요한 부분

### 변경 없이 그대로 써도 되는 부분

- `dim_org_unit.csv` 전체
- `org_unit_relation.csv`의 현재 핵심 컬럼
  - `relation_id`
  - `change_year`
  - `prev_college_code`
  - `prev_dept_code`
  - `prev_major_code`
  - `after_college_code`
  - `after_dept_code`
  - `after_major_code`
  - `change_type`
  - `valid_until`
  - `note`

### 추가 요구가 생길 때만 바꿔야 하는 부분

연도 자체에 대한 메타데이터가 필요하면 현재 CSV만으로는 표현이 어색하다.

예:

- `2027학년도 편제개편` 제목
- 학칙 개정일
- 학칙 원문
- 연도 전체 메모

이런 정보는 관계 한 줄마다 반복 저장하는 구조가 아니기 때문에, 필요해지면 둘 중 하나가 필요하다.

1. 별도 CSV 추가
   - 예: `change_year_meta.csv`
2. `org_unit_relation.csv`에 연도 메타 컬럼을 넣되, 같은 연도에서 반복 허용

현재 범위에서는 둘 다 필수 아님.

## 왜 `change_event`를 제거했는가

기존 운영 규칙이 이미 다음처럼 고정돼 있기 때문이다.

- 한 학년도에는 편제개편 묶음이 하나다.
- 사용자는 학년도를 고르고 관계를 입력한다.
- 별도 이벤트 선택/생성 개념이 필요 없다.

이 조건에서는 `change_event`가 `change_year`를 한 번 더 감싼 래퍼 역할만 하게 되어, 개념 비용이 더 크다.

## 레거시 호환

조회 화면은 계속 `v_org_unit_relation_legacy`를 통해 기존 CSV 형태를 읽을 수 있다.

- `change_relation.change_year`를 그대로 `change_year`로 노출
- endpoint를 조인해서 기존 `prev_*`, `after_*` 컬럼 모양 복원

## 마이그레이션 원칙

- 원본 CSV의 의미를 먼저 보존한다.
- 관계 병합, 분리 해석, 롤업 판단은 나중 단계로 미룬다.
- 초기 마이그레이션은 CSV 관계 1행을 relation 1건으로만 옮긴다.
