# budget
커플 가계부

## Yahoo Finance 시세 연동 설정

이 가계부는 Cloudflare Worker를 통해 Yahoo Finance 시세를 가져옵니다.

1. Cloudflare 계정을 만들고 Workers & Pages에서 새 Worker를 만듭니다.
2. `workers/price-worker.js` 내용을 Worker 코드로 붙여넣고 배포합니다.
3. 배포된 주소를 복사합니다. 예: `https://budget-price-worker.계정명.workers.dev`
4. 가계부에서 `시세 업데이트` 버튼을 누르고 Worker 주소를 한 번 입력합니다.
5. 주식 계좌에는 Yahoo Finance 티커와 보유 수량을 입력합니다.

티커 예시:
- 미국 주식: `AAPL`, `NVDA`, `MSFT`
- 한국 코스피: `005930.KS`
- 한국 코스닥: `086520.KQ`
- 코인: `BTC-USD`, `ETH-USD`, `XRP-USD` 또는 `bitcoin`, `eth`, `xrp`

Cloudflare CLI를 쓸 수 있다면 저장소 루트에서 `wrangler deploy`로도 배포할 수 있습니다.
