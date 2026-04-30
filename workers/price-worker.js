const YAHOO_CHART_URLS = [
    'https://query1.finance.yahoo.com/v8/finance/chart',
    'https://query2.finance.yahoo.com/v8/finance/chart'
];
const YAHOO_SEARCH_URLS = [
    'https://query1.finance.yahoo.com/v1/finance/search',
    'https://query2.finance.yahoo.com/v1/finance/search'
];
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

    return [...new Set(String(value || '')
        .split(',')
        .map(symbol => symbol.trim().toUpperCase())
        .map(symbol => stockAliases[symbol] || symbol)
        .map(symbol => cryptoAliases[symbol] || symbol)
        .map(symbol => /^\d{6}$/.test(symbol) ? `${symbol}.KS` : symbol)
        .filter(Boolean)
        .slice(0, 50))];
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
    async fetch(request) {
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
            const quoteRows = await fetchYahooCharts(symbols);
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
