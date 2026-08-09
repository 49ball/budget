// D1에 적재된 KIS 종목 마스터 조회.
// 마스터에는 국내 종목뿐 아니라 해외 종목의 한글명(애플, 테슬라 …)도 들어있어서
// 예전에 손으로 관리하던 별칭 테이블을 대신한다.

const SEARCH_LIMIT = 20;

export async function searchSymbols(db, query) {
    const text = String(query || '').trim();
    if (!text) return [];

    const contains = `%${text}%`;
    const exact = text.toUpperCase();
    const prefix = `${text}%`;

    const { results } = await db.prepare(
        `SELECT ticker, code, name, name_en, market, exchange
         FROM symbols
         WHERE name LIKE ?1 OR name_en LIKE ?1 OR ticker LIKE ?1 OR code LIKE ?1
         ORDER BY
             CASE
                 WHEN ticker = ?2 OR code = ?2 OR name = ?3 THEN 0
                 WHEN name LIKE ?4 OR name_en LIKE ?4 OR ticker LIKE ?4 THEN 1
                 ELSE 2
             END,
             priority,
             LENGTH(name),
             name
         LIMIT ${SEARCH_LIMIT}`
    ).bind(contains, exact, text, prefix).all();

    return results.map(row => ({
        symbol: row.ticker,
        name: row.name || row.name_en || row.ticker,
        exchange: row.exchange,
        type: row.market === 'domestic' ? '국내주식' : '해외주식'
    }));
}

export async function findByTicker(db, ticker) {
    const row = await db.prepare(
        'SELECT ticker, code, name, name_en, market, exchange FROM symbols WHERE ticker = ?'
    ).bind(String(ticker || '').toUpperCase()).first();
    return row || null;
}

// 국내 종목은 6자리 코드가 유일하므로 .KS/.KQ 접미사 유무와 무관하게 찾을 수 있다.
export async function findDomesticByCode(db, code) {
    const row = await db.prepare(
        "SELECT ticker, code, name, name_en, market, exchange FROM symbols WHERE market = 'domestic' AND code = ?"
    ).bind(String(code || '')).first();
    return row || null;
}

// 티커로 분류되지 않은 입력(한글 종목명 등)을 마스터에서 찾아본다.
export async function findByName(db, name) {
    const text = String(name || '').trim();
    if (!text) return null;

    const row = await db.prepare(
        `SELECT ticker, code, name, name_en, market, exchange
         FROM symbols
         WHERE name = ?1 OR name_en = ?1
         ORDER BY LENGTH(name)
         LIMIT 1`
    ).bind(text).first();
    return row || null;
}
