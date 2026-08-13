# department_history

편제변경 흐름 조회 화면과 편제개편 입력 관리자 화면을 함께 제공하는 정적 웹앱 + 경량 Node 서버입니다.

## 포함 파일

- `index.html`: 편제변경 흐름 조회 화면
- `admin.html`: 편제개편 입력 관리자 화면
- `server/app.js`: 정적 파일 서빙, SQLite 기반 CSV 호환 응답, 관리자 API
- `schema.sql`: 현재 운영 규칙 기준 SQLite 스키마
- `department_history.sqlite`: 현재 작업용 SQLite DB
- `dim_org_unit.csv`, `org_unit_relation.csv`: 조회 화면 호환 CSV
- `scripts/migrate_to_sqlite.js`: CSV -> SQLite 마이그레이션 스크립트
- `SCHEMA_MIGRATION_PLAN.md`: change_year 중심 구조 설명

## 현재 구조 핵심

- `change_year`가 곧 편제개편 묶음이다.
- `change_relation`은 개별 변경 관계다.
- `change_relation_endpoint`는 변경 전/후 편제단위다.
- 별도 `change_event` 테이블은 사용하지 않는다.

## 로컬 실행

```powershell
node server/app.js
```

브라우저에서 다음 주소를 엽니다.

- 조회 화면: `http://localhost:3004/`
- 관리자 화면: `http://localhost:3004/admin.html`

SQLite DB가 있으면 서버가 `dim_org_unit.csv`, `org_unit_relation.csv` 요청을 DB 기준으로 생성해서 응답합니다. DB가 없으면 정적 CSV 파일을 그대로 제공합니다.

## 관리자 API

- `GET /api/admin/bootstrap`
  - 편제단위 목록, 변경유형 목록, 사용 중인 학년도 목록, 최근 관계 요약을 반환합니다.
- `POST /api/relations`
  - `change_year` 기준으로 관계를 직접 저장합니다.

관리자 화면과 관리자 API는 Basic 인증으로 보호됩니다. `ADMIN_PASSWORD`가 비어 있으면 `admin.html` 및 관리자 API에 접근할 수 없습니다.

예시:

```json
{
  "changeYear": 2027,
  "changeType": "renewed",
  "retainUntilGradYear": null,
  "note": "선택 메모",
  "prevUnitCodes": ["HAF1000"],
  "afterUnitCodes": ["HAF1100"]
}
```

## 기존 CSV에서 무엇이 바뀌는가

핵심 결론:

- 현재 `dim_org_unit.csv`는 그대로 사용한다.
- 현재 `org_unit_relation.csv`도 그대로 사용한다.

즉, 지금 스키마 재설계만으로는 기존 CSV 컬럼을 반드시 바꿔야 하는 부분이 없다.

다만 나중에 학년도 자체의 메타데이터가 필요하면 별도 구조가 더 필요하다.

예:

- `2027학년도 편제개편` 제목
- 학칙 개정일
- 학칙 원문
- 학년도 전체 메모

이런 정보는 현재 관계 CSV만으로는 자연스럽게 표현되지 않아서, 필요해지면 별도 CSV나 별도 메타 구조를 추가해야 한다.

## 테스트용 환경변수

- `PORT`
  - 서버 포트 지정
- `DB_PATH`
  - 사용할 SQLite DB 경로 지정
- `CSV_EXPORT_DIR`
  - 저장 성공 후 호환 CSV를 다른 디렉터리에 생성
- `DISABLE_CSV_SYNC=1`
  - 저장 성공 후 CSV 재생성을 비활성화
- `ADMIN_USERNAME`
  - 관리자 로그인 아이디, 기본값은 `admin`
- `ADMIN_PASSWORD`
  - 관리자 로그인 비밀번호, 값이 있어야 `admin.html`과 관리자 API 접근 가능

실제 작업 DB를 건드리지 않고 저장 검증을 할 때는 `DB_PATH`를 복사본 DB로 바꾸고 `DISABLE_CSV_SYNC=1` 또는 `CSV_EXPORT_DIR`을 함께 사용하면 됩니다.

## SQLite 마이그레이션

```powershell
node scripts/migrate_to_sqlite.js
```

다른 경로로 만들려면 `--out` 옵션을 사용합니다.

```powershell
node scripts/migrate_to_sqlite.js --out .\\data\\department_history.sqlite
```
