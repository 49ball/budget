// 시세 API. 종목 종류에 따라 KIS / 업비트 / KRX로 나눠 조회한 뒤 하나의 응답으로 합친다.
//
// 응답 형태는 기존 야후 기반 워커와 동일하게 유지한다. 가계부 프론트가
// quotes[요청한 티커 문자열]로 조회하므로, 요청받은 심볼 문자열을 그대로 키로 쓴다.

import { classify, normalizeSymbols, isGoldQuery, GOLD_SYMBOL } from './symbols.js';
import { fetchDomesticQuote, fetchOverseasQuote } from './kis.js';
import { fetchCryptoQuotes } from './upbit.js';
import { fetchGoldQuote } from './krx.js';
import { searchSymbols, findByTicker, findDomesticByCode, findByName } from './search.js';

// KIS 실전 계정은 초당 20건 제한이 있다. 여유를 두고 동시 요청 수를 묶는다.
const MAX_CONCURRENCY = 8;

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
};

export default {
    async fetch(request, env) {
        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: CORS_HEADERS });
        }

        const url = new URL(request.url);

        if (url.pathname === '/search') {
            return handleSearch(url, env);
        }
        if (url.pathname === '/prices') {
            return handlePrices(url, env);
        }

        return jsonResponse({
            success: true,
            message: 'Use /prices?symbols=AAPL,005930.KS or /search?q=삼성전자'
        });
    }
};

async function handleSearch(url, env) {
    const query = String(url.searchParams.get('q') || '').trim();
    if (!query) {
        return jsonResponse({ success: false, message: 'q query parameter is required.' }, 400);
    }

    try {
        if (isGoldQuery(query)) {
            return jsonResponse({
                success: true,
                query,
                results: [{ symbol: GOLD_SYMBOL, name: 'KRX 금현물', exchange: 'KRX', type: '금현물' }]
            });
        }

        return jsonResponse({ success: true, query, results: await searchSymbols(env.DB, query) });
    } catch (error) {
        return jsonResponse({
            success: false,
            message: error.message || 'Failed to search symbols.'
        }, 502);
    }
}

async function handlePrices(url, env) {
    const symbols = normalizeSymbols(url.searchParams.get('symbols'));
    if (symbols.length === 0) {
        return jsonResponse({ success: false, message: 'symbols query parameter is required.' }, 400);
    }

    try {
        const targets = await resolveTargets(env.DB, symbols);
        const rows = await fetchQuoteRows(env, targets);

        const updatedAt = new Date().toISOString();
        const quotes = {};
        const missing = [];
        const errors = {};

        targets.forEach(target => {
            const row = rows[target.symbol];

            if (!row || row.error || !row.price) {
                missing.push(target.symbol);
                if (row?.error) errors[target.symbol] = row.error;
                return;
            }

            quotes[target.symbol] = {
                symbol: target.symbol,
                name: target.name || row.name || target.symbol,
                price: row.price,
                currency: row.currency,
                fxRate: row.fxRate,
                krwPrice: row.krwPrice,
                marketTime: row.marketTime || updatedAt,
                updatedAt
            };
        });

        return jsonResponse({ success: true, updatedAt, quotes, missing, errors });
    } catch (error) {
        return jsonResponse({
            success: false,
            message: error.message || 'Failed to fetch prices.'
        }, 502);
    }
}

// 티커 문자열만으로 정해지지 않는 부분(해외 거래소 코드, 한글 종목명)을 마스터로 채운다.
async function resolveTargets(db, symbols) {
    return Promise.all(symbols.map(async symbol => {
        const classified = classify(symbol);

        if (classified.kind === 'gold' || classified.kind === 'crypto') {
            return classified;
        }

        if (classified.kind === 'domestic') {
            const master = await findDomesticByCode(db, classified.code);
            return { ...classified, name: master?.name || '' };
        }

        const master = classified.kind === 'overseas'
            ? await findByTicker(db, symbol)
            : await findByName(db, symbol);

        if (!master) {
            return {
                kind: 'error',
                symbol,
                error: `종목 마스터에서 '${symbol}'을(를) 찾지 못했습니다. npm run symbols:sync로 마스터를 갱신해보세요.`
            };
        }

        if (master.market === 'domestic') {
            return { kind: 'domestic', symbol, code: master.code, name: master.name };
        }

        return {
            kind: 'overseas',
            symbol,
            code: master.code,
            exchange: master.exchange,
            name: master.name
        };
    }));
}

async function fetchQuoteRows(env, targets) {
    const cryptoTargets = targets.filter(target => target.kind === 'crypto');
    const sequentialTargets = targets.filter(target => target.kind !== 'crypto');

    const [cryptoRows, otherRows] = await Promise.all([
        fetchCryptoQuotes(cryptoTargets),
        mapWithLimit(sequentialTargets, MAX_CONCURRENCY, async target => {
            if (target.kind === 'error') {
                return [target.symbol, { error: target.error }];
            }

            try {
                if (target.kind === 'gold') return [target.symbol, await fetchGoldQuote(env)];
                if (target.kind === 'domestic') return [target.symbol, await fetchDomesticQuote(env, target)];
                return [target.symbol, await fetchOverseasQuote(env, target)];
            } catch (error) {
                return [target.symbol, { error: error.message || '시세를 가져오지 못했습니다.' }];
            }
        })
    ]);

    return { ...cryptoRows, ...Object.fromEntries(otherRows) };
}

async function mapWithLimit(items, limit, task) {
    const results = new Array(items.length);
    let cursor = 0;

    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (cursor < items.length) {
            const index = cursor;
            cursor += 1;
            results[index] = await task(items[index]);
        }
    });

    await Promise.all(runners);
    return results;
}

// 실패한 응답을 캐시하면 원인을 고친 뒤에도 캐시가 만료될 때까지 같은 오류가 계속 보인다.
// 종목이 하나라도 실패했으면 캐시하지 않는다.
function isCacheable(body, status) {
    return status === 200
        && body.success !== false
        && Object.keys(body.errors || {}).length === 0
        && (body.missing || []).length === 0;
}

function jsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            ...CORS_HEADERS,
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': isCacheable(body, status) ? 'public, max-age=300' : 'no-store'
        }
    });
}
