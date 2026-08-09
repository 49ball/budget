// KRX 금현물 시세. KIS는 금'선물'만 있어서 현물은 기존대로 KRX 공식 API를 쓴다.

import { GOLD_SYMBOL } from './symbols.js';

const KRX_API_BASE_URL = 'https://data-dbg.krx.co.kr/svc/apis';

export async function fetchGoldQuote(env) {
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
        const row = pickGoldRow(data?.OutBlock_1 || []);
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
            symbol: GOLD_SYMBOL,
            name: row.ISU_NM || 'KRX 금현물',
            price,
            currency: 'KRW',
            fxRate: 1,
            krwPrice: Math.round(price),
            marketTime: `${basDd.slice(0, 4)}-${basDd.slice(4, 6)}-${basDd.slice(6, 8)}T06:30:00.000Z`
        };
    }

    throw new Error(`KRX gold request failed: ${lastError || 'no recent trading data'}`);
}

function pickGoldRow(rows) {
    return rows.find(row => String(row.ISU_NM || '').includes('1Kg'))
        || rows.find(row => String(row.ISU_NM || '').includes('금'))
        || rows[0]
        || null;
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

function parseNumber(value) {
    if (typeof value === 'number') return value;
    const normalized = String(value || '').replace(/,/g, '').replace(/[^\d.-]/g, '');
    const parsed = parseFloat(normalized);
    return Number.isFinite(parsed) ? parsed : null;
}
