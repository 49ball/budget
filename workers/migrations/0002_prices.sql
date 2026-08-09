-- KIS 접근토큰 캐시. 토큰은 24시간짜리이고 발급할 때마다 알림톡이 발송되며
-- 1분에 1회만 발급할 수 있으므로, 반드시 재사용해야 한다. 항상 id = 1 한 행만 쓴다.
CREATE TABLE kis_token (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    access_token TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    renewing_at TEXT,
    updated_at TEXT NOT NULL
);

-- 갱신 선점(claim)을 UPDATE ... WHERE로 처리하려면 행이 항상 존재해야 한다.
-- access_token이 빈 문자열이면 '아직 토큰 없음'으로 취급한다.
INSERT INTO kis_token (id, access_token, expires_at, renewing_at, updated_at)
VALUES (1, '', '1970-01-01T00:00:00.000Z', NULL, '1970-01-01T00:00:00.000Z');

-- KIS 종목 마스터. scripts/build-symbol-master.js가 채운다.
-- ticker: 가계부에 저장되는 티커 (005930.KS, AAPL)
-- code:   KIS 조회에 넘기는 코드 (005930, AAPL)
-- priority: 검색 결과 정렬용. 국내는 마스터의 시가총액 규모(1:대형 2:중형 3:소형),
--           그 외에는 4. '삼성'을 검색했을 때 삼성공조보다 삼성전자가 위로 오게 한다.
CREATE TABLE symbols (
    ticker TEXT PRIMARY KEY,
    code TEXT NOT NULL,
    name TEXT NOT NULL,
    name_en TEXT NOT NULL DEFAULT '',
    market TEXT NOT NULL,
    exchange TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 4
);

CREATE INDEX idx_symbols_name ON symbols(name);
CREATE INDEX idx_symbols_code ON symbols(code);
