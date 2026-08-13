# 관리자 입력 화면 재설계 계획

## 목표

`admin.html`을 단순한 신규 입력 화면이 아니라, 실제 운영 가능한 관리자 편집 화면으로 확장한다.

이번 단계에서 정리하는 핵심은 두 가지다.

1. 이미 저장된 변경 관계를 다시 불러와 수정할 수 있어야 한다.
2. 변경 입력 과정에서 `변경 후`에 한해 신규 학과(전공) 코드를 함께 생성할 수 있어야 한다.

## 전제 규칙

- `변경 전`은 반드시 기존에 존재하는 편제단위여야 한다.
- `변경 후`는 기존 편제단위를 선택할 수도 있고, 이번 변경에서 새로 생기는 편제단위를 직접 입력할 수도 있다.
- 과거 기준 단위가 목록에 없다면 그것은 신규 생성 문제가 아니라 기존 마스터 정합성 문제로 본다.
- 한 관계에서 `변경 전 여러 개 x 변경 후 여러 개`는 계속 지원하지 않는다.

## 현재 UI 상태

- 상단에 `변경 학년도`만 둔다.
- 본문은 2분할 카드로 구성한다.
  - 왼쪽: `변경 전 학과 추가`
  - 오른쪽: `변경 후 학과 추가` + `유지 학년도`
- 선택 개수에 따라 `변경구분`을 자동 추론한다.
- 1:1 관계일 때만 `개편 / 명칭변경`을 사용자가 선택한다.
- 최근 입력 목록은 본문 아래에 둔다.

## 문제점

현재 화면은 신규 입력만 고려되어 있고, 운영 관점에서 다음이 빠져 있다.

- 최근 입력을 클릭해서 다시 수정하는 진입점이 없다.
- 저장된 relation을 폼에 다시 주입하는 상태 관리가 없다.
- `변경 후` 신규 학과 코드를 생성하는 UI가 없다.
- 서버도 `POST /api/relations`만 있고 수정용 API가 없다.

## 목표 UX

### 1. 기본 흐름

- 사용자는 상단에서 `변경 학년도`를 고른다.
- `변경 전`은 기존 드롭다운에서 선택한다.
- `변경 후`는 다음 둘 중 하나를 사용한다.
  - 기존 학과(전공) 선택
  - 신규 학과(전공) 직접 입력
- 상단 뱃지에 현재 관계의 `변경구분`이 자동으로 표시된다.
- 저장 시 신규 코드가 있으면 먼저 `curriculum_unit`을 만들고, 그 뒤 relation을 저장한다.

### 2. 기존 입력 수정 흐름

- `최근 입력` 카드 각 항목에 `수정` 버튼을 둔다.
- `수정`을 누르면 현재 폼에 해당 관계를 그대로 채운다.
- 이때 화면은 `입력 모드`가 아니라 `수정 모드`가 된다.
- 수정 모드에서는 다음이 바뀐다.
  - 저장 버튼 텍스트: `수정 저장`
  - 보조 버튼: `수정 취소`
  - 헤더 또는 상태 바에 `관계 #id 수정 중` 표시
- 수정 저장 후에는 다시 일반 입력 모드로 돌아간다.

### 3. 신규 코드 입력 흐름

- `변경 후 학과 추가` 카드 안에 토글을 둔다.
  - `기존 선택`
  - `신규 입력`
- `신규 입력` 선택 시 인라인 폼이 열린다.

권장 입력 필드:

- 학과(전공)명
- 학과 코드
- 소속단대
- 소속학부(선택)
- 단위 유형
  - `department`
  - `major`

표시 규칙:

- `department`이면 `단과대학 > 학과`
- `major`이고 소속학부가 있으면 `단과대학 > 학과(전공)`
- `major`이고 소속학부가 없으면 `단과대학 > 전공`

### 4. 드롭다운 UX

기존 선택 드롭다운은 전체 path를 그대로 보여주지 않고 아래 형식으로 압축한다.

- `단과대학 > 학과 | 코드`
- `단과대학 > 학과(전공) | 코드`
- `단과대학 > 전공 | 코드`

이 표기는 현재 `admin.html`에 이미 반영된 방향을 유지한다.

## 화면 구성안

### 상단

- 페이지 제목
- `변경 학년도` 드롭다운
- `편제 변경 이력 보기` 링크

### 본문 1: 변경 관계 입력

- 상단 상태 바
  - `변경구분` 뱃지
  - 1:1일 때 `개편 / 명칭변경` 선택 토글
  - 현재 요약 텍스트
- 좌우 2분할 카드
  - `변경 전 학과 추가`
  - `변경 후 학과 추가`
- `변경 후` 카드 안에 `기존 선택 / 신규 입력` 세그먼트
- 하단 미리보기
- 오류 / 성공 상태 메시지
- 저장 / 초기화 또는 수정 취소

### 본문 2: 최근 입력

각 카드에 다음 액션을 둔다.

