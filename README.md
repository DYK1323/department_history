# department_history

학과/전공 편제 변경 이력을 시각화하는 정적 웹앱입니다.

## Included Files

- `index.html`: 편제 변경 흐름 시각화 화면
- `dim_org_unit.csv`: 편제단위 마스터
- `org_unit_relation.csv`: 편제 변경 관계 데이터
- `schema.sql`: SQLite 기준 스키마
- `scripts/migrate_to_sqlite.js`: CSV -> SQLite 마이그레이션 스크립트

## Run Locally

브라우저 보안 정책 때문에 `index.html`을 파일로 직접 열면 CSV를 읽지 못할 수 있습니다. 간단한 로컬 서버로 실행하는 방식을 권장합니다.

예시:

```powershell
node server/app.js
```

그 뒤 브라우저에서 `http://localhost:3004`로 접속하면 됩니다.

`department_history.sqlite` 파일이 있으면 서버가 `dim_org_unit.csv`, `org_unit_relation.csv` 요청을 SQLite에서 생성한 CSV로 응답합니다. DB가 없으면 기존 정적 CSV 파일을 그대로 제공합니다.

## SQLite Migration

SQLite DB를 만들려면 다음 명령을 실행합니다.

```powershell
node scripts/migrate_to_sqlite.js
```

기본 출력 파일은 `department_history.sqlite`입니다. 다른 경로로 만들려면 `--out` 옵션을 사용합니다.

```powershell
node scripts/migrate_to_sqlite.js --out .\\data\\department_history.sqlite
```
