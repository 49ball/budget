import { describe, it, expect } from 'vitest';
import { classify, normalizeSymbols, isGoldQuery } from './symbols.js';

describe('normalizeSymbols', () => {
    it('쉼표로 나누고 대문자로 바꾸고 중복을 없앤다', () => {
        expect(normalizeSymbols('aapl, AAPL , nvda')).toEqual(['AAPL', 'NVDA']);
    });

    it('빈 값이면 빈 배열을 반환한다', () => {
        expect(normalizeSymbols('')).toEqual([]);
        expect(normalizeSymbols(null)).toEqual([]);
    });

    it('50개를 넘으면 잘라낸다', () => {
        const many = Array.from({ length: 60 }, (_, index) => `SYM${index}`).join(',');
        expect(normalizeSymbols(many)).toHaveLength(50);
    });
});

describe('classify', () => {
    it('6자리 코드는 접미사 유무와 관계없이 국내주식으로 본다', () => {
        expect(classify('005930')).toEqual({ kind: 'domestic', symbol: '005930', code: '005930' });
        expect(classify('005930.KS')).toEqual({ kind: 'domestic', symbol: '005930.KS', code: '005930' });
        expect(classify('086520.KQ')).toEqual({ kind: 'domestic', symbol: '086520.KQ', code: '086520' });
    });

    // KRX가 발행하는 6자리 코드에는 숫자 사이에 문자가 섞이기도 한다.
    it('문자가 섞인 국내 코드도 국내주식으로 본다', () => {
        expect(classify('0041E0')).toEqual({ kind: 'domestic', symbol: '0041E0', code: '0041E0' });
        expect(classify('0041E0.KS')).toEqual({ kind: 'domestic', symbol: '0041E0.KS', code: '0041E0' });
        expect(classify('00088K')).toEqual({ kind: 'domestic', symbol: '00088K', code: '00088K' });
    });

    it('해외 티커는 거래소 코드 없이 overseas로 분류한다', () => {
        expect(classify('AAPL')).toEqual({ kind: 'overseas', symbol: 'AAPL', code: 'AAPL' });
    });

    it('-USD로 끝나면 업비트 원화 마켓으로 매핑한다', () => {
        expect(classify('BTC-USD')).toEqual({ kind: 'crypto', symbol: 'BTC-USD', market: 'KRW-BTC' });
        expect(classify('DOGE-USD')).toEqual({ kind: 'crypto', symbol: 'DOGE-USD', market: 'KRW-DOGE' });
    });

    it('코인 약칭도 원화 마켓으로 매핑한다', () => {
        expect(classify('btc')).toEqual({ kind: 'crypto', symbol: 'BTC', market: 'KRW-BTC' });
        expect(classify('BITCOIN')).toEqual({ kind: 'crypto', symbol: 'BITCOIN', market: 'KRW-BTC' });
    });

    it('금 별칭은 gold로 분류한다', () => {
        expect(classify('KRX-GOLD').kind).toBe('gold');
        expect(classify('금').kind).toBe('gold');
    });

    it('한글 종목명은 unknown으로 남겨 마스터 조회에 넘긴다', () => {
        expect(classify('삼성전자')).toEqual({ kind: 'unknown', symbol: '삼성전자' });
    });
});

describe('isGoldQuery', () => {
    it('공백과 대소문자를 무시하고 금 여부를 판정한다', () => {
        expect(isGoldQuery(' krx gold ')).toBe(true);
        expect(isGoldQuery('금현물')).toBe(true);
        expect(isGoldQuery('삼성전자')).toBe(false);
    });
});