- `수정`
- 이후 단계에서 필요하면 `삭제`

## 상태 설계

프런트 상태는 아래처럼 분리한다.

```js
state = {
  mode: "create" | "edit",
  editingRelationId: null,
  selectedPrev: [],
  selectedAfterExisting: [],
  draftAfterNewUnits: [],
  oneToOneType: "renewed",
  retainUntilGradYear: null
}
```

핵심은 `변경 후`를 기존 선택과 신규 입력으로 분리하는 것이다.

- `selectedAfterExisting`: 기존 코드 선택
- `draftAfterNewUnits`: 아직 생성되지 않은 신규 코드 입력 초안

저장 시에는 둘을 합쳐 `after` 집합으로 취급한다.

## API 계획

### 1. bootstrap

기존 `GET /api/admin/bootstrap`은 유지한다.

추가 검토:

- 최근 입력에 `수정` 진입을 위해 relation 상세를 바로 주입할 수 있는 데이터가 충분한지 확인
- 부족하면 `note`, `legacyRelationId`, endpoint raw 구조를 조금 더 노출

### 2. relation 조회

추가:

- `GET /api/relations/:id`

용도:

- 최근 입력에서 특정 관계를 클릭했을 때 정확한 편집 데이터를 가져온다.

### 3. relation 수정

추가:

- `PATCH /api/relations/:id`

수정 대상:

- `changeYear`
- `changeType`
- `retainUntilGradYear`
- `prev endpoints`
- `after endpoints`

정책:

- endpoint는 수정 시 전체 replace 방식이 단순하다.
- 즉, relation은 유지하고 해당 relation의 endpoint rows를 지우고 다시 insert한다.

### 4. 신규 unit 동시 생성

추가:

- `POST /api/relations` 와 `PATCH /api/relations/:id` 둘 다 신규 after unit 입력을 받을 수 있어야 한다.

예시 payload:

```json
{
  "changeYear": 2027,
  "changeType": "created",
  "retainUntilGradYear": null,
  "prevUnitCodes": [],
  "afterUnitCodes": ["HAB1100"],
  "afterNewUnits": [
    {
      "unitCode": "NEW1000",
      "unitName": "신규전공",
      "unitType": "major",
      "collegeCode": "COL1000",
      "departmentCode": "DEP1000"
    }
  ]
}
```

서버 처리 순서:

1. `afterNewUnits` 코드 중복 검사
2. `curriculum_unit` insert
3. 최종 `afterUnitCodes` 구성
4. relation insert 또는 update
5. CSV export sync

## DB / 마이그레이션 영향

기존 스키마를 크게 뜯을 필요는 없다.

필수는 아니다:

- 별도 `change_event` 테이블
- 별도 draft 테이블

필요한 건 애플리케이션 레벨 처리다.

- 신규 unit 생성 시 `curriculum_unit` insert
- relation 수정 시 `change_relation_endpoint` replace

즉 이번 요구는 **스키마 추가보다 API/UX 확장**에 가깝다.

## 구현 순서

### 1단계

- `admin.html` 현재 입력 화면 안정화
- 최근 입력 카드에 `수정` 액션 자리 마련
- `mode=create/edit` 상태 도입

### 2단계

- `GET /api/relations/:id` 구현
- 클릭한 relation 데이터를 폼에 다시 주입
- `PATCH /api/relations/:id` 구현

### 3단계

- `변경 후` 카드에 `기존 선택 / 신규 입력` 분기 UI 추가
- 신규 입력 필드 검증
- 저장 시 `afterNewUnits` 처리

### 4단계

- 수정 모드에서도 신규 after unit 생성이 가능하도록 통합
- 최근 입력 갱신 및 성공 메시지 정리

## 검증 항목

- 기존 신규 입력이 계속 동작하는지
- 수정 모드 진입 시 기존 relation이 정확히 재현되는지
- 수정 저장 후 endpoint 중복이나 orphan row가 생기지 않는지
- 신규 after code 생성 후 `curriculum_unit`과 relation이 함께 반영되는지
- 동일 코드 중복 생성이 막히는지
- CSV export 결과가 SQLite와 일치하는지

## 보류 항목

이번 계획에서는 아래는 보류한다.

- 기존 relation 삭제
- 생성된 `curriculum_unit` 자체의 독립 수정
- 여러 relation에 걸친 대량 편집
- 드래그 앤 드롭이나 복잡한 시각 편집 UX

## 결론

운영 규칙을 기준으로 보면 가장 자연스러운 방향은 다음이다.

- `변경 전`: 기존 선택만 허용
- `변경 후`: 기존 선택 + 신규 직접 입력 허용
- `최근 입력`: 수정 진입점 제공
- `서버`: relation 수정과 after 신규 unit 동시 생성 지원

즉, 관리자 화면은 더 이상 단순 입력 폼이 아니라
`신규 입력 + 기존 관계 수정 + 변경 후 신규 코드 생성`
을 한 자리에서 처리하는 편집 화면으로 가야 한다.
