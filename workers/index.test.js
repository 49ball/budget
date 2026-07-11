import { describe, it, expect } from 'vitest';
import worker from './index.js';
import { env } from 'cloudflare:test';

describe('요청 라우팅', () => {
    it('/api/로 시작하면 API 라우터로 위임한다', async () => {
        const request = new Request('https://example.com/api/login', {
            method: 'POST',
            headers: { 'X-Member-Code': 'NOPE' }
        });
        const res = await worker.fetch(request, env);
        expect(res.status).toBe(401); // api.js가 처리했다는 뜻 (코드가 없어서 401)
    });

    it('/api/가 아니면 기존 가격 조회 워커로 위임한다', async () => {
        const request = new Request('https://example.com/prices?symbols=AAPL');
        const res = await worker.fetch(request, env);
        const data = await res.json();
        // price-worker.js는 실제 Yahoo Finance를 호출하므로 성공 여부와 무관하게
        // '이 요청을 처리한 것은 price-worker다'만 확인한다: success 필드가 존재해야 한다.
        expect(data).toHaveProperty('success');
    });

    it('OPTIONS 요청에 CORS 헤더로 응답한다', async () => {
        const request = new Request('https://example.com/api/login', { method: 'OPTIONS' });
        const res = await worker.fetch(request, env);
        expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    });
});
