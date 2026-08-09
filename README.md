# budget
커플 가계부

## 시세 연동 설정 (한국투자증권 KIS OpenAPI)

시세는 Cloudflare Worker가 종목 종류별로 나눠서 가져옵니다.

| 종목 | 시세 출처 |
| --- | --- |
| 국내주식 | KIS 국내주식 현재가 (실시간) |
| 해외주식 | KIS 해외주식 현재가상세 (원화 환산 포함) |
| 코인 | 업비트 원화 마켓 |
| 금 | KRX 금현물 |
| 종목 검색 | KIS 종목 마스터 (D1에 적재) |

### 1. KIS 앱키 발급

[KIS Developers](https://apiportal.koreainvestment.com)에서 실전투자용 앱키를 발급받습니다.

```sh
wrangler secret put KIS_APP_KEY
wrangler secret put KIS_APP_SECRET
wrangler secret put KRX_AUTH_KEY   # 금현물 시세용 (기존과 동일)
```

접근토큰은 D1의 `kis_token` 테이블에 캐싱됩니다. KIS 토큰은 발급할 때마다 알림톡이
발송되고 1분에 1회만 발급할 수 있어서, 이 캐시를 거치지 않고 직접 발급하면 안 됩니다.

### 2. 마이그레이션과 종목 마스터 적재

```sh
npm run d1:migrate:remote
npm run symbols:sync          # 종목 마스터 다운로드 → D1 적재
```

`symbols:sync`는 KIS가 공개하는 종목 마스터(코스피/코스닥/나스닥/뉴욕/아멕스)를 받아
`symbols` 테이블에 넣습니다. 신규 상장·폐지가 반영되지 않을 때 다시 실행하면 됩니다.
로컬 D1에 넣으려면 `npm run symbols:sync:local`을 씁니다.

### 3. 배포

```sh
wrangler deploy
```

가계부에서 `시세 업데이트` 버튼을 누르고 Worker 주소를 한 번 입력하면 됩니다.
예: `https://budget-price-worker.계정명.workers.dev`

### 티커 입력 방법

- 미국 주식: `AAPL`, `NVDA`, `MSFT`
- 한국 주식: `005930.KS`, `086520.KQ` (`005930`처럼 6자리 코드만 입력해도 됩니다)
- 코인: `BTC-USD`, `ETH-USD`, `XRP-USD`
- 금: `KRX-GOLD` (수량은 보유 g 기준)

종목명으로도 조회됩니다. `애플`, `삼성전자`처럼 한글 이름을 그대로 입력하거나,
계좌 추가 화면의 검색 버튼으로 티커를 찾을 수 있습니다.

## 개발

```sh
npm test                      # Worker 단위/통합 테스트
npm run d1:migrate:local
```

시세 관련 코드는 시세 출처별로 나뉘어 있습니다.

```
workers/prices/
  index.js      라우팅과 응답 조립
  symbols.js    티커 → 자산군 분류
  kis-auth.js   KIS 토큰 발급과 D1 캐싱
  kis.js        KIS 시세 조회
  upbit.js      코인 시세
  krx.js        금현물 시세
  search.js     종목 마스터 검색
```
