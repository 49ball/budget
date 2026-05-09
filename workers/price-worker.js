const YAHOO_CHART_URLS = [
    'https://query1.finance.yahoo.com/v8/finance/chart',
    'https://query2.finance.yahoo.com/v8/finance/chart'
];
const YAHOO_SEARCH_URLS = [
    'https://query1.finance.yahoo.com/v1/finance/search',
    'https://query2.finance.yahoo.com/v1/finance/search'
];
const KRX_API_BASE_URL = 'https://data-dbg.krx.co.kr/svc/apis';
const KRX_GOLD_SYMBOL = 'KRX-GOLD';
const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
};

function jsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            ...CORS_HEADERS,
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'public, max-age=300'
        }
    });
}

function normalizeSymbols(value) {
    const stockAliases = {
        애플: 'AAPL',
        APPLE: 'AAPL',
        엔비디아: 'NVDA',
        NVIDIA: 'NVDA',
        테슬라: 'TSLA',
        TESLA: 'TSLA',
        마이크로소프트: 'MSFT',
        MICROSOFT: 'MSFT',
        삼성전자: '005930.KS',
        삼성: '005930.KS',
        네이버: '035420.KS',
        NAVER: '035420.KS',
        카카오: '035720.KS',
        에코프로: '086520.KQ'
    };
    const cryptoAliases = {
        BITCOIN: 'BTC-USD',
        BTC: 'BTC-USD',
        ETHEREUM: 'ETH-USD',
        ETH: 'ETH-USD',
        RIPPLE: 'XRP-USD',
        XRP: 'XRP-USD',
        DOGECOIN: 'DOGE-USD',
        DOGE: 'DOGE-USD',
        SOLANA: 'SOL-USD',
        SOL: 'SOL-USD',
        CARDANO: 'ADA-USD',
        ADA: 'ADA-USD'
    };
    const goldAliases = {
        GOLD: KRX_GOLD_SYMBOL,
        'KRX-GOLD': KRX_GOLD_SYMBOL,
        KRXGOLD: KRX_GOLD_SYMBOL,
        금: KRX_GOLD_SYMBOL,
        금현물: KRX_GOLD_SYMBOL,
        KRX금: KRX_GOLD_SYMBOL
    };

    return [...new Set(String(value || '')
        .split(',')
        .map(symbol => symbol.trim().toUpperCase())
        .map(symbol => stockAliases[symbol] || symbol)
        .map(symbol => cryptoAliases[symbol] || symbol)
        .map(symbol => goldAliases[symbol] || symbol)
        .map(symbol => /^\d{6}$/.test(symbol) ? `${symbol}.KS` : symbol)
        .filter(Boolean)
        .slice(0, 50))];
}

function parseNumber(value) {
    if (typeof value === 'number') return value;
    const normalized = String(value || '').replace(/,/g, '').replace(/[^\d.-]/g, '');
    const parsed = parseFloat(normalized);
    return Number.isFinite(parsed) ? parsed : null;
}

function formatKrxDate(date) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Seoul',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return `${values.year}${values.month}${values.day}`;
}

function getRecentKrxDates(days = 14) {
    const oneDayMs = 24 * 60 * 60 * 1000;
    return Array.from({ length: days }, (_, index) => formatKrxDate(new Date(Date.now() - index * oneDayMs)));
}

function pickGoldRow(rows) {
    return rows.find(row => String(row.ISU_NM || '').includes('1Kg'))
        || rows.find(row => String(row.ISU_NM || '').includes('금'))
        || rows[0]
        || null;
}

function isGoldQuery(value) {
    const query = String(value || '').trim().toUpperCase().replace(/\s+/g, '');
    return ['GOLD', 'KRX-GOLD', 'KRXGOLD', '금', '금현물', 'KRX금'].includes(query);
}

