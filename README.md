# department_history

학과/조직 개편 이력을 시각화하는 정적 HTML 페이지입니다.

## Included Files

- `index.html`: 조직 변경 흐름 시각화 페이지
- `dim_org_unit.csv`: 조직 기본 정보
- `org_unit_relation.csv`: 연도별 조직 변경 관계

## Run Locally

브라우저 보안 정책 때문에 `index.html`을 파일로 직접 열면 CSV 자동 읽기가 막힐 수 있습니다.
가능하면 간단한 로컬 서버나 GitHub Pages로 여는 것을 권장합니다.

예시:

```powershell
python -m http.server 8000
```

그 뒤 브라우저에서 `http://localhost:8000`으로 접속하면 됩니다.

## GitHub Pages

이 저장소를 GitHub에 올린 뒤 Pages를 활성화하면 `index.html`이 기본 진입점으로 동작합니다.
