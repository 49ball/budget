// KIS 시세 조회. 종목명은 D1 종목 마스터에서 채우므로 여기서는 가격만 다룬다.

import { getAccessToken, kisBaseUrl, kisCredentials } from './kis-auth.js';

const DOMESTIC_PRICE_PATH = '/uapi/domestic-stock/v1/quotations/inquire-price';
const DOMESTIC_PRICE_TR_ID = 'FHKST01010100';

const OVERSEAS_PRICE_PATH = '/uapi/overseas-price/v1/quotations/price-detail';
const OVERSEAS_PRICE_TR_ID = 'HHDFS76200200';

// 만료된 토큰일 때 KIS가 돌려주는 코드. 이때만 강제 재발급 후 1회 재시도한다.
const EXPIRED_TOKEN_CODES = new Set(['EGW00123', 'EGW00121']);

export async function fetchDomesticQuote(env, { symbol, code }) {
    const data = await withToken(env, token => kisRequest(env, {
        path: DOMESTIC_PRICE_PATH,
        trId: DOMESTIC_PRICE_TR_ID,
        token,
        params: {
            FID_COND_MRKT_DIV_CODE: 'J',
            FID_INPUT_ISCD: code
        }
    }));

    const output = data?.output || {};
    const price = parseNumber(output.stck_prpr);
    if (!price) {
        throw new Error(`국내 시세 응답에 현재가가 없습니다 (${code}).`);
    }

    return {
        symbol,
        name: output.hts_kor_isnm || '',
        price,
        currency: 'KRW',
        fxRate: 1,
        krwPrice: Math.round(price),
        marketTime: null
    };
}

export async function fetchOverseasQuote(env, { symbol, code, exchange }) {
    const data = await withToken(env, token => kisRequest(env, {
        path: OVERSEAS_PRICE_PATH,
        trId: OVERSEAS_PRICE_TR_ID,
        token,
        params: {
            AUTH: '',
            EXCD: exchange,
            SYMB: code
        }
    }));

    const output = data?.output || {};
    const price = parseNumber(output.last);
    if (!price) {
        throw new Error(`해외 시세 응답에 현재가가 없습니다 (${exchange}:${code}).`);
    }

    // KIS가 원환산가격(t_xprc)과 당일환율(t_rate)을 함께 주므로 별도 환율 조회가 필요 없다.
    const currency = output.curr || 'USD';
    const fxRate = parseNumber(output.t_rate) || 1;
    const converted = parseNumber(output.t_xprc);

    return {
        symbol,
        name: '',
        price,
        currency,
        fxRate,
        krwPrice: Math.round(converted || price * fxRate),
        marketTime: null
    };
}

async function withToken(env, run) {
    const token = await getAccessToken(env);
    try {
        return await run(token);
    } catch (error) {
        if (!EXPIRED_TOKEN_CODES.has(error?.code)) throw error;
        return run(await getAccessToken(env, { forceRenew: true }));
    }
}

async function kisRequest(env, { path, trId, params, token }) {
    const { appKey, appSecret } = kisCredentials(env);

    const url = new URL(kisBaseUrl(env) + path);
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));

    const response = await fetch(url, {
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            authorization: `Bearer ${token}`,
            appkey: appKey,
            appsecret: appSecret,
            tr_id: trId,
            custtype: 'P'
        }
    });

    const data = await response.json().catch(() => null);

    if (!response.ok) {
        throw kisError(data?.msg1 || `HTTP ${response.status}`, data?.msg_cd);
    }
    // KIS는 HTTP 200으로도 실패를 알린다. rt_cd '0'만 성공이다.
    if (data?.rt_cd !== undefined && String(data.rt_cd) !== '0') {
        throw kisError(data.msg1 || `KIS 오류 (${trId})`, data.msg_cd);
    }

    return data;
}

function kisError(message, code) {
    const error = new Error(String(message).trim());
    error.code = code;
    return error;
}

function parseNumber(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    const normalized = String(value ?? '').replace(/,/g, '').replace(/[^\d.-]/g, '');
    const parsed = parseFloat(normalized);
    return Number.isFinite(parsed) ? parsed : null;
}
