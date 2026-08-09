import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { getAccessToken, resetInflightRenewal } from './kis-auth.js';

const TEST_ENV = {
    DB: env.DB,
    KIS_APP_KEY: 'test-key',
    KIS_APP_SECRET: 'test-secret',
    KIS_BASE_URL: 'https://kis.test'
};

function tokenResponse(accessToken, expiresIn = 86400) {
    return new Response(JSON.stringify({ access_token: accessToken, expires_in: expiresIn }), {
        headers: { 'Content-Type': 'application/json' }
    });
}

async function storeToken(accessToken, expiresAt) {
    await env.DB.prepare(
        'UPDATE kis_token SET access_token = ?, expires_at = ?, renewing_at = NULL, updated_at = ? WHERE id = 1'
    ).bind(accessToken, expiresAt, new Date().toISOString()).run();
}

function hoursFromNow(hours) {
    return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

beforeEach(async () => {
    resetInflightRenewal();
    await storeToken('', '1970-01-01T00:00:00.000Z');
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('getAccessToken', () => {
    it('저장된 토큰이 아직 유효하면 발급하지 않는다', async () => {
        await storeToken('cached-token', hoursFromNow(5));
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);

        expect(await getAccessToken(TEST_ENV)).toBe('cached-token');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('토큰이 없으면 발급해서 D1에 저장한다', async () => {
        const fetchMock = vi.fn().mockResolvedValue(tokenResponse('new-token'));
        vi.stubGlobal('fetch', fetchMock);

        expect(await getAccessToken(TEST_ENV)).toBe('new-token');
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls[0][0]).toBe('https://kis.test/oauth2/tokenP');

        const row = await env.DB.prepare('SELECT access_token, expires_at FROM kis_token WHERE id = 1').first();
        expect(row.access_token).toBe('new-token');
        expect(Date.parse(row.expires_at)).toBeGreaterThan(Date.now());
    });

    it('만료가 10분 안쪽으로 다가오면 갱신한다', async () => {
        await storeToken('stale-token', new Date(Date.now() + 60 * 1000).toISOString());
        const fetchMock = vi.fn().mockResolvedValue(tokenResponse('renewed-token'));
        vi.stubGlobal('fetch', fetchMock);

        expect(await getAccessToken(TEST_ENV)).toBe('renewed-token');
    });

    it('발급이 실패해도 아직 만료되지 않은 토큰이 있으면 그것으로 버틴다', async () => {
        await storeToken('stale-token', new Date(Date.now() + 60 * 1000).toISOString());
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
            new Response(JSON.stringify({ error_description: '1분당 1회 발급 가능' }), { status: 403 })
        ));

        expect(await getAccessToken(TEST_ENV)).toBe('stale-token');
    });

    it('쓸 수 있는 토큰이 없는데 발급도 실패하면 오류를 낸다', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
            new Response(JSON.stringify({ error_description: 'invalid appkey' }), { status: 401 })
        ));

        await expect(getAccessToken(TEST_ENV)).rejects.toThrow(/invalid appkey/);
    });

    it('동시에 들어온 요청이어도 발급은 한 번만 한다', async () => {
        const fetchMock = vi.fn().mockResolvedValue(tokenResponse('single-token'));
        vi.stubGlobal('fetch', fetchMock);

        const tokens = await Promise.all([
            getAccessToken(TEST_ENV),
            getAccessToken(TEST_ENV),
            getAccessToken(TEST_ENV)
        ]);

        expect(tokens).toEqual(['single-token', 'single-token', 'single-token']);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('appkey secret이 없으면 알려준다', async () => {
        await expect(getAccessToken({ DB: env.DB })).rejects.toThrow(/KIS_APP_KEY/);
    });
});
