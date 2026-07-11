# 커플 가계부 공유 앱 전환 설계

## 배경

현재 `index.html`은 정적 단일 HTML 파일로, 모든 데이터가 브라우저 `localStorage`에만 저장된다. 정태와 민주는 각자 자신의 기기에서 이 앱을 따로 실행하며, `정태가계부.json` / `민주가계부.json` 형태의 수동 백업 파일로 각자의 데이터를 관리해왔다. 두 사람의 가계부는 서로 완전히 분리되어 있고, 앞으로도 분리된 상태를 유지한다.

## 목표

- 각자의 가계부는 지금처럼 분리해서 입력/관리하되, 데이터를 온라인(Cloudflare)에 저장해 특정 브라우저/기기에 종속되지 않게 한다.
- 서로의 가계부를 조회(읽기 전용)할 수 있게 한다.
- 홈 화면에 설치해서 네이티브 앱처럼 열리게 한다 (PWA).
- 기존 백업 JSON 데이터를 그대로 이전할 수 있어야 한다.

## 스코프 밖 (Out of scope)

- 실시간 동기화 (WebSocket 등) — 새로고침/재진입 시 동기화로 충분
- 오프라인 사용 (인터넷 연결 필요 전제)
- 상대방 가계부 편집 권한 — 조회만 가능
- 두 사람의 거래 내역을 하나로 합친 통합 대시보드/합산 뷰
- 앱스토어 배포 (네이티브 앱 빌드)

## 아키텍처

```
[정태 기기]                [민주 기기]
     │                          │
     └──────────┬───────────────┘
                │  fetch() (개별 코드로 인증)
                ▼
   GitHub Pages (index.html — 기존 그대로 유지)
                │
                ▼
   Cloudflare Worker (기존 price-worker.js에 API 확장)
                │
                ▼
   Cloudflare D1 (SQLite 기반 온라인 DB)
```

- 프론트엔드는 GitHub Pages에 계속 배포한다. UI/렌더링 로직은 그대로 유지하고, 데이터 저장/조회 부분만 `localStorage` 호출에서 Worker API `fetch()` 호출로 교체한다.
- 백엔드는 기존 `workers/price-worker.js`가 배포된 Cloudflare Worker에 API 라우트를 추가하고, D1 데이터베이스를 바인딩한다. 시세 조회 기능과 공존한다.
- 인증은 사람별 개별 코드로 한다 (아래 "인증" 절 참조).

## 데이터 모델 (Cloudflare D1)

```sql
-- 커플 단위
couples (
  id TEXT PRIMARY KEY,
  created_at TEXT
)

-- 사람 단위 (코드로 식별 + 인증 겸용)
members (
  id TEXT PRIMARY KEY,
  couple_id TEXT REFERENCES couples(id),
  code TEXT UNIQUE NOT NULL,   -- 로그인 코드 (예: 정태 코드, 민주 코드)
  name TEXT NOT NULL,          -- 표시 이름 (예: "정태", "민주")
  created_at TEXT
)

-- 거래 내역: 한 줄씩 저장, 소유자(member) 기준으로 안전하게 추가됨
transactions (
  id TEXT PRIMARY KEY,
  member_id TEXT REFERENCES members(id),
  type TEXT,           -- 수입/지출
  amount INTEGER,
  category TEXT,
  memo TEXT,
  date TEXT,
  account_id TEXT,
  created_at TEXT
)

-- 설정값: 사람별 JSON 한 덩어리로 저장 (덮어쓰기 방식)
settings (
  member_id TEXT PRIMARY KEY REFERENCES members(id),
  accounts_json TEXT,
  categories_json TEXT,
  monthly_budgets_json TEXT,
  fixed_expenses_json TEXT,
  monthly_goals_json TEXT,
  monthly_assets_json TEXT,
  title TEXT,
  updated_at TEXT
)
```

거래 내역은 테이블에 행 단위로 추가되므로, 같은 사람이 여러 기기에서 쓰는 경우가 아니라면 데이터 유실 위험이 없다. 설정값은 사람별로 완전히 분리되어 있어(다른 사람이 쓸 일이 없음) 통째로 덮어써도 안전하다.

## 인증

