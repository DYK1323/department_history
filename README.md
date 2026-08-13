# department_history

편제변경 흐름 조회 화면과 편제개편 입력용 관리자 화면을 함께 제공하는 정적 웹앱 + 경량 Node 서버입니다.

## 포함 파일

- `index.html`: 편제변경 흐름 조회 화면
- `admin.html`: 편제개편 입력 관리자 화면
- `server/app.js`: 정적 파일 서빙, SQLite 기반 CSV 호환 응답, 관리자 API
- `schema.sql`: SQLite 스키마
- `department_history.sqlite`: 현재 작업용 SQLite DB
- `dim_org_unit.csv`, `org_unit_relation.csv`: 조회 화면 호환 CSV
- `scripts/migrate_to_sqlite.js`: CSV -> SQLite 마이그레이션 스크립트

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
  - 편제단위 목록, 변경유형 목록, 이벤트 목록, 최근 관계 요약을 반환합니다.
- `POST /api/relations`
  - 구조화된 `event` + `relation` payload를 받아 저장합니다.
  - 기존 이벤트에 추가할 때는 `event.eventId`를 사용합니다.
  - 새 이벤트 생성은 `event.eventId`를 보내지 않고 `event.changeYear`를 포함해서 요청합니다.

예시:

```json
{
  "event": {
    "changeYear": 2027,
    "title": "2027학년도 편제개편"
  },
  "relation": {
    "changeType": "renewed",
    "prevUnitCodes": ["HAF1000"],
    "afterUnitCodes": ["HAF1100"]
  }
}
```

## 테스트용 환경변수

- `PORT`
  - 서버 포트 지정
- `DB_PATH`
  - 사용할 SQLite DB 경로 지정
- `CSV_EXPORT_DIR`
  - 저장 성공 후 호환 CSV를 다른 디렉터리에 생성
- `DISABLE_CSV_SYNC=1`
  - 저장 성공 후 CSV 재생성을 비활성화

실제 작업 DB를 건드리지 않고 저장 검증을 할 때는 `DB_PATH`를 복사본 DB로 바꾸고 `DISABLE_CSV_SYNC=1` 또는 `CSV_EXPORT_DIR`을 함께 사용하면 됩니다.

## SQLite 마이그레이션

```powershell
node scripts/migrate_to_sqlite.js
```

다른 경로로 만들려면 `--out` 옵션을 사용합니다.

```powershell
node scripts/migrate_to_sqlite.js --out .\\data\\department_history.sqlite
```
