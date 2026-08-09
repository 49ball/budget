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

    it('/api/가 아니면 시세 워커로 위임한다', async () => {
        // symbols가 없으면 400으로 끝나므로 외부 호출 없이 위임 여부만 확인할 수 있다.
        const request = new Request('https://example.com/prices');
        const res = await worker.fetch(request, env);
        const data = await res.json();

        expect(res.status).toBe(400);
        expect(data.message).toMatch(/symbols/);
    });

    it('OPTIONS 요청에 CORS 헤더로 응답한다', async () => {
        const request = new Request('https://example.com/api/login', { method: 'OPTIONS' });
        const res = await worker.fetch(request, env);
        expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    });
});
