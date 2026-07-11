import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { handleApiRequest } from './api.js';

async function seedCouple() {
    const now = new Date().toISOString();
    await env.DB.batch([
        env.DB.prepare('INSERT INTO couples (id, created_at) VALUES (?, ?)').bind('c1', now),
        env.DB.prepare('INSERT INTO members (id, couple_id, code, name, created_at) VALUES (?, ?, ?, ?, ?)')
            .bind('m-jt', 'c1', 'JT-CODE', '정태', now),
        env.DB.prepare('INSERT INTO members (id, couple_id, code, name, created_at) VALUES (?, ?, ?, ?, ?)')
            .bind('m-mj', 'c1', 'MJ-CODE', '민주', now)
    ]);
}

beforeEach(async () => {
    await env.DB.exec('DELETE FROM transactions');
    await env.DB.exec('DELETE FROM settings');
    await env.DB.exec('DELETE FROM members');
    await env.DB.exec('DELETE FROM couples');
    await seedCouple();
});

function req(path, { method = 'GET', code, body } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (code) headers['X-Member-Code'] = code;
    return new Request(`https://example.com${path}`, {
        method,
        headers,
        body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined
    });
}

describe('POST /api/login', () => {
    it('올바른 코드면 본인 정보와 상대방 정보를 반환한다', async () => {
        const res = await handleApiRequest(req('/api/login', { method: 'POST', code: 'JT-CODE' }), env);
        const data = await res.json();
        expect(data.success).toBe(true);
        expect(data.memberId).toBe('m-jt');
        expect(data.partner).toEqual({ memberId: 'm-mj', memberName: '민주' });
    });

    it('잘못된 코드면 401을 반환한다', async () => {
        const res = await handleApiRequest(req('/api/login', { method: 'POST', code: 'WRONG' }), env);
        expect(res.status).toBe(401);
    });
});

describe('GET /api/books/:memberId', () => {
    it('본인 코드로 본인 책을 조회할 수 있다', async () => {
        const res = await handleApiRequest(req('/api/books/m-jt', { code: 'JT-CODE' }), env);
        const data = await res.json();
        expect(data.success).toBe(true);
        expect(data.transactions).toEqual([]);
    });

    it('본인 코드로 상대방 책도 조회할 수 있다 (읽기 전용 조회는 허용)', async () => {
        const res = await handleApiRequest(req('/api/books/m-mj', { code: 'JT-CODE' }), env);
        expect(res.status).toBe(200);
    });

    it('다른 커플의 책은 조회할 수 없다', async () => {
        const now = new Date().toISOString();
        await env.DB.batch([
            env.DB.prepare('INSERT INTO couples (id, created_at) VALUES (?, ?)').bind('c2', now),
            env.DB.prepare('INSERT INTO members (id, couple_id, code, name, created_at) VALUES (?, ?, ?, ?, ?)')
                .bind('m-other', 'c2', 'OTHER-CODE', '남남', now)
        ]);
        const res = await handleApiRequest(req('/api/books/m-other', { code: 'JT-CODE' }), env);
        expect(res.status).toBe(403);
    });
});

describe('POST /api/books/:memberId/transactions', () => {
    it('본인 책에 거래를 추가할 수 있다', async () => {
        const res = await handleApiRequest(req('/api/books/m-jt/transactions', {
            method: 'POST',
            code: 'JT-CODE',
            body: { transaction: { id: 1, date: '2026-07-01', type: 'expense', category: '식비', amount: 5000, desc: '커피', excludeFromBudget: false } }
        }), env);
        expect(res.status).toBe(201);

        const getRes = await handleApiRequest(req('/api/books/m-jt', { code: 'JT-CODE' }), env);
        const data = await getRes.json();
        expect(data.transactions).toHaveLength(1);
    });

    it('상대방 책에는 거래를 추가할 수 없다 (403)', async () => {
        const res = await handleApiRequest(req('/api/books/m-mj/transactions', {
            method: 'POST',
            code: 'JT-CODE',
            body: { transaction: { id: 1, date: '2026-07-01', type: 'expense', category: '식비', amount: 5000, desc: '커피', excludeFromBudget: false } }
        }), env);
        expect(res.status).toBe(403);
    });

    it('잘못된 형식의 JSON 본문이면 400을 반환한다', async () => {
        const res = await handleApiRequest(req('/api/books/m-jt/transactions', {
            method: 'POST',
            code: 'JT-CODE',
            body: '{ invalid json'
        }), env);
        expect(res.status).toBe(400);
        const data = await res.json();
        expect(data.success).toBe(false);
    });
});

