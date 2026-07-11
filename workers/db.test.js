import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import * as db from './db.js';

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
});

describe('findMemberByCode', () => {
    it('올바른 코드로 멤버를 찾는다', async () => {
        await seedCouple();
        const member = await db.findMemberByCode(env.DB, 'JT-CODE');
        expect(member).toEqual({ id: 'm-jt', couple_id: 'c1', name: '정태' });
    });

    it('존재하지 않는 코드는 null을 반환한다', async () => {
        await seedCouple();
        const member = await db.findMemberByCode(env.DB, 'NOPE');
        expect(member).toBeNull();
    });
});

describe('findPartner', () => {
    it('같은 커플의 다른 멤버를 반환한다', async () => {
        await seedCouple();
        const partner = await db.findPartner(env.DB, 'c1', 'm-jt');
        expect(partner).toEqual({ id: 'm-mj', name: '민주' });
    });
});

describe('transactions', () => {
    it('추가한 거래를 조회할 수 있고, 최신 날짜가 먼저 온다', async () => {
        await seedCouple();
        await db.insertTransaction(env.DB, 'm-jt', {
            id: 1000, date: '2026-07-01', type: 'expense', category: '식비', amount: 5000, desc: '커피', excludeFromBudget: false
        });
        await db.insertTransaction(env.DB, 'm-jt', {
            id: 1001, date: '2026-07-05', type: 'expense', category: '쇼핑', amount: 30000, desc: '옷', excludeFromBudget: true
        });

        const rows = await db.getTransactions(env.DB, 'm-jt');
        expect(rows).toEqual([
            { id: 1001, date: '2026-07-05', type: 'expense', category: '쇼핑', amount: 30000, desc: '옷', excludeFromBudget: true },
            { id: 1000, date: '2026-07-01', type: 'expense', category: '식비', amount: 5000, desc: '커피', excludeFromBudget: false }
        ]);
    });

    it('다른 멤버의 거래는 섞이지 않는다', async () => {
        await seedCouple();
        await db.insertTransaction(env.DB, 'm-jt', {
            id: 1, date: '2026-07-01', type: 'expense', category: '식비', amount: 1000, desc: 'A', excludeFromBudget: false
        });
        await db.insertTransaction(env.DB, 'm-mj', {
            id: 2, date: '2026-07-01', type: 'expense', category: '식비', amount: 2000, desc: 'B', excludeFromBudget: false
        });

        const jtRows = await db.getTransactions(env.DB, 'm-jt');
        expect(jtRows).toHaveLength(1);
        expect(jtRows[0].desc).toBe('A');
    });

    it('삭제한 거래는 더 이상 조회되지 않는다', async () => {
        await seedCouple();
        await db.insertTransaction(env.DB, 'm-jt', {
            id: 1, date: '2026-07-01', type: 'expense', category: '식비', amount: 1000, desc: 'A', excludeFromBudget: false
        });
        await db.deleteTransaction(env.DB, 'm-jt', 1);
        const rows = await db.getTransactions(env.DB, 'm-jt');
        expect(rows).toHaveLength(0);
    });
});

describe('settings', () => {
    it('설정이 없으면 기본값을 반환한다', async () => {
        await seedCouple();
        const settings = await db.getSettings(env.DB, 'm-jt');
        expect(settings.title).toBe('커플 가계부');
        expect(settings.accounts).toEqual([]);
        expect(settings.categories).toContain('식비');
    });

    it('저장한 설정을 그대로 불러올 수 있다', async () => {
        await seedCouple();
        await db.putSettings(env.DB, 'm-jt', {
            title: '정태의 가계부',
            accounts: [{ id: 1, name: '주식', type: 'stock', balance: 1000 }],
            categories: ['식비', '교통'],
            monthlyBudgets: { '2026-07': 500000 },
            fixedExpenses: [{ day: 1, desc: '월세', amount: 700000 }],
            monthlyGoals: { '2026-07': '저축하기' },
            monthlyAssetsData: { '2026-07': 1000000 }
        });

        const settings = await db.getSettings(env.DB, 'm-jt');
        expect(settings.title).toBe('정태의 가계부');
        expect(settings.accounts).toEqual([{ id: 1, name: '주식', type: 'stock', balance: 1000 }]);
        expect(settings.monthlyBudgets).toEqual({ '2026-07': 500000 });
    });

    it('두 번 저장하면 덮어쓴다 (누적되지 않는다)', async () => {
        await seedCouple();
        await db.putSettings(env.DB, 'm-jt', { title: 'A', accounts: [], categories: [], monthlyBudgets: {}, fixedExpenses: [], monthlyGoals: {}, monthlyAssetsData: {} });
        await db.putSettings(env.DB, 'm-jt', { title: 'B', accounts: [], categories: [], monthlyBudgets: {}, fixedExpenses: [], monthlyGoals: {}, monthlyAssetsData: {} });
        const settings = await db.getSettings(env.DB, 'm-jt');
        expect(settings.title).toBe('B');
    });
});

describe('importBook', () => {
    it('기존 거래를 지우고 백업 내용으로 교체한다', async () => {
        await seedCouple();
        await db.insertTransaction(env.DB, 'm-jt', {
            id: 1, date: '2026-06-01', type: 'expense', category: '식비', amount: 1000, desc: '옛날 내역', excludeFromBudget: false
        });

        const count = await db.importBook(env.DB, 'm-jt', {
            transactions: [
                { id: 2, date: '2026-07-01', type: 'income', category: '월급', amount: 3000000, desc: '월급', excludeFromBudget: false }
            ],
            appTitle: '백업 제목',
            accounts: [],
            categories: ['식비'],
            monthlyBudgets: {},
            fixedExpenses: [],
            monthlyGoals: {},
            monthlyAssetsData: {}
        });

        expect(count).toBe(1);
        const rows = await db.getTransactions(env.DB, 'm-jt');
        expect(rows).toHaveLength(1);
        expect(rows[0].desc).toBe('월급');
        const settings = await db.getSettings(env.DB, 'm-jt');
        expect(settings.title).toBe('백업 제목');
    });
});