async function fetchKrxGoldQuote(env) {
    const authKey = env?.KRX_AUTH_KEY;
    if (!authKey) {
        throw new Error('KRX_AUTH_KEY secret is not set.');
    }

    let lastError = '';
    for (const basDd of getRecentKrxDates()) {
        const url = new URL(`${KRX_API_BASE_URL}/gen/gold_bydd_trd`);
        url.searchParams.set('basDd', basDd);
        url.searchParams.set('AUTH_KEY', authKey);

        const response = await fetch(url, {
            headers: {
                'Accept': 'application/json',
                'AUTH_KEY': authKey
            }
        });

        if (!response.ok) {
            if (response.status === 401) {
                throw new Error('KRX 인증 실패(401): KRX_AUTH_KEY 값이 틀렸거나, 금시장 일별매매정보 API 이용 승인이 아직 안 된 상태입니다.');
            }
            lastError = `${response.status} for ${basDd}`;
            continue;
        }

        const data = await response.json();
        const rows = data?.OutBlock_1 || [];
        const row = pickGoldRow(rows);
        if (!row) {
            lastError = `empty result for ${basDd}`;
            continue;
        }

        const price = parseNumber(row.TDD_CLSPRC || row.CLSPRC || row.CLS_PRC || row.PRICE);
        if (!price) {
            lastError = `missing close price for ${basDd}`;
            continue;
        }

        return {
            symbol: KRX_GOLD_SYMBOL,
            name: row.ISU_NM || 'KRX 금현물',
            price,
            currency: 'KRW',
            marketTime: `${basDd.slice(0, 4)}-${basDd.slice(4, 6)}-${basDd.slice(6, 8)}T06:30:00.000Z`
        };
    }

    throw new Error(`KRX gold request failed: ${lastError || 'no recent trading data'}`);
}

async function fetchYahooChart(symbol) {
    let lastError = '';
    for (const baseUrl of YAHOO_CHART_URLS) {
        const url = `${baseUrl}/${encodeURIComponent(symbol)}?range=5d&interval=1d`;
        const response = await fetch(url, {
            headers: {
                'Accept': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36'
            }
        });

        if (!response.ok) {
            lastError = `${response.status} from ${new URL(baseUrl).hostname}`;
            continue;
        }

        const data = await response.json();
        const result = data?.chart?.result?.[0];
        if (!result) {
            lastError = `empty result from ${new URL(baseUrl).hostname}`;
            continue;
        }

        const meta = result.meta || {};
        const quote = result.indicators?.quote?.[0] || {};
        const closes = quote.close || [];
        const lastClose = [...closes].reverse().find(price => typeof price === 'number');

        return {
            symbol,
            name: meta.longName || meta.shortName || symbol,
            price: meta.regularMarketPrice ?? lastClose ?? meta.previousClose ?? null,
            currency: meta.currency || 'KRW',
            marketTime: meta.regularMarketTime
                ? new Date(meta.regularMarketTime * 1000).toISOString()
                : null
        };
    }

    throw new Error(`Yahoo Finance request failed for ${symbol}: ${lastError}`);
}

async function fetchYahooCharts(symbols) {
    const entries = await Promise.all(symbols.map(async symbol => {
        try {
            return [symbol, await fetchYahooChart(symbol)];
        } catch (error) {
            return [symbol, { error: error.message || 'Unknown Yahoo Finance error' }];
        }
    }));

    return Object.fromEntries(entries);
}

async function searchYahooSymbols(query) {
    let lastError = '';
    for (const baseUrl of YAHOO_SEARCH_URLS) {
        const url = `${baseUrl}?q=${encodeURIComponent(query)}&quotesCount=10&newsCount=0`;
        const response = await fetch(url, {
            headers: {
                'Accept': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36'
            }
        });

        if (!response.ok) {
            lastError = `${response.status} from ${new URL(baseUrl).hostname}`;
            continue;
        }

        const data = await response.json();
        const quotes = data?.quotes || [];
        return quotes
            .filter(item => item.symbol)
            .map(item => ({
                symbol: item.symbol,
                name: item.shortname || item.longname || item.name || item.symbol,
                exchange: item.exchDisp || item.exchange || '',
                type: item.quoteType || ''
            }));
    }

    throw new Error(`Yahoo Finance search failed: ${lastError}`);
}

