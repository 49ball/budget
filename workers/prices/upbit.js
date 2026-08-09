// 코인 시세. KIS는 증권사라 가상자산 시세를 제공하지 않으므로 업비트 공개 API를 쓴다.
// 인증이 없고 원화 시세를 바로 주기 때문에 환산이 필요 없다.

const UPBIT_TICKER_URL = 'https://api.upbit.com/v1/ticker';

// 업비트는 한 번의 호출로 여러 마켓을 조회할 수 있다.
export async function fetchCryptoQuotes(targets) {
    if (targets.length === 0) return {};

    const markets = [...new Set(targets.map(target => target.market))];
    const url = `${UPBIT_TICKER_URL}?markets=${encodeURIComponent(markets.join(','))}`;

    let rowsByMarket = {};
    let requestError = null;

    try {
        const response = await fetch(url, { headers: { Accept: 'application/json' } });
        const data = await response.json().catch(() => null);

        if (!response.ok) {
            const detail = data?.error?.message || `HTTP ${response.status}`;
            throw new Error(`업비트 요청 실패: ${detail}`);
        }

        rowsByMarket = Object.fromEntries((Array.isArray(data) ? data : []).map(row => [row.market, row]));
    } catch (error) {
        requestError = error.message || '업비트 시세를 가져오지 못했습니다.';
    }

    return Object.fromEntries(targets.map(target => {
        if (requestError) {
            return [target.symbol, { error: requestError }];
        }

        const row = rowsByMarket[target.market];
        const price = Number(row?.trade_price);
        if (!row || !Number.isFinite(price) || price === 0) {
            return [target.symbol, { error: `업비트에 ${target.market} 마켓이 없습니다.` }];
        }

        return [target.symbol, {
            symbol: target.symbol,
            name: target.market,
            price,
            currency: 'KRW',
            fxRate: 1,
            krwPrice: Math.round(price),
            marketTime: row.trade_timestamp ? new Date(row.trade_timestamp).toISOString() : null
        }];
    }));
}
