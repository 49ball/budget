import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import priceWorker from './index.js';
import { resetInflightRenewal } from './kis-auth.js';

const TEST_ENV = {
    DB: env.DB,
    KIS_APP_KEY: 'test-key',
    KIS_APP_SECRET: 'test-secret',
    KIS_BASE_URL: 'https://kis.test'
};

function json(body, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

// 요청 URL에 포함된 문자열로 응답을 고른다. 등록되지 않은 요청은 테스트를 실패시킨다.
function stubFetch(routes) {
    const fetchMock = vi.fn(async input => {
        const href = input instanceof URL ? input.href : (typeof input === 'string' ? input : input.url);
        const match = Object.entries(routes).find(([pattern]) => href.includes(pattern));
        if (!match) throw new Error(`예상하지 못한 요청: ${href}`);
        return match[1](new URL(href));
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

const TOKEN_ROUTE = { '/oauth2/tokenP': () => json({ access_token: 'test-token', expires_in: 86400 }) };

function domesticRoute(body) {
    return { '/quotations/inquire-price': () => json(body) };
}

function overseasRoute(body) {
    return { '/quotations/price-detail': () => json(body) };
}

async function seedSymbols() {
    const insert = 'INSERT INTO symbols (ticker, code, name, name_en, market, exchange, priority) VALUES (?, ?, ?, ?, ?, ?, ?)';
    await env.DB.batch([
        env.DB.prepare(insert).bind('005930.KS', '005930', '삼성전자', '', 'domestic', 'KOSPI', 1),
        env.DB.prepare(insert).bind('006660.KS', '006660', '삼성공조', '', 'domestic', 'KOSPI', 3),
        env.DB.prepare(insert).bind('086520.KQ', '086520', '에코프로', '', 'domestic', 'KOSDAQ', 1),
        env.DB.prepare(insert).bind('AAPL', 'AAPL', '애플', 'APPLE INC', 'overseas', 'NAS', 2),
        env.DB.prepare(insert).bind('BRK.B', 'BRK.B', '버크셔해서웨이', 'BERKSHIRE HATHAWAY', 'overseas', 'NYS', 2)
    ]);
}

function get(path) {
    return priceWorker.fetch(new Request(`https://example.com${path}`), TEST_ENV);
}

beforeEach(async () => {
    resetInflightRenewal();
    await env.DB.exec('DELETE FROM symbols');
    await env.DB.prepare(
        "UPDATE kis_token SET access_token = 'test-token', expires_at = ?, renewing_at = NULL WHERE id = 1"
    ).bind(new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString()).run();
    await seedSymbols();
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('GET /prices - 국내주식', () => {
    it('KIS 현재가를 원화 시세로 그대로 쓴다', async () => {
        stubFetch({
            ...TOKEN_ROUTE,
            ...domesticRoute({ rt_cd: '0', output: { stck_prpr: '71500', hts_kor_isnm: '삼성전자' } })
        });

        const data = await (await get('/prices?symbols=005930.KS')).json();

        expect(data.success).toBe(true);
        expect(data.quotes['005930.KS']).toMatchObject({
            symbol: '005930.KS',
            name: '삼성전자',
            price: 71500,
            currency: 'KRW',
            fxRate: 1,
            krwPrice: 71500
        });
        expect(data.missing).toEqual([]);
    });

    it('접미사 없는 6자리 코드도 마스터에서 종목명을 찾는다', async () => {
        stubFetch({
            ...TOKEN_ROUTE,
            ...domesticRoute({ rt_cd: '0', output: { stck_prpr: '71500' } })
        });

        const data = await (await get('/prices?symbols=005930')).json();
        expect(data.quotes['005930'].name).toBe('삼성전자');
    });

    it('KIS 종목코드로 조회한다', async () => {
        const fetchMock = stubFetch({
            ...TOKEN_ROUTE,
            ...domesticRoute({ rt_cd: '0', output: { stck_prpr: '1000' } })
        });

        await get('/prices?symbols=086520.KQ');

        const quoteCall = fetchMock.mock.calls.find(([input]) => String(input).includes('inquire-price'));
        const url = new URL(String(quoteCall[0]));
        expect(url.searchParams.get('FID_INPUT_ISCD')).toBe('086520');
        expect(url.searchParams.get('FID_COND_MRKT_DIV_CODE')).toBe('J');
    });
});

describe('GET /prices - 해외주식', () => {
    it('마스터에서 찾은 거래소 코드로 조회하고 원환산가격을 쓴다', async () => {
        const fetchMock = stubFetch({
            ...TOKEN_ROUTE,
            ...overseasRoute({ rt_cd: '0', output: { last: '250.5', curr: 'USD', t_rate: '1390.5', t_xprc: '348320' } })
        });

        const data = await (await get('/prices?symbols=AAPL')).json();

        const quoteCall = fetchMock.mock.calls.find(([input]) => String(input).includes('price-detail'));
        expect(new URL(String(quoteCall[0])).searchParams.get('EXCD')).toBe('NAS');

        expect(data.quotes.AAPL).toMatchObject({
            name: '애플',
            price: 250.5,
            currency: 'USD',
            fxRate: 1390.5,
            krwPrice: 348320
        });
    });

    it('원환산가격이 없으면 당일환율로 계산한다', async () => {
        stubFetch({
            ...TOKEN_ROUTE,
            ...overseasRoute({ rt_cd: '0', output: { last: '100', curr: 'USD', t_rate: '1400' } })
        });

        const data = await (await get('/prices?symbols=AAPL')).json();
        expect(data.quotes.AAPL.krwPrice).toBe(140000);
    });

    it('마스터에 없는 티커는 안내 메시지와 함께 missing으로 보낸다', async () => {
        stubFetch(TOKEN_ROUTE);

        const data = await (await get('/prices?symbols=ZZZZ')).json();

        expect(data.success).toBe(true);
        expect(data.missing).toEqual(['ZZZZ']);
        expect(data.errors.ZZZZ).toMatch(/종목 마스터/);
    });
});

describe('GET /prices - 코인', () => {
    it('업비트 원화 마켓 시세를 한 번의 호출로 가져온다', async () => {
        const fetchMock = stubFetch({
            'api.upbit.com': () => json([
                { market: 'KRW-BTC', trade_price: 95000000, trade_timestamp: 1700000000000 },
                { market: 'KRW-ETH', trade_price: 5000000, trade_timestamp: 1700000000000 }
            ])
        });

        const data = await (await get('/prices?symbols=BTC-USD,ETH-USD')).json();

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(data.quotes['BTC-USD']).toMatchObject({ price: 95000000, currency: 'KRW', krwPrice: 95000000 });
        expect(data.quotes['ETH-USD'].krwPrice).toBe(5000000);
    });

    it('업비트에 없는 마켓은 missing으로 보낸다', async () => {
        stubFetch({ 'api.upbit.com': () => json([]) });

        const data = await (await get('/prices?symbols=BTC-USD')).json();
        expect(data.missing).toEqual(['BTC-USD']);
        expect(data.errors['BTC-USD']).toMatch(/KRW-BTC/);
    });
});

describe('GET /prices - 오류 처리', () => {
    it('KIS가 rt_cd로 실패를 알리면 그 메시지를 종목별 오류로 담고 200을 유지한다', async () => {
        stubFetch({
            ...TOKEN_ROUTE,
            ...domesticRoute({ rt_cd: '1', msg_cd: 'MCA00100', msg1: '조회할 자료가 없습니다.  ' })
        });

        const res = await get('/prices?symbols=005930.KS');
        const data = await res.json();

        expect(res.status).toBe(200);
        expect(data.success).toBe(true);
        expect(data.errors['005930.KS']).toBe('조회할 자료가 없습니다.');
        expect(data.missing).toEqual(['005930.KS']);
    });

    it('한 종목이 실패해도 나머지는 정상 반환한다', async () => {
        stubFetch({
            ...TOKEN_ROUTE,
            ...domesticRoute({ rt_cd: '0', output: { stck_prpr: '71500' } }),
            ...overseasRoute({ rt_cd: '1', msg1: '해외 시세 조회 실패' })
        });

        const data = await (await get('/prices?symbols=005930.KS,AAPL')).json();

        expect(data.quotes['005930.KS'].price).toBe(71500);
        expect(data.missing).toEqual(['AAPL']);
    });

    it('symbols가 없으면 400을 반환한다', async () => {
        const res = await get('/prices');
        expect(res.status).toBe(400);
    });

    // 실패를 캐시하면 원인을 고친 뒤에도 캐시가 만료될 때까지 같은 오류가 보인다.
    it('실패한 종목이 있으면 응답을 캐시하지 않는다', async () => {
        stubFetch({
            ...TOKEN_ROUTE,
            ...domesticRoute({ rt_cd: '1', msg1: '조회할 자료가 없습니다.' })
        });

        const res = await get('/prices?symbols=005930.KS');
        expect(res.headers.get('Cache-Control')).toBe('no-store');
    });

    it('전부 성공하면 응답을 캐시한다', async () => {
        stubFetch({
            ...TOKEN_ROUTE,
            ...domesticRoute({ rt_cd: '0', output: { stck_prpr: '71500' } })
        });

        const res = await get('/prices?symbols=005930.KS');
        expect(res.headers.get('Cache-Control')).toBe('public, max-age=300');
    });
});

describe('GET /search', () => {
    it('한글 종목명으로 국내외 종목을 찾는다', async () => {
        const data = await (await get('/search?q=삼성')).json();
        expect(data.success).toBe(true);
        expect(data.results[0]).toEqual({
            symbol: '005930.KS',
            name: '삼성전자',
            exchange: 'KOSPI',
            type: '국내주식'
        });
    });

    it('이름이 여럿 걸리면 시가총액 규모가 큰 종목을 먼저 보여준다', async () => {
        const data = await (await get('/search?q=삼성')).json();
        expect(data.results.map(row => row.name)).toEqual(['삼성전자', '삼성공조']);
    });

    it('해외 종목도 한글명으로 찾는다', async () => {
        const data = await (await get('/search?q=애플')).json();
        expect(data.results[0]).toMatchObject({ symbol: 'AAPL', exchange: 'NAS', type: '해외주식' });
    });

    it('영문명으로도 찾는다', async () => {
        const data = await (await get('/search?q=BERKSHIRE')).json();
        expect(data.results[0].symbol).toBe('BRK.B');
    });

    it('금은 마스터를 거치지 않고 바로 응답한다', async () => {
        const data = await (await get('/search?q=금')).json();
        expect(data.results).toEqual([{ symbol: 'KRX-GOLD', name: 'KRX 금현물', exchange: 'KRX', type: '금현물' }]);
    });

    it('q가 없으면 400을 반환한다', async () => {
        const res = await get('/search');
        expect(res.status).toBe(400);
    });
});

describe('한글 종목명을 티커 대신 저장해둔 경우', () => {
    it('마스터에서 종목을 찾아 시세를 조회한다', async () => {
        const fetchMock = stubFetch({
            ...TOKEN_ROUTE,
            ...domesticRoute({ rt_cd: '0', output: { stck_prpr: '71500' } })
        });

        const data = await (await get(`/prices?symbols=${encodeURIComponent('삼성전자')}`)).json();

        const quoteCall = fetchMock.mock.calls.find(([input]) => String(input).includes('inquire-price'));
        expect(new URL(String(quoteCall[0])).searchParams.get('FID_INPUT_ISCD')).toBe('005930');
        expect(data.quotes['삼성전자']).toMatchObject({ name: '삼성전자', krwPrice: 71500 });
    });
});