export default {
    async fetch(request, env) {
        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: CORS_HEADERS });
        }

        const url = new URL(request.url);
        if (url.pathname === '/search') {
            const query = String(url.searchParams.get('q') || '').trim();
            if (!query) {
                return jsonResponse({
                    success: false,
                    message: 'q query parameter is required.'
                }, 400);
            }

            try {
                if (isGoldQuery(query)) {
                    return jsonResponse({
                        success: true,
                        query,
                        results: [{
                            symbol: KRX_GOLD_SYMBOL,
                            name: 'KRX 금현물',
                            exchange: 'KRX',
                            type: 'Gold'
                        }]
                    });
                }

                return jsonResponse({
                    success: true,
                    query,
                    results: await searchYahooSymbols(query)
                });
            } catch (error) {
                return jsonResponse({
                    success: false,
                    message: error.message || 'Failed to search symbols.'
                }, 502);
            }
        }

        if (url.pathname !== '/prices') {
            return jsonResponse({
                success: true,
                message: 'Use /prices?symbols=AAPL,NVDA,005930.KS or /search?q=apple'
            });
        }

        const symbols = normalizeSymbols(url.searchParams.get('symbols'));
        if (symbols.length === 0) {
            return jsonResponse({
                success: false,
                message: 'symbols query parameter is required.'
            }, 400);
        }

        try {
            const goldSymbols = symbols.filter(symbol => symbol === KRX_GOLD_SYMBOL);
            const yahooSymbols = symbols.filter(symbol => symbol !== KRX_GOLD_SYMBOL);
            const quoteRows = {
                ...(await fetchYahooCharts(yahooSymbols))
            };

            if (goldSymbols.length > 0) {
                try {
                    quoteRows[KRX_GOLD_SYMBOL] = await fetchKrxGoldQuote(env);
                } catch (error) {
                    quoteRows[KRX_GOLD_SYMBOL] = { error: error.message || 'Unknown KRX gold error' };
                }
            }

            const currencies = [...new Set(Object.values(quoteRows)
                .map(row => row.currency)
                .filter(currency => currency && currency !== 'KRW'))];

            const fxSymbols = currencies.map(currency => `${currency}KRW=X`);
            const fxRows = await fetchYahooCharts(fxSymbols);
            const fxRates = Object.fromEntries(currencies.map(currency => {
                const fxRow = fxRows[`${currency}KRW=X`];
                return [currency, fxRow?.price || 1];
            }));

            const quotes = {};
            const missing = [];
            const errors = {};
            const updatedAt = new Date().toISOString();

            symbols.forEach(symbol => {
                const row = quoteRows[symbol];
                if (row?.error) {
                    errors[symbol] = row.error;
                    missing.push(symbol);
                    return;
                }

                const price = row?.price;
                if (!row || !price) {
                    missing.push(symbol);
                    return;
                }

                const currency = row.currency || 'KRW';
                const fxRate = currency === 'KRW' ? 1 : (fxRates[currency] || 1);

                quotes[symbol] = {
                    symbol,
                    name: row.name || symbol,
                    price,
                    currency,
                    fxRate,
                    krwPrice: Math.round(price * fxRate),
                    marketTime: row.marketTime || updatedAt,
                    updatedAt
                };
            });

            return jsonResponse({
                success: true,
                updatedAt,
                quotes,
                missing,
                errors
            });
        } catch (error) {
            return jsonResponse({
                success: false,
                message: error.message || 'Failed to fetch prices.'
            }, 502);
        }
    }
};
