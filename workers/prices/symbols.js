// 티커 문자열만 보고 어느 시세 소스로 보낼지 정한다. 외부 의존이 없는 순수 함수라
// 여기서 분류가 끝나지 않는 값(예: 한글 종목명)은 kind: 'unknown'으로 넘기고,
// D1 종목 마스터를 쓰는 resolveSymbols()가 마저 해석한다.

export const GOLD_SYMBOL = 'KRX-GOLD';

const MAX_SYMBOLS = 50;

const GOLD_ALIASES = new Set(['GOLD', 'KRX-GOLD', 'KRXGOLD', '금', '금현물', 'KRX금']);

// 가계부에 저장될 수 있는 코인 표기. `XXX-USD` 형태는 아래 정규식이 일반 처리한다.
const CRYPTO_BASES = {
    BITCOIN: 'BTC',
    BTC: 'BTC',
    ETHEREUM: 'ETH',
    ETH: 'ETH',
    RIPPLE: 'XRP',
    XRP: 'XRP',
    DOGECOIN: 'DOGE',
    DOGE: 'DOGE',
    SOLANA: 'SOL',
    SOL: 'SOL',
    CARDANO: 'ADA',
    ADA: 'ADA'
};

export function normalizeSymbols(value) {
    return [...new Set(String(value || '')
        .split(',')
        .map(symbol => symbol.trim().toUpperCase())
        .filter(Boolean)
        .slice(0, MAX_SYMBOLS))];
}

export function isGoldQuery(value) {
    return GOLD_ALIASES.has(String(value || '').trim().toUpperCase().replace(/\s+/g, ''));
}

export function classify(symbol) {
    const value = String(symbol || '').trim().toUpperCase();
    if (!value) return { kind: 'unknown', symbol: value };

    if (GOLD_ALIASES.has(value)) {
        return { kind: 'gold', symbol: value };
    }

    const pairedCrypto = value.match(/^([A-Z0-9]{2,10})-USD$/);
    if (pairedCrypto) {
        return { kind: 'crypto', symbol: value, market: `KRW-${pairedCrypto[1]}` };
    }
    if (CRYPTO_BASES[value]) {
        return { kind: 'crypto', symbol: value, market: `KRW-${CRYPTO_BASES[value]}` };
    }

    // 005930, 005930.KS, 086520.KQ 모두 KIS에는 6자리 코드로 넘긴다.
    // 국내 코드는 숫자로 시작하고 뒷자리에 문자가 섞일 수 있다(0041E0, 00088K).
    // 해외 티커는 항상 문자로 시작하므로 이 조건으로 둘을 구분할 수 있다.
    const domestic = value.match(/^(\d[0-9A-Z]{5})(?:\.(?:KS|KQ))?$/);
    if (domestic) {
        return { kind: 'domestic', symbol: value, code: domestic[1] };
    }

    // AAPL, BRK.B 같은 해외 티커. 거래소 코드(NAS/NYS/AMS)는 마스터에서 채운다.
    if (/^[A-Z][A-Z0-9.]{0,9}$/.test(value)) {
        return { kind: 'overseas', symbol: value, code: value };
    }

    return { kind: 'unknown', symbol: value };
}