describe('DELETE /api/books/:memberId/transactions/:id', () => {
    it('본인 책의 거래를 삭제할 수 있다', async () => {
        await handleApiRequest(req('/api/books/m-jt/transactions', {
            method: 'POST',
            code: 'JT-CODE',
            body: { transaction: { id: 1, date: '2026-07-01', type: 'expense', category: '식비', amount: 5000, desc: '커피', excludeFromBudget: false } }
        }), env);

        const delRes = await handleApiRequest(req('/api/books/m-jt/transactions/1', { method: 'DELETE', code: 'JT-CODE' }), env);
        expect(delRes.status).toBe(200);

        const getRes = await handleApiRequest(req('/api/books/m-jt', { code: 'JT-CODE' }), env);
        const data = await getRes.json();
        expect(data.transactions).toHaveLength(0);
    });

    it('상대방 책의 거래는 삭제할 수 없다 (403)', async () => {
        const res = await handleApiRequest(req('/api/books/m-mj/transactions/1', { method: 'DELETE', code: 'JT-CODE' }), env);
        expect(res.status).toBe(403);
    });
});

describe('PUT /api/books/:memberId/settings', () => {
    it('본인 책 설정을 저장할 수 있다', async () => {
        const res = await handleApiRequest(req('/api/books/m-jt/settings', {
            method: 'PUT',
            code: 'JT-CODE',
            body: { settings: { title: '정태 가계부', accounts: [], categories: ['식비'], monthlyBudgets: {}, fixedExpenses: [], monthlyGoals: {}, monthlyAssetsData: {} } }
        }), env);
        expect(res.status).toBe(200);

        const getRes = await handleApiRequest(req('/api/books/m-jt', { code: 'JT-CODE' }), env);
        const data = await getRes.json();
        expect(data.settings.title).toBe('정태 가계부');
    });

    it('상대방 책 설정은 저장할 수 없다 (403)', async () => {
        const res = await handleApiRequest(req('/api/books/m-mj/settings', {
            method: 'PUT',
            code: 'JT-CODE',
            body: { settings: { title: '정태 가계부', accounts: [], categories: ['식비'], monthlyBudgets: {}, fixedExpenses: [], monthlyGoals: {}, monthlyAssetsData: {} } }
        }), env);
        expect(res.status).toBe(403);
    });
});

describe('POST /api/books/:memberId/import', () => {
    it('백업 데이터를 가져와서 기존 데이터를 교체한다', async () => {
        const res = await handleApiRequest(req('/api/books/m-jt/import', {
            method: 'POST',
            code: 'JT-CODE',
            body: {
                backup: {
                    transactions: [{ id: 1, date: '2026-07-01', type: 'income', category: '월급', amount: 3000000, desc: '월급', excludeFromBudget: false }],
                    appTitle: '가져온 가계부',
                    accounts: [], categories: ['식비'], monthlyBudgets: {}, fixedExpenses: [], monthlyGoals: {}, monthlyAssetsData: {}
                }
            }
        }), env);
        const data = await res.json();
        expect(data.success).toBe(true);
        expect(data.importedCount).toBe(1);
    });

    it('상대방 책에는 가져오기를 할 수 없다 (403)', async () => {
        const res = await handleApiRequest(req('/api/books/m-mj/import', {
            method: 'POST',
            code: 'JT-CODE',
            body: {
                backup: {
                    transactions: [{ id: 1, date: '2026-07-01', type: 'income', category: '월급', amount: 3000000, desc: '월급', excludeFromBudget: false }],
                    appTitle: '가져온 가계부',
                    accounts: [], categories: ['식비'], monthlyBudgets: {}, fixedExpenses: [], monthlyGoals: {}, monthlyAssetsData: {}
                }
            }
        }), env);
        expect(res.status).toBe(403);
    });
});