- 정태 코드, 민주 코드를 각각 발급해 두 사람에게 전달한다 (커플당 2개 코드, `members.code`에 저장).
- 앱 최초 실행 시 코드 입력 → 해당 `member_id`를 기기에 저장(로컬 스토리지 또는 쿠키)해 이후 자동 로그인.
- 로그인한 코드의 `couple_id`를 이용해 같은 커플의 상대방 `member`를 조회할 수 있다 (상대방 데이터 조회용).

## 초기 설정 (코드 발급)

두 사람 외에는 가입할 일이 없으므로 별도의 회원가입 화면은 만들지 않는다. `couples` 1건과 `members` 2건(정태, 민주)은 최초 배포 시 1회성 시드 스크립트(또는 `wrangler d1 execute`로 직접 INSERT)로 생성하고, 발급된 코드를 두 사람에게 직접 전달한다.

## API 엔드포인트 (Worker)

- `POST /api/login` — 코드 검증, `member_id` / 상대방 `member` 정보 반환
- `GET /api/books/:memberId` — 해당 사람의 거래 내역 + 설정값 전체 조회
- `POST /api/books/:memberId/transactions` — 거래 내역 1건 추가
- `PUT /api/books/:memberId/transactions/:id` — 거래 내역 1건 수정
- `DELETE /api/books/:memberId/transactions/:id` — 거래 내역 1건 삭제
- `PUT /api/books/:memberId/settings` — 설정값 전체 덮어쓰기
- `POST /api/books/:memberId/import` — 백업 JSON 파일 일괄 이전 (아래 "마이그레이션" 참조)

쓰기 API(`transactions`, `settings`, `import`)는 요청자의 `member_id`가 URL의 `:memberId`와 일치할 때만 허용한다 (본인 책만 쓰기 가능, 상대방 책은 조회 전용).

## 화면 구성

- 로그인 화면: 코드 입력 (최초 1회, 이후 자동 로그인)
- 상단 탭 2개: **"내 가계부" / "OO 가계부"**
  - 기존의 모든 화면(거래 목록, 차트, 캘린더, 자산 추이 등)은 그대로 유지하되, 탭에 따라 표시 데이터(내 것 / 상대방 것)만 전환
  - 상대방 탭에서는 입력/수정/삭제 관련 버튼과 폼을 숨긴다 (조회 전용)

## 동기화 방식

- 사용자가 거래를 추가/수정/삭제하거나 설정을 변경하는 즉시, 해당 API를 자동 호출해 D1에 반영한다 (기존에 매 변경마다 `localStorage.setItem`을 호출하던 것과 동일한 타이밍, 별도의 "저장" 버튼 없음).
- 상대방이 입력한 내용은 앱 재진입/새로고침 시점에 반영된다 (실시간 아님).
- 각자 자신의 책에만 쓰기 때문에, 두 사람이 동시에 같은 데이터를 수정해서 유실되는 상황은 발생하지 않는다.

## 마이그레이션 (기존 데이터 이전)

- 기존 "📂 백업 불러오기" 기능(`index.html`의 `exportData`/`importData` 로직)을 재사용한다.
- 각자 처음 코드로 로그인한 뒤, 자신의 백업 JSON(`정태가계부.json` / `민주가계부.json`)을 업로드하면 `POST /api/books/:memberId/import`가 파일 내용을 파싱해 D1에 일괄 저장한다.
- 이 과정은 선택 사항이며 건너뛸 수 있다 (새로 시작해도 무방).

## PWA (홈 화면 설치)

- `manifest.json` 추가: 앱 이름, 아이콘, `display: "standalone"`, 테마 색
- 최소한의 서비스 워커 등록 (오프라인 캐싱 없이, 설치 가능 조건 충족 용도)
- `index.html`에 매니페스트 링크와 아이콘 메타태그 추가
- 결과: 브라우저에서 "홈 화면에 추가" 시 주소창 없이 전체 화면 앱처럼 열림

## 에러 처리

- 잘못된 코드 입력 → 안내 메시지 표시
- 네트워크 오류 (오프라인 등) → "인터넷 연결을 확인해주세요" 안내 + 재시도 버튼, 입력 중이던 내용은 화면에서 지우지 않음
- 저장 실패 시 → 사용자에게 실패를 알리고 재시도 유도 (조용히 무시하지 않음)

## 배포

- 프론트엔드: 기존과 동일하게 GitHub Pages (main 브랜치 push 시 자동 반영)
- 백엔드: `wrangler deploy`로 Worker + D1 갱신 (기존 배포 흐름 확장)
