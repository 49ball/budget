# 커플 가계부 공유 앱 전환 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 정태와 민주가 각자 분리된 가계부를 온라인(Cloudflare D1)에 저장하고, 서로의 가계부를 홈 화면에 설치된 PWA에서 조회(읽기 전용)할 수 있게 만든다.

**Architecture:** GitHub Pages(`index.html`, 정적)가 Cloudflare Worker(`workers/index.js`)를 호출한다. Worker는 기존 시세 조회 로직(`workers/price-worker.js`, 변경 없음)과 새 커플 가계부 API(`workers/api.js` + `workers/db.js`)를 라우팅한다. 데이터는 Cloudflare D1(SQLite)에 저장되며, 거래 내역은 행 단위(안전한 추가/삭제), 설정값은 사람별 JSON 한 덩어리(덮어쓰기)로 저장한다. 인증은 사람별 코드(`X-Member-Code` 헤더)로 하며, 본인 코드로는 본인 책만 쓸 수 있고 상대방 책은 조회만 가능하다.

**Tech Stack:** Cloudflare Workers, Cloudflare D1, Vanilla JS(프론트, 기존 `index.html` 유지), Vitest + `@cloudflare/vitest-pool-workers`(백엔드 테스트)

## Global Constraints

- 스펙 문서: `docs/superpowers/specs/2026-07-11-couple-shared-app-design.md`의 모든 결정을 그대로 따른다.
- 거래(transaction) 수정은 없다 — 기존 프론트 코드가 "수정 = 삭제 후 재생성"으로 동작하므로 API도 `POST`(생성)/`DELETE`(삭제)만 제공한다.
- 실시간 동기화, 오프라인 지원, 상대방 편집 권한, 통합 대시보드는 만들지 않는다(스펙의 Out of scope 그대로).
- 기존 `workers/price-worker.js`, `README.md`의 기존 내용은 수정하지 않는다(가격 조회 기능과 완전히 독립적으로 확장).
- 트랜잭션 JSON 필드명은 프론트 기존 필드명(`id, date, type, category, amount, desc, excludeFromBudget`)을 API 요청/응답에서도 그대로 사용한다(DB 컬럼명만 `memo`로 다르게 저장).
- CORS는 기존 `price-worker.js`와 동일하게 `Access-Control-Allow-Origin: '*'` 패턴을 따른다.

---

## Task 1: Worker 프로젝트 도구 설정 (package.json, wrangler, vitest)

**Files:**
- Create: `package.json`
- Create: `vitest.config.js`
- Create: `workers/test/apply-migrations.js`
- Create: `workers/smoke.test.js`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `npm test` 명령으로 Cloudflare Workers 풀 기반 vitest 실행 가능. 이후 모든 백엔드 태스크가 이 설정을 사용해 테스트를 작성/실행한다.

- [ ] **Step 1: package.json 작성**

```json
{
  "name": "budget-couple-app",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "deploy": "wrangler deploy",
    "d1:migrate:local": "wrangler d1 migrations apply budget-couple-db --local",
    "d1:migrate:remote": "wrangler d1 migrations apply budget-couple-db --remote"
  },
  "devDependencies": {
    "@cloudflare/vitest-pool-workers": "^0.5.2",
    "vitest": "^1.6.0",
    "wrangler": "^3.78.0"
  }
}
```

- [ ] **Step 2: 의존성 설치**

Run: `npm install`
Expected: `node_modules/` 생성, `package-lock.json` 생성, 에러 없이 종료

- [ ] **Step 3: .gitignore에 node_modules, wrangler 로컬 상태 추가**

`.gitignore`에 다음을 추가:

```
.DS_Store
node_modules/
.wrangler/
package-lock.json
```

(주: `package-lock.json`은 팀 협업/CI 재현성이 중요할 때는 커밋하는 게 일반적이지만, 이 프로젝트는 1인 배포이고 `npm install`을 새로 할 일이 거의 없으므로 커밋하지 않는 쪽을 기본으로 한다. 커밋하고 싶다면 이 줄만 빼면 된다.)

- [ ] **Step 4: vitest 설정 작성**

`vitest.config.js`:

```js
import { defineWorkersConfig, readD1Migrations } from '@cloudflare/vitest-pool-workers/config';
import path from 'node:path';

export default defineWorkersConfig(async () => {
    const migrationsPath = path.join(__dirname, 'workers/migrations');
    const migrations = await readD1Migrations(migrationsPath);

    return {
        test: {
            setupFiles: ['./workers/test/apply-migrations.js'],
            poolOptions: {
                workers: {
                    wrangler: { configPath: './wrangler.toml' },
                    miniflare: {
                        bindings: { TEST_MIGRATIONS: migrations }
                    }
                }
            }
        }
    };
});
```

- [ ] **Step 5: 마이그레이션 적용 setup 파일 작성**

`workers/test/apply-migrations.js`:

```js
import { applyD1Migrations, env } from 'cloudflare:test';

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
```

(주: `env.DB`는 Task 2에서 `wrangler.toml`에 D1 바인딩을 추가해야 유효해진다. 이 태스크에서는 아직 바인딩이 없으므로 Step 6의 smoke test는 D1을 사용하지 않는 테스트로 작성한다.)

- [ ] **Step 6: 최소 smoke 테스트 작성 (D1 없이 harness 동작만 확인)**

`workers/smoke.test.js`:

```js
import { describe, it, expect } from 'vitest';

describe('vitest-pool-workers 동작 확인', () => {
    it('워커 풀 안에서 테스트가 실행된다', () => {
        expect(1 + 1).toBe(2);
    });
});
```

- [ ] **Step 7: 테스트 실행해서 harness가 동작하는지 확인**

Run: `npm test`
Expected: `workers/smoke.test.js`가 PASS. (D1 바인딩이 아직 없어서 `apply-migrations.js`가 에러를 내면, Task 2에서 `wrangler.toml`에 `[[d1_databases]]`를 추가한 뒤 다시 실행해서 확인한다 — 이 경우 Step 7은 Task 2 완료 후로 미룬다.)

- [ ] **Step 8: 커밋**

```bash
git add package.json vitest.config.js workers/test/apply-migrations.js workers/smoke.test.js .gitignore
git commit -m "테스트용 vitest + wrangler 도구 설정 추가"
```

---

## Task 2: D1 스키마 작성 및 데이터베이스 생성

**Files:**
- Create: `workers/migrations/0001_init.sql`
- Modify: `wrangler.toml`

**Interfaces:**
- Produces: D1 테이블 `couples`, `members`, `transactions`, `settings`. Task 3의 `workers/db.js`가 이 스키마를 사용한다.

- [ ] **Step 1: 마이그레이션 SQL 작성**

`workers/migrations/0001_init.sql`:

```sql
CREATE TABLE couples (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL
);

CREATE TABLE members (
    id TEXT PRIMARY KEY,
    couple_id TEXT NOT NULL REFERENCES couples(id),
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE transactions (
    id TEXT PRIMARY KEY,
    member_id TEXT NOT NULL REFERENCES members(id),
    date TEXT NOT NULL,
    type TEXT NOT NULL,
    category TEXT NOT NULL,
    amount INTEGER NOT NULL,
    memo TEXT NOT NULL DEFAULT '',
    exclude_from_budget INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);

CREATE INDEX idx_transactions_member ON transactions(member_id);

CREATE TABLE settings (
    member_id TEXT PRIMARY KEY REFERENCES members(id),
    title TEXT NOT NULL DEFAULT '커플 가계부',
    accounts_json TEXT NOT NULL DEFAULT '[]',
    categories_json TEXT NOT NULL DEFAULT '[]',
    monthly_budgets_json TEXT NOT NULL DEFAULT '{}',
    fixed_expenses_json TEXT NOT NULL DEFAULT '[]',
    monthly_goals_json TEXT NOT NULL DEFAULT '{}',
    monthly_assets_json TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL
);
```

- [ ] **Step 2: D1 데이터베이스 생성**

Run: `npx wrangler d1 create budget-couple-db`
Expected: 콘솔에 `database_id`가 포함된 `[[d1_databases]]` 블록 예시가 출력됨. 이 `database_id` 값을 다음 단계에서 사용한다.

- [ ] **Step 3: wrangler.toml에 D1 바인딩 추가**

`wrangler.toml` 전체를 다음과 같이 수정 (기존 `name`, `main`, `compatibility_date`는 유지하되 `main`은 Task 5에서 다시 바뀔 예정이므로 지금은 그대로 둠):

```toml
name = "budget-price-worker"
main = "workers/price-worker.js"
compatibility_date = "2026-04-30"

[[d1_databases]]
binding = "DB"
database_name = "budget-couple-db"
database_id = "<Step 2에서 출력된 database_id로 교체>"
migrations_dir = "workers/migrations"
```

- [ ] **Step 4: 로컬 D1에 마이그레이션 적용**

Run: `npm run d1:migrate:local`
Expected: `Migrations to be applied: 0001_init.sql` 및 성공 메시지 출력

- [ ] **Step 5: Task 1의 smoke 테스트 재실행 (D1 바인딩 확인)**

Run: `npm test`
Expected: `workers/smoke.test.js` PASS, `apply-migrations.js`가 에러 없이 실행됨 (D1 바인딩이 정상적으로 인식됨)

- [ ] **Step 6: 커밋**

```bash
git add workers/migrations/0001_init.sql wrangler.toml
git commit -m "D1 스키마(couples/members/transactions/settings) 추가"
```

---

## Task 3: DB 헬퍼 함수 (workers/db.js)

**Files:**
- Create: `workers/db.js`
- Test: `workers/db.test.js`

**Interfaces:**
- Consumes: D1 바인딩 `env.DB` (Task 2에서 정의)
- Produces:
  - `findMemberByCode(db, code): Promise<{id, couple_id, name} | null>`
  - `findPartner(db, coupleId, memberId): Promise<{id, name} | null>`
  - `memberExistsInCouple(db, memberId, coupleId): Promise<boolean>`
  - `getTransactions(db, memberId): Promise<Array<{id:number, date, type, category, amount, desc, excludeFromBudget:boolean}>>`
  - `insertTransaction(db, memberId, tx): Promise<void>`
  - `deleteTransaction(db, memberId, txId): Promise<void>`
  - `getSettings(db, memberId): Promise<{title, accounts, categories, monthlyBudgets, fixedExpenses, monthlyGoals, monthlyAssetsData}>`
  - `putSettings(db, memberId, settings): Promise<void>`
  - `importBook(db, memberId, backup): Promise<number>` (반환값: 가져온 거래 건수)
  - 이 함수들은 Task 4의 `workers/api.js`가 사용한다.

- [ ] **Step 1: 실패하는 테스트 작성 (멤버 조회)**

`workers/db.test.js`:

```js
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
```

- [ ] **Step 2: 테스트 실행해서 실패 확인**

Run: `npm test -- db.test.js`
Expected: FAIL — `workers/db.js` 모듈이 없어서 import 에러

- [ ] **Step 3: workers/db.js 구현**

```js
export async function findMemberByCode(db, code) {
    const row = await db.prepare('SELECT id, couple_id, name FROM members WHERE code = ?').bind(code).first();
    return row || null;
}

export async function findPartner(db, coupleId, memberId) {
    const row = await db.prepare('SELECT id, name FROM members WHERE couple_id = ? AND id != ?').bind(coupleId, memberId).first();
    return row || null;
}

export async function memberExistsInCouple(db, memberId, coupleId) {
    const row = await db.prepare('SELECT id FROM members WHERE id = ? AND couple_id = ?').bind(memberId, coupleId).first();
    return !!row;
}

export async function getTransactions(db, memberId) {
    const { results } = await db.prepare(
        'SELECT id, date, type, category, amount, memo, exclude_from_budget FROM transactions WHERE member_id = ? ORDER BY date DESC, id DESC'
    ).bind(memberId).all();

    return results.map(row => ({
        id: Number(row.id),
        date: row.date,
        type: row.type,
        category: row.category,
        amount: row.amount,
        desc: row.memo,
        excludeFromBudget: !!row.exclude_from_budget
    }));
}

export async function insertTransaction(db, memberId, tx) {
    await db.prepare(
        `INSERT INTO transactions (id, member_id, date, type, category, amount, memo, exclude_from_budget, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
        String(tx.id), memberId, tx.date, tx.type, tx.category, tx.amount,
        tx.desc || '', tx.excludeFromBudget ? 1 : 0, new Date().toISOString()
    ).run();
}

export async function deleteTransaction(db, memberId, txId) {
    await db.prepare('DELETE FROM transactions WHERE id = ? AND member_id = ?').bind(String(txId), memberId).run();
}

const DEFAULT_CATEGORIES = ['식비', '교통', '쇼핑', '주거/통신', '투자', '월급', '기타', '투자손익'];

export async function getSettings(db, memberId) {
    const row = await db.prepare(
        'SELECT title, accounts_json, categories_json, monthly_budgets_json, fixed_expenses_json, monthly_goals_json, monthly_assets_json FROM settings WHERE member_id = ?'
    ).bind(memberId).first();

    if (!row) {
        return {
            title: '커플 가계부',
            accounts: [],
            categories: DEFAULT_CATEGORIES,
            monthlyBudgets: {},
            fixedExpenses: [],
            monthlyGoals: {},
            monthlyAssetsData: {}
        };
    }

    return {
        title: row.title,
        accounts: JSON.parse(row.accounts_json),
        categories: JSON.parse(row.categories_json),
        monthlyBudgets: JSON.parse(row.monthly_budgets_json),
        fixedExpenses: JSON.parse(row.fixed_expenses_json),
        monthlyGoals: JSON.parse(row.monthly_goals_json),
        monthlyAssetsData: JSON.parse(row.monthly_assets_json)
    };
}

export async function putSettings(db, memberId, settings) {
    await db.prepare(
        `INSERT INTO settings (member_id, title, accounts_json, categories_json, monthly_budgets_json, fixed_expenses_json, monthly_goals_json, monthly_assets_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(member_id) DO UPDATE SET
             title = excluded.title,
             accounts_json = excluded.accounts_json,
             categories_json = excluded.categories_json,
             monthly_budgets_json = excluded.monthly_budgets_json,
             fixed_expenses_json = excluded.fixed_expenses_json,
             monthly_goals_json = excluded.monthly_goals_json,
             monthly_assets_json = excluded.monthly_assets_json,
             updated_at = excluded.updated_at`
    ).bind(
        memberId,
        settings.title || '커플 가계부',
        JSON.stringify(settings.accounts || []),
        JSON.stringify(settings.categories || DEFAULT_CATEGORIES),
        JSON.stringify(settings.monthlyBudgets || {}),
        JSON.stringify(settings.fixedExpenses || []),
        JSON.stringify(settings.monthlyGoals || {}),
        JSON.stringify(settings.monthlyAssetsData || {}),
        new Date().toISOString()
    ).run();
}

export async function importBook(db, memberId, backup) {
    const now = new Date().toISOString();
    const transactions = backup.transactions || [];

    const statements = [
        db.prepare('DELETE FROM transactions WHERE member_id = ?').bind(memberId),
        ...transactions.map(tx => db.prepare(
            `INSERT INTO transactions (id, member_id, date, type, category, amount, memo, exclude_from_budget, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(String(tx.id), memberId, tx.date, tx.type, tx.category, tx.amount, tx.desc || '', tx.excludeFromBudget ? 1 : 0, now))
    ];

    await db.batch(statements);

    await putSettings(db, memberId, {
        title: backup.appTitle,
        accounts: backup.accounts,
        categories: backup.categories,
        monthlyBudgets: backup.monthlyBudgets,
        fixedExpenses: backup.fixedExpenses,
        monthlyGoals: backup.monthlyGoals,
        monthlyAssetsData: backup.monthlyAssetsData
    });

    return transactions.length;
}
```

- [ ] **Step 4: 테스트 실행해서 통과 확인**

Run: `npm test -- db.test.js`
Expected: 모든 테스트 PASS

- [ ] **Step 5: 커밋**

```bash
git add workers/db.js workers/db.test.js
git commit -m "D1 조회/저장 헬퍼 함수(workers/db.js) 추가"
```

---

## Task 4: API 라우터 (workers/api.js)

**Files:**
- Create: `workers/api.js`
- Test: `workers/api.test.js`

**Interfaces:**
- Consumes: `workers/db.js`의 모든 export (Task 3)
- Produces:
  - `handleApiRequest(request, env): Promise<Response | null>` — `/api/`로 시작하지 않는 경로면 `null` 반환
  - `API_CORS_HEADERS: object`
  - Task 5의 `workers/index.js`가 이 두 값을 사용한다.

- [ ] **Step 1: 실패하는 테스트 작성**

`workers/api.test.js`:

```js
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
        body: body ? JSON.stringify(body) : undefined
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
});
```

- [ ] **Step 2: 테스트 실행해서 실패 확인**

Run: `npm test -- api.test.js`
Expected: FAIL — `workers/api.js` 모듈이 없어서 import 에러

- [ ] **Step 3: workers/api.js 구현**

```js
import * as db from './db.js';

export const API_CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Member-Code'
};

function json(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...API_CORS_HEADERS, 'Content-Type': 'application/json; charset=utf-8' }
    });
}

async function requireMember(request, env) {
    const code = request.headers.get('X-Member-Code');
    if (!code) {
        return { error: json({ success: false, message: '로그인 코드가 필요합니다.' }, 401) };
    }
    const member = await db.findMemberByCode(env.DB, code);
    if (!member) {
        return { error: json({ success: false, message: '올바르지 않은 코드입니다.' }, 401) };
    }
    return { member };
}

export async function handleApiRequest(request, env) {
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);

    if (parts[0] !== 'api') return null;

    if (parts[1] === 'login' && request.method === 'POST') {
        const { member, error } = await requireMember(request, env);
        if (error) return error;
        const partner = await db.findPartner(env.DB, member.couple_id, member.id);
        return json({
            success: true,
            memberId: member.id,
            memberName: member.name,
            partner: partner ? { memberId: partner.id, memberName: partner.name } : null
        });
    }

    if (parts[1] === 'books' && parts[2]) {
        const targetMemberId = parts[2];
        const { member, error } = await requireMember(request, env);
        if (error) return error;

        if (parts.length === 3 && request.method === 'GET') {
            const allowed = targetMemberId === member.id || await db.memberExistsInCouple(env.DB, targetMemberId, member.couple_id);
            if (!allowed) return json({ success: false, message: '접근 권한이 없습니다.' }, 403);

            const [transactions, settings] = await Promise.all([
                db.getTransactions(env.DB, targetMemberId),
                db.getSettings(env.DB, targetMemberId)
            ]);
            return json({ success: true, transactions, settings });
        }

        if (targetMemberId !== member.id) {
            return json({ success: false, message: '본인 가계부만 수정할 수 있습니다.' }, 403);
        }

        if (parts.length === 4 && parts[3] === 'transactions' && request.method === 'POST') {
            const body = await request.json();
            await db.insertTransaction(env.DB, targetMemberId, body.transaction);
            return json({ success: true }, 201);
        }

        if (parts.length === 5 && parts[3] === 'transactions' && request.method === 'DELETE') {
            await db.deleteTransaction(env.DB, targetMemberId, parts[4]);
            return json({ success: true });
        }

        if (parts.length === 4 && parts[3] === 'settings' && request.method === 'PUT') {
            const body = await request.json();
            await db.putSettings(env.DB, targetMemberId, body.settings);
            return json({ success: true });
        }

        if (parts.length === 4 && parts[3] === 'import' && request.method === 'POST') {
            const body = await request.json();
            const importedCount = await db.importBook(env.DB, targetMemberId, body.backup);
            return json({ success: true, importedCount });
        }
    }

    return json({ success: false, message: 'Not found' }, 404);
}
```

- [ ] **Step 4: 테스트 실행해서 통과 확인**

Run: `npm test -- api.test.js`
Expected: 모든 테스트 PASS

- [ ] **Step 5: 커밋**

```bash
git add workers/api.js workers/api.test.js
git commit -m "커플 가계부 API 라우터(workers/api.js) 추가"
```

---

## Task 5: 엔트리 라우팅 통합 (workers/index.js, wrangler.toml)

**Files:**
- Create: `workers/index.js`
- Test: `workers/index.test.js`
- Modify: `wrangler.toml`

**Interfaces:**
- Consumes: `workers/price-worker.js`(기존, `export default { fetch }`), `workers/api.js`의 `handleApiRequest`, `API_CORS_HEADERS` (Task 4)
- Produces: 배포 엔트리포인트. `wrangler.toml`의 `main`이 이 파일을 가리킨다.

- [ ] **Step 1: 실패하는 테스트 작성**

`workers/index.test.js`:

```js
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
```

- [ ] **Step 2: 테스트 실행해서 실패 확인**

Run: `npm test -- index.test.js`
Expected: FAIL — `workers/index.js` 모듈이 없어서 import 에러

- [ ] **Step 3: workers/index.js 구현**

```js
import priceWorker from './price-worker.js';
import { handleApiRequest, API_CORS_HEADERS } from './api.js';

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        if (url.pathname.startsWith('/api/')) {
            if (request.method === 'OPTIONS') {
                return new Response(null, { headers: API_CORS_HEADERS });
            }
            const response = await handleApiRequest(request, env);
            return response || new Response('Not found', { status: 404 });
        }

        return priceWorker.fetch(request, env, ctx);
    }
};
```

- [ ] **Step 4: 테스트 실행해서 통과 확인**

Run: `npm test -- index.test.js`
Expected: 모든 테스트 PASS (두 번째 테스트는 실제 네트워크 호출이 필요해 환경에 따라 느릴 수 있음 — 실패한다면 네트워크 접근 가능 여부를 확인)

- [ ] **Step 5: wrangler.toml의 main을 workers/index.js로 변경**

`wrangler.toml`:

```toml
name = "budget-price-worker"
main = "workers/index.js"
compatibility_date = "2026-04-30"

[[d1_databases]]
binding = "DB"
database_name = "budget-couple-db"
database_id = "<Task 2 Step 3에서 넣은 값 그대로 유지>"
migrations_dir = "workers/migrations"
```

- [ ] **Step 6: 전체 테스트 재실행**

Run: `npm test`
Expected: 모든 테스트 PASS

- [ ] **Step 7: 커밋**

```bash
git add workers/index.js workers/index.test.js wrangler.toml
git commit -m "가격 조회 워커와 커플 가계부 API를 하나의 엔트리로 라우팅"
```

---

## Task 6: 초기 커플/멤버 시드 (코드 발급)

**Files:**
- Create: `workers/seed.sql`

**Interfaces:**
- Produces: 원격 D1에 실제 커플 1건 + 멤버 2건(정태/민주) 데이터. Task 9 이후의 프론트 로그인이 이 코드를 사용한다.

- [ ] **Step 1: 시드 SQL 작성**

`workers/seed.sql`:

```sql
INSERT INTO couples (id, created_at) VALUES ('couple-1', datetime('now'));

INSERT INTO members (id, couple_id, code, name, created_at)
VALUES ('member-jeongtae', 'couple-1', 'REPLACE_WITH_JEONGTAE_CODE', '정태', datetime('now'));

INSERT INTO members (id, couple_id, code, name, created_at)
VALUES ('member-minju', 'couple-1', 'REPLACE_WITH_MINJU_CODE', '민주', datetime('now'));
```

- [ ] **Step 2: 코드 값을 실제 비밀 코드로 교체**

`workers/seed.sql`에서 `REPLACE_WITH_JEONGTAE_CODE`, `REPLACE_WITH_MINJU_CODE`를 각자 기억하기 쉬우면서 남이 쉽게 못 맞추는 문자열(예: 영문+숫자 8자리)로 직접 바꾼다. 이 값이 곧 두 사람의 로그인 코드가 된다.

- [ ] **Step 3: 원격 D1에 시드 실행**

Run: `npx wrangler d1 execute budget-couple-db --remote --file=workers/seed.sql`
Expected: `2 rows written` 등 성공 메시지 (couples 1행 + members 2행 = 실제로는 3개의 INSERT 문 실행 결과)

- [ ] **Step 4: 시드가 들어갔는지 확인**

Run: `npx wrangler d1 execute budget-couple-db --remote --command="SELECT id, name FROM members"`
Expected: `정태`, `민주` 두 행 출력

- [ ] **Step 5: seed.sql에서 실제 코드 값을 다시 플레이스홀더로 되돌리고 커밋 (비밀 코드를 git에 남기지 않기 위함)**

`workers/seed.sql`의 코드 값을 `REPLACE_WITH_JEONGTAE_CODE` / `REPLACE_WITH_MINJU_CODE`로 되돌린 뒤:

```bash
git add workers/seed.sql
git commit -m "커플/멤버 시드 스크립트 템플릿 추가"
```

실제 발급한 코드 두 개는 정태·민주 두 사람에게 직접(메신저 등으로) 전달하고, 별도로 메모해둔다.

---

## Task 7: 프론트 — 설정 저장 함수 리팩토링 (localStorage.setItem 산재 호출 정리)

**Files:**
- Modify: `index.html:1738-1741` (기존 `saveData()` 근처에 새 함수들 추가)
- Modify: `index.html` (아래 6개 키에 대한 `localStorage.setItem(...)` 호출을 `replace_all`로 함수 호출로 교체)
- Modify: `index.html:842-849` (`editTitle()`)

**Interfaces:**
- Produces: `saveAccounts()`, `saveCategories()`, `saveMonthlyBudgets()`, `saveFixedExpenses()`, `saveMonthlyGoals()`, `saveMonthlyAssets()`, `saveTitle()`, `getSettingsSnapshot()` — Task 12에서 이 함수들 안에 서버 저장 호출을 추가한다.
- 이 태스크는 **동작을 바꾸지 않는 순수 리팩토링**이다 (여전히 localStorage에만 저장). Task 12에서 서버 저장을 덧붙인다.

- [ ] **Step 1: saveData() 옆에 7개 named 함수와 getSettingsSnapshot() 추가**

`index.html`의 `saveData()` 함수(약 1738번째 줄) 바로 다음에 추가:

```js
    // 데이터 저장
    function saveData() {
        localStorage.setItem('couple_account_book', JSON.stringify(transactions));
    }

    function getSettingsSnapshot() {
        return {
            title: appTitle,
            accounts: accounts,
            categories: categories,
            monthlyBudgets: monthlyBudgets,
            fixedExpenses: fixedExpenses,
            monthlyGoals: monthlyGoals,
            monthlyAssetsData: monthlyAssetsData
        };
    }

    function saveAccounts() {
        localStorage.setItem('couple_accounts', JSON.stringify(accounts));
    }

    function saveCategories() {
        localStorage.setItem('couple_categories', JSON.stringify(categories));
    }

    function saveMonthlyBudgets() {
        localStorage.setItem('couple_monthly_budgets', JSON.stringify(monthlyBudgets));
    }

    function saveFixedExpenses() {
        localStorage.setItem('couple_fixed_expenses', JSON.stringify(fixedExpenses));
    }

    function saveMonthlyGoals() {
        localStorage.setItem('couple_monthly_goals', JSON.stringify(monthlyGoals));
    }

    function saveMonthlyAssets() {
        localStorage.setItem('couple_monthly_assets', JSON.stringify(monthlyAssetsData));
    }

    function saveTitle() {
        localStorage.setItem('budget_title', appTitle);
    }
```

(주: `saveData()` 원본은 그대로 두고 아래에 이어붙인다. `getSettingsSnapshot()`은 지금은 어디서도 안 쓰이지만 Task 12에서 사용한다 — 이 태스크에서는 정의만 해둔다.)

- [ ] **Step 2: couple_accounts 저장 호출을 saveAccounts()로 교체 (replace_all)**

`old_string` (정확히 이 문자열, `replace_all: true`):
```
localStorage.setItem('couple_accounts', JSON.stringify(accounts));
```
`new_string`:
```
saveAccounts();
```

이 문자열은 `index.html`에 7곳(라인 818, 1146, 1261, 1302, 1467, 1522, 1536) 존재하며 들여쓰기만 다르고 내용은 동일하므로 `replace_all`로 한 번에 교체된다. (818번째 줄은 DOMContentLoaded 안의 옛날 계좌 마이그레이션 로직인데, 여기서도 `saveAccounts()`로 바뀌어도 동작에는 문제 없다 — 단순히 저장 함수를 통일하는 것뿐이다.)

- [ ] **Step 3: couple_categories 저장 호출을 saveCategories()로 교체 (replace_all)**

`old_string`:
```
localStorage.setItem('couple_categories', JSON.stringify(categories));
```
`new_string`:
```
saveCategories();
```

- [ ] **Step 4: couple_monthly_budgets 저장 호출을 saveMonthlyBudgets()로 교체**

`old_string`:
```
localStorage.setItem('couple_monthly_budgets', JSON.stringify(monthlyBudgets));
```
`new_string`:
```
saveMonthlyBudgets();
```

- [ ] **Step 5: couple_fixed_expenses 저장 호출을 saveFixedExpenses()로 교체 (replace_all)**

`old_string`:
```
localStorage.setItem('couple_fixed_expenses', JSON.stringify(fixedExpenses));
```
`new_string`:
```
saveFixedExpenses();
```

- [ ] **Step 6: couple_monthly_goals 저장 호출을 saveMonthlyGoals()로 교체**

`old_string`:
```
localStorage.setItem('couple_monthly_goals', JSON.stringify(monthlyGoals));
```
`new_string`:
```
saveMonthlyGoals();
```

- [ ] **Step 7: couple_monthly_assets 저장 호출을 saveMonthlyAssets()로 교체 (replace_all)**

`old_string`:
```
localStorage.setItem('couple_monthly_assets', JSON.stringify(monthlyAssetsData));
```
`new_string`:
```
saveMonthlyAssets();
```

- [ ] **Step 8: editTitle()의 budget_title 저장 호출을 saveTitle()로 교체**

`editTitle()` 함수(약 842번째 줄):

`old_string`:
```js
    function editTitle() {
        const newTitle = prompt("가계부 이름을 입력해주세요 (예: 철수의 가계부):", appTitle);
        if (newTitle) {
            appTitle = newTitle;
            localStorage.setItem('budget_title', newTitle);
            updateTitleUI();
        }
    }
```
`new_string`:
```js
    function editTitle() {
        const newTitle = prompt("가계부 이름을 입력해주세요 (예: 철수의 가계부):", appTitle);
        if (newTitle) {
            appTitle = newTitle;
            saveTitle();
            updateTitleUI();
        }
    }
```

- [ ] **Step 9: 브라우저로 열어서 동작 확인 (자동 테스트 없는 프론트 코드이므로 수동 확인)**

`index.html`을 브라우저로 열고: 계좌 추가, 카테고리 추가, 고정지출 추가, 목표 설정, 자산 기록, 제목 변경을 각각 한 번씩 해본다.
Expected: 이전과 동일하게 동작하고, 새로고침해도 값이 유지된다 (여전히 localStorage 기반이므로 브라우저 개발자 도구 콘솔에서 에러가 없는지도 확인).

- [ ] **Step 10: 커밋**

```bash
git add index.html
git commit -m "설정 저장 로직을 named 함수로 리팩토링 (동작 변경 없음)"
```

---

## Task 8: 프론트 — sync.js API 클라이언트 작성

**Files:**
- Create: `sync.js`

**Interfaces:**
- Produces:
  - `getSyncSession(): {code, memberId, memberName, partnerId, partnerName} | null`
  - `fetchOwnBook(): Promise<{transactions, settings}>`
  - `fetchPartnerBook(): Promise<{transactions, settings}>`
  - `pushNewTransaction(transaction): Promise<void>`
  - `pushDeleteTransaction(transactionId): Promise<void>`
  - `pushSettings(settings): Promise<void>`
  - `pushImportBackup(backup): Promise<{importedCount:number}>`
  - Task 9~12에서 `index.html`의 메인 스크립트가 이 함수들을 그대로 호출한다.
- 자동 테스트는 두지 않는다 (브라우저 `fetch`/`prompt`/`localStorage`에 강하게 의존하는 얇은 클라이언트 코드이며, 이 프로젝트에는 브라우저 테스트 하네스가 없다 — Task 9의 수동 확인 단계에서 함께 검증한다).

- [ ] **Step 1: sync.js 작성**

`sync.js`:

```js
const DEFAULT_COUPLE_API_URL = 'https://budget-price-worker.49ball.workers.dev';

function getApiBaseUrl() {
    let url = localStorage.getItem('couple_api_base_url');
    if (!url) {
        const suggested = localStorage.getItem('budget_price_api_url') || DEFAULT_COUPLE_API_URL;
        url = prompt('가계부 서버 주소를 입력해주세요 (Cloudflare Worker 주소):', suggested);
        if (url) {
            localStorage.setItem('couple_api_base_url', url.trim());
        }
    }
    return (url || '').replace(/\/$/, '');
}

async function apiRequest(path, { method = 'GET', code, body } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (code) headers['X-Member-Code'] = code;

    const response = await fetch(`${getApiBaseUrl()}${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined
    });

    const data = await response.json();
    if (!response.ok || !data.success) {
        throw new Error(data.message || `요청에 실패했습니다 (${response.status})`);
    }
    return data;
}

function apiLogin(code) {
    return apiRequest('/api/login', { method: 'POST', code });
}

function apiGetBook(memberId, code) {
    return apiRequest(`/api/books/${memberId}`, { method: 'GET', code });
}

function apiCreateTransaction(memberId, code, transaction) {
    return apiRequest(`/api/books/${memberId}/transactions`, { method: 'POST', code, body: { transaction } });
}

function apiDeleteTransaction(memberId, code, transactionId) {
    return apiRequest(`/api/books/${memberId}/transactions/${transactionId}`, { method: 'DELETE', code });
}

function apiPutSettings(memberId, code, settings) {
    return apiRequest(`/api/books/${memberId}/settings`, { method: 'PUT', code, body: { settings } });
}

function apiImportBackup(memberId, code, backup) {
    return apiRequest(`/api/books/${memberId}/import`, { method: 'POST', code, body: { backup } });
}

let syncSession = null;

function getSyncSession() {
    return syncSession;
}

async function loginWithCode(code) {
    const result = await apiLogin(code);
    syncSession = {
        code,
        memberId: result.memberId,
        memberName: result.memberName,
        partnerId: result.partner ? result.partner.memberId : null,
        partnerName: result.partner ? result.partner.memberName : null
    };
    localStorage.setItem('couple_member_code', code);
    return syncSession;
}

async function ensureLoggedIn() {
    if (syncSession) return syncSession;

    const savedCode = localStorage.getItem('couple_member_code');
    if (savedCode) {
        try {
            return await loginWithCode(savedCode);
        } catch (err) {
            localStorage.removeItem('couple_member_code');
            alert('저장된 코드로 로그인하지 못했습니다. 코드를 다시 입력해주세요.\n' + err.message);
        }
    }

    const enteredCode = prompt('가계부 코드를 입력해주세요:');
    if (!enteredCode) {
        throw new Error('로그인 코드가 필요합니다.');
    }

    try {
        return await loginWithCode(enteredCode.trim());
    } catch (err) {
        alert('로그인에 실패했습니다.\n' + err.message);
        return ensureLoggedIn();
    }
}

async function fetchOwnBook() {
    const session = await ensureLoggedIn();
    return apiGetBook(session.memberId, session.code);
}

async function fetchPartnerBook() {
    const session = await ensureLoggedIn();
    if (!session.partnerId) {
        return { transactions: [], settings: null };
    }
    return apiGetBook(session.partnerId, session.code);
}

async function pushNewTransaction(transaction) {
    const session = await ensureLoggedIn();
    return apiCreateTransaction(session.memberId, session.code, transaction);
}

async function pushDeleteTransaction(transactionId) {
    const session = await ensureLoggedIn();
    return apiDeleteTransaction(session.memberId, session.code, transactionId);
}

async function pushSettings(settings) {
    const session = await ensureLoggedIn();
    return apiPutSettings(session.memberId, session.code, settings);
}

async function pushImportBackup(backup) {
    const session = await ensureLoggedIn();
    return apiImportBackup(session.memberId, session.code, backup);
}
```

- [ ] **Step 2: index.html에 sync.js 스크립트 태그 추가**

`index.html`에서 chart.js CDN 스크립트 다음, 메인 인라인 스크립트 시작 전(약 792-793번째 줄):

`old_string`:
```html
<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
<script>
    // 1. 데이터 관리 (LocalStorage 사용)
```
`new_string`:
```html
<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
<script src="sync.js"></script>
<script>
    // 1. 데이터 관리 (LocalStorage 사용)
```

(주: `sync.js`가 메인 인라인 스크립트보다 먼저 로드되어야 메인 스크립트에서 `fetchOwnBook()` 같은 함수를 즉시 호출할 수 있다. `function` 선언은 스크립트 태그 간에도 전역으로 공유되므로 이 순서로 충분하다.)

- [ ] **Step 3: 커밋**

```bash
git add sync.js index.html
git commit -m "커플 가계부 API 클라이언트(sync.js) 추가"
```

---

## Task 9: 프론트 — 초기 로드 시 원격 데이터 연동

**Files:**
- Modify: `index.html:809-836` (`DOMContentLoaded` 핸들러)

**Interfaces:**
- Consumes: `fetchOwnBook()`, `getSyncSession()` (Task 8)
- Produces: 페이지 로드 시 로컬 캐시 대신 서버 데이터로 전역 변수(`transactions`, `accounts` 등)를 채운다.

- [ ] **Step 1: DOMContentLoaded 핸들러를 async로 바꾸고 원격 fetch 추가**

`old_string`:
```js
    // 초기 실행
    document.addEventListener('DOMContentLoaded', () => {
        // 기존 데이터 마이그레이션 (단순 금액 -> 계좌 시스템)
        const oldStock = parseInt(localStorage.getItem('couple_stock_asset'));
        const oldSavings = parseInt(localStorage.getItem('couple_savings_asset'));
        
        if (accounts.length === 0 && (oldStock || oldSavings)) {
            if (oldStock) accounts.push({ id: Date.now(), name: '기본 주식/투자', type: 'stock', balance: oldStock });
            if (oldSavings) accounts.push({ id: Date.now() + 1, name: '기본 예적금', type: 'savings', balance: oldSavings });
            saveAccounts();
            // 기존 키 삭제 (혼동 방지)
            localStorage.removeItem('couple_stock_asset');
            localStorage.removeItem('couple_savings_asset');
        }

        document.getElementById('date').valueAsDate = new Date(); // 입력 폼은 오늘 날짜로
        
        const today = new Date();
        document.getElementById('saveAssetMonth').value = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
        
        updateTitleUI();
        renderCategoryOptions();
        const lastPriceUpdate = localStorage.getItem('budget_last_price_update');
        if (lastPriceUpdate) {
            document.getElementById('priceUpdateStatus').innerText = `최근 업데이트: ${lastPriceUpdate}`;
        }
        renderAll();
    });
```
`new_string`:
```js
    // 초기 실행
    document.addEventListener('DOMContentLoaded', async () => {
        // 기존 데이터 마이그레이션 (단순 금액 -> 계좌 시스템)
        const oldStock = parseInt(localStorage.getItem('couple_stock_asset'));
        const oldSavings = parseInt(localStorage.getItem('couple_savings_asset'));
        
        if (accounts.length === 0 && (oldStock || oldSavings)) {
            if (oldStock) accounts.push({ id: Date.now(), name: '기본 주식/투자', type: 'stock', balance: oldStock });
            if (oldSavings) accounts.push({ id: Date.now() + 1, name: '기본 예적금', type: 'savings', balance: oldSavings });
            saveAccounts();
            // 기존 키 삭제 (혼동 방지)
            localStorage.removeItem('couple_stock_asset');
            localStorage.removeItem('couple_savings_asset');
        }

        document.getElementById('date').valueAsDate = new Date(); // 입력 폼은 오늘 날짜로
        
        const today = new Date();
        document.getElementById('saveAssetMonth').value = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;

        try {
            const book = await fetchOwnBook();
            transactions = book.transactions;
            accounts = book.settings.accounts;
            categories = book.settings.categories;
            monthlyBudgets = book.settings.monthlyBudgets;
            fixedExpenses = book.settings.fixedExpenses;
            monthlyGoals = book.settings.monthlyGoals;
            monthlyAssetsData = book.settings.monthlyAssetsData;
            appTitle = book.settings.title;
        } catch (err) {
            alert('온라인 데이터를 불러오지 못했습니다. 인터넷 연결을 확인해주세요.\n' + err.message);
        }

        updateTitleUI();
        renderCategoryOptions();
        const lastPriceUpdate = localStorage.getItem('budget_last_price_update');
        if (lastPriceUpdate) {
            document.getElementById('priceUpdateStatus').innerText = `최근 업데이트: ${lastPriceUpdate}`;
        }
        renderAll();
    });
```

- [ ] **Step 2: 로컬에서 Worker 실행 (수동 확인 준비)**

Run: `npx wrangler dev`
Expected: `http://localhost:8787`에서 워커가 뜬다 (터미널을 열어둔 채로 다음 단계 진행)

- [ ] **Step 3: 브라우저로 index.html을 열어 로그인 + 원격 로드 확인**

`index.html`을 브라우저(파일 직접 열기 또는 로컬 정적 서버)로 연다.
- 최초 접속 시 "가계부 서버 주소를 입력해주세요" 프롬프트가 뜨면 `http://localhost:8787` 입력
- 이어서 "가계부 코드를 입력해주세요" 프롬프트가 뜨면 Task 6에서 발급한 정태 코드 입력
Expected: 로그인 후 화면이 정상적으로 렌더링된다 (처음이라 빈 목록). 브라우저 개발자 도구 Network 탭에서 `GET /api/books/member-jeongtae` 요청이 200으로 성공한 것을 확인한다.

- [ ] **Step 4: 커밋**

```bash
git add index.html
git commit -m "초기 로드 시 서버에서 가계부 데이터를 불러오도록 연동"
```

---

## Task 10: 프론트 — 거래 추가/삭제 서버 연동

**Files:**
- Modify: `index.html:1711-1725` (거래 입력 폼 submit 핸들러)
- Modify: `index.html:1744-1751` (`deleteItem`)
- Modify: `index.html:1653-1664` (`applyFixedExpensesToCurrentMonth` 내 반복 추가)

**Interfaces:**
- Consumes: `pushNewTransaction(transaction)`, `pushDeleteTransaction(id)` (Task 8)

- [ ] **Step 1: 거래 입력 폼 submit 핸들러 수정**

`old_string`:
```js
        transactions.push(newTransaction);
        saveData();
        renderAll();

        if (editingId) {
```
`new_string`:
```js
        transactions.push(newTransaction);
        saveData();
        pushNewTransaction(newTransaction).catch(err => alert('서버 저장에 실패했습니다. 다시 시도해주세요.\n' + err.message));
        renderAll();

        if (editingId) {
```

- [ ] **Step 2: deleteItem() 수정**

`old_string`:
```js
    function deleteItem(id) {
        const target = transactions.find(t => t.id === id);
        if (target) {
            transactions = transactions.filter(t => t.id !== id);
            saveData();
            renderAll();
        }
    }
```
`new_string`:
```js
    function deleteItem(id) {
        const target = transactions.find(t => t.id === id);
        if (target) {
            transactions = transactions.filter(t => t.id !== id);
            saveData();
            pushDeleteTransaction(id).catch(err => alert('서버 삭제에 실패했습니다. 다시 시도해주세요.\n' + err.message));
            renderAll();
        }
    }
```

(주: 거래 "수정"은 기존 코드에서 `deleteItem(editingId)` 호출 후 새 거래를 `push`하는 방식으로 이미 구현되어 있으므로, 이 두 곳만 고치면 수정 흐름도 자동으로 서버에 반영된다.)

- [ ] **Step 3: applyFixedExpensesToCurrentMonth()의 반복 추가 부분 수정**

`old_string`:
```js
            fixedExpenses.forEach(item => {
                const day = String(item.day).padStart(2, '0');
                transactions.push({
                    id: Date.now() + Math.random(), // 유니크 ID 생성
                    date: `${year}-${month}-${day}`,
                    type: 'expense',
                    category: '고정', // 수정: 고정 지출은 '고정' 카테고리로 분류
                    amount: item.amount,
                    desc: `[고정] ${item.desc}`
                });
            });
            saveData();
```
`new_string`:
```js
            fixedExpenses.forEach(item => {
                const day = String(item.day).padStart(2, '0');
                const newFixedTransaction = {
                    id: Date.now() + Math.random(), // 유니크 ID 생성
                    date: `${year}-${month}-${day}`,
                    type: 'expense',
                    category: '고정', // 수정: 고정 지출은 '고정' 카테고리로 분류
                    amount: item.amount,
                    desc: `[고정] ${item.desc}`
                };
                transactions.push(newFixedTransaction);
                pushNewTransaction(newFixedTransaction).catch(err => alert('서버 저장에 실패했습니다. 다시 시도해주세요.\n' + err.message));
            });
            saveData();
```

- [ ] **Step 4: 브라우저로 수동 확인**

`npx wrangler dev`가 실행 중인 상태에서 브라우저로 거래를 하나 추가하고, Network 탭에서 `POST /api/books/member-jeongtae/transactions`가 201로 성공하는지 확인한다. 그 거래를 삭제하고 `DELETE /api/books/member-jeongtae/transactions/:id`가 200으로 성공하는지 확인한다. 페이지를 새로고침해도 삭제한 거래가 다시 나타나지 않는지 확인한다.

- [ ] **Step 5: 커밋**

```bash
git add index.html
git commit -m "거래 추가/삭제를 서버 API와 연동"
```

---

## Task 11: 프론트 — 설정 저장 함수 + 백업 가져오기 서버 연동

**Files:**
- Modify: `index.html` (Task 7에서 만든 7개 `save*()` 함수 안에 서버 저장 호출 추가)
- Modify: `index.html:2307-2333` (`importData`)

**Interfaces:**
- Consumes: `pushSettings(settings)`, `pushImportBackup(backup)`, `getSettingsSnapshot()` (Task 7, 8)

- [ ] **Step 1: 7개 save*() 함수에 서버 저장 호출 추가**

`old_string`:
```js
    function getSettingsSnapshot() {
        return {
            title: appTitle,
            accounts: accounts,
            categories: categories,
            monthlyBudgets: monthlyBudgets,
            fixedExpenses: fixedExpenses,
            monthlyGoals: monthlyGoals,
            monthlyAssetsData: monthlyAssetsData
        };
    }

    function saveAccounts() {
        localStorage.setItem('couple_accounts', JSON.stringify(accounts));
    }

    function saveCategories() {
        localStorage.setItem('couple_categories', JSON.stringify(categories));
    }

    function saveMonthlyBudgets() {
        localStorage.setItem('couple_monthly_budgets', JSON.stringify(monthlyBudgets));
    }

    function saveFixedExpenses() {
        localStorage.setItem('couple_fixed_expenses', JSON.stringify(fixedExpenses));
    }

    function saveMonthlyGoals() {
        localStorage.setItem('couple_monthly_goals', JSON.stringify(monthlyGoals));
    }

    function saveMonthlyAssets() {
        localStorage.setItem('couple_monthly_assets', JSON.stringify(monthlyAssetsData));
    }

    function saveTitle() {
        localStorage.setItem('budget_title', appTitle);
    }
```
`new_string`:
```js
    function getSettingsSnapshot() {
        return {
            title: appTitle,
            accounts: accounts,
            categories: categories,
            monthlyBudgets: monthlyBudgets,
            fixedExpenses: fixedExpenses,
            monthlyGoals: monthlyGoals,
            monthlyAssetsData: monthlyAssetsData
        };
    }

    function saveSettingsToServer() {
        pushSettings(getSettingsSnapshot()).catch(err => alert('서버 저장에 실패했습니다. 다시 시도해주세요.\n' + err.message));
    }

    function saveAccounts() {
        localStorage.setItem('couple_accounts', JSON.stringify(accounts));
        saveSettingsToServer();
    }

    function saveCategories() {
        localStorage.setItem('couple_categories', JSON.stringify(categories));
        saveSettingsToServer();
    }

    function saveMonthlyBudgets() {
        localStorage.setItem('couple_monthly_budgets', JSON.stringify(monthlyBudgets));
        saveSettingsToServer();
    }

    function saveFixedExpenses() {
        localStorage.setItem('couple_fixed_expenses', JSON.stringify(fixedExpenses));
        saveSettingsToServer();
    }

    function saveMonthlyGoals() {
        localStorage.setItem('couple_monthly_goals', JSON.stringify(monthlyGoals));
        saveSettingsToServer();
    }

    function saveMonthlyAssets() {
        localStorage.setItem('couple_monthly_assets', JSON.stringify(monthlyAssetsData));
        saveSettingsToServer();
    }

    function saveTitle() {
        localStorage.setItem('budget_title', appTitle);
        saveSettingsToServer();
    }
```

- [ ] **Step 2: importData()를 서버 저장과 연동**

`old_string`:
```js
    function importData(input) {
        const file = input.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = function(e) {
            try {
                const data = JSON.parse(e.target.result);
                if (confirm("현재 데이터를 덮어쓰고 백업 파일을 불러오시겠습니까? (기존 데이터는 사라집니다)")) {
                    localStorage.setItem('couple_account_book', JSON.stringify(data.transactions || []));
                    localStorage.setItem('budget_title', data.appTitle || '커플 가계부');
                    localStorage.setItem('couple_monthly_goals', JSON.stringify(data.monthlyGoals || {}));
                    localStorage.setItem('couple_monthly_assets', JSON.stringify(data.monthlyAssetsData || {}));
                    localStorage.setItem('couple_accounts', JSON.stringify(data.accounts || []));
                    localStorage.setItem('couple_categories', JSON.stringify(data.categories || ['식비', '교통', '쇼핑', '주거/통신', '월급', '기타']));
                    localStorage.setItem('couple_monthly_budgets', JSON.stringify(data.monthlyBudgets || {}));
                    localStorage.setItem('couple_fixed_expenses', JSON.stringify(data.fixedExpenses || []));
                    alert("복구가 완료되었습니다. 페이지를 새로고침합니다.");
                    location.reload();
                }
            } catch (error) {
                alert("잘못된 백업 파일입니다.");
            }
        };
        reader.readAsText(file);
        input.value = ''; // 초기화
    }
```
`new_string`:
```js
    function importData(input) {
        const file = input.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = async function(e) {
            try {
                const data = JSON.parse(e.target.result);
                if (confirm("현재 데이터를 덮어쓰고 백업 파일을 불러오시겠습니까? (기존 데이터는 사라집니다)")) {
                    localStorage.setItem('couple_account_book', JSON.stringify(data.transactions || []));
                    localStorage.setItem('budget_title', data.appTitle || '커플 가계부');
                    localStorage.setItem('couple_monthly_goals', JSON.stringify(data.monthlyGoals || {}));
                    localStorage.setItem('couple_monthly_assets', JSON.stringify(data.monthlyAssetsData || {}));
                    localStorage.setItem('couple_accounts', JSON.stringify(data.accounts || []));
                    localStorage.setItem('couple_categories', JSON.stringify(data.categories || ['식비', '교통', '쇼핑', '주거/통신', '월급', '기타']));
                    localStorage.setItem('couple_monthly_budgets', JSON.stringify(data.monthlyBudgets || {}));
                    localStorage.setItem('couple_fixed_expenses', JSON.stringify(data.fixedExpenses || []));
                    try {
                        await pushImportBackup(data);
                        alert("복구가 완료되었습니다. 페이지를 새로고침합니다.");
                        location.reload();
                    } catch (err) {
                        alert('서버로 백업 데이터를 보내지 못했습니다. 인터넷 연결을 확인하고 다시 시도해주세요.\n' + err.message);
                    }
                }
            } catch (error) {
                alert("잘못된 백업 파일입니다.");
            }
        };
        reader.readAsText(file);
        input.value = ''; // 초기화
    }
```

- [ ] **Step 3: 브라우저로 수동 확인**

`npx wrangler dev` 실행 상태에서 계좌를 하나 추가하고 Network 탭에서 `PUT /api/books/member-jeongtae/settings`가 200으로 성공하는지 확인한다. 기존 "💾 백업 저장"으로 만든 JSON 파일을 "📂 백업 불러오기"로 불러와서 `POST /api/books/member-jeongtae/import`가 성공하고 새로고침 후에도 데이터가 유지되는지 확인한다.

- [ ] **Step 4: 커밋**

```bash
git add index.html
git commit -m "설정 저장과 백업 가져오기를 서버 API와 연동"
```

---

## Task 12: 프론트 — 상대방 가계부 탭(읽기 전용) 구현

**Files:**
- Modify: `index.html:368` (탭 UI 추가)
- Modify: `index.html` (`<style>` 블록에 읽기 전용 CSS 추가)
- Modify: `index.html` (여러 버튼/폼에 `owner-only` 클래스 추가)
- Modify: `index.html` (`switchBookTab()`, `setupPartnerTabUI()` 함수 추가 + DOMContentLoaded에서 호출)

**Interfaces:**
- Consumes: `fetchPartnerBook()`, `fetchOwnBook()`, `getSyncSession()` (Task 8)

- [ ] **Step 1: 탭 UI 추가**

`old_string`:
```html
<div class="container">
    <!-- 0. 커플 목표 -->
```
`new_string`:
```html
<div class="container mb-3" id="bookTabBar" style="display:none;">
    <ul class="nav nav-pills">
        <li class="nav-item"><button type="button" class="nav-link active" id="tabMine" onclick="switchBookTab('mine')">내 가계부</button></li>
        <li class="nav-item"><button type="button" class="nav-link" id="tabPartner" onclick="switchBookTab('partner')">상대방 가계부</button></li>
    </ul>
</div>

<div class="container">
    <!-- 0. 커플 목표 -->
```

- [ ] **Step 2: 읽기 전용 모드 CSS 추가**

`index.html`의 `<style>` 블록 맨 끝에 추가 (마지막 `</style>` 태그 바로 앞):

`old_string`:
```
        .text-danger  { color: #ff7675 !important; }
```
`new_string`:
```
        .text-danger  { color: #ff7675 !important; }
        body.read-only-mode .owner-only { display: none !important; }
```

- [ ] **Step 3: 정적 owner-only 버튼/폼에 클래스 추가**

`old_string`:
```html
            <button class="btn btn-outline-info btn-sm ms-2" onclick="exportData()">💾 백업 저장</button>
            <button class="btn btn-outline-secondary btn-sm" onclick="document.getElementById('importFile').click()">📂 백업 불러오기</button>
```
`new_string`:
```html
            <button class="btn btn-outline-info btn-sm ms-2 owner-only" onclick="exportData()">💾 백업 저장</button>
            <button class="btn btn-outline-secondary btn-sm owner-only" onclick="document.getElementById('importFile').click()">📂 백업 불러오기</button>
```

`old_string`:
```html
        <button class="btn btn-sm btn-primary text-white" onclick="editGoal()">목표 설정</button>
```
`new_string`:
```html
        <button class="btn btn-sm btn-primary text-white owner-only" onclick="editGoal()">목표 설정</button>
```

`old_string`:
```html
                        <button class="btn btn-sm btn-light text-primary fw-bold ms-2" style="font-size: 0.85rem;" onclick="saveCurrentTotalAsset()">이 달의 자산으로 기록</button>
```
`new_string`:
```html
                        <button class="btn btn-sm btn-light text-primary fw-bold ms-2 owner-only" style="font-size: 0.85rem;" onclick="saveCurrentTotalAsset()">이 달의 자산으로 기록</button>
```

`old_string`:
```html
        <form id="accountForm" class="row g-3">
```
`new_string`:
```html
        <form id="accountForm" class="row g-3 owner-only">
```

`old_string`:
```html
                    <button class="btn btn-primary" onclick="addCategory()">추가</button>
```
`new_string`:
```html
                    <button class="btn btn-primary owner-only" onclick="addCategory()">추가</button>
```

`old_string`:
```html
                        <button class="btn btn-primary w-100" onclick="addAccount()">➕ 계좌 추가하기</button>
```
`new_string`:
```html
                        <button class="btn btn-primary w-100 owner-only" onclick="addAccount()">➕ 계좌 추가하기</button>
```

`old_string`:
```html
                    <button class="btn btn-primary" onclick="addFixedExpense()">추가</button>
```
`new_string`:
```html
                    <button class="btn btn-primary owner-only" onclick="addFixedExpense()">추가</button>
```

`old_string`:
```html
                    <button class="btn btn-success" onclick="applyFixedExpensesToCurrentMonth()">👇 이번 달에 고정 지출 일괄 등록하기</button>
```
`new_string`:
```html
                    <button class="btn btn-success owner-only" onclick="applyFixedExpensesToCurrentMonth()">👇 이번 달에 고정 지출 일괄 등록하기</button>
```

`old_string`:
```html
                            <button class="btn btn-primary" onclick="saveManualMonthlyAsset()">추가/수정</button>
```
`new_string`:
```html
                            <button class="btn btn-primary owner-only" onclick="saveManualMonthlyAsset()">추가/수정</button>
```

- [ ] **Step 4: 렌더링 템플릿 안의 버튼들에 owner-only 클래스 추가**

`old_string`:
```html
<button class="btn btn-outline-danger btn-sm" onclick="deleteMonthlyAssetRecord('${monthKey}')">삭제</button>
```
`new_string`:
```html
<button class="btn btn-outline-danger btn-sm owner-only" onclick="deleteMonthlyAssetRecord('${monthKey}')">삭제</button>
```

`old_string`:
```html
                        <button class="btn btn-sm btn-outline-secondary" onclick="editAccountInfo(${acc.id})">정보 수정</button>
                        <button class="btn btn-sm btn-outline-primary" onclick="editAccount(${acc.id})">${acc.type === 'stock' ? '평가액 수정' : '금액 수정'}</button>
                        <button class="btn btn-sm btn-outline-danger" onclick="deleteAccount(${acc.id})">삭제</button>
```
`new_string`:
```html
                        <button class="btn btn-sm btn-outline-secondary owner-only" onclick="editAccountInfo(${acc.id})">정보 수정</button>
                        <button class="btn btn-sm btn-outline-primary owner-only" onclick="editAccount(${acc.id})">${acc.type === 'stock' ? '평가액 수정' : '금액 수정'}</button>
                        <button class="btn btn-sm btn-outline-danger owner-only" onclick="deleteAccount(${acc.id})">삭제</button>
```

`old_string`:
```html
                    <button class="btn btn-sm btn-danger" onclick="deleteCategory(${index})">삭제</button>
```
`new_string`:
```html
                    <button class="btn btn-sm btn-danger owner-only" onclick="deleteCategory(${index})">삭제</button>
```

`old_string`:
```html
                    <button class="btn btn-sm btn-outline-danger" onclick="deleteFixedExpense(${index})">삭제</button>
```
`new_string`:
```html
                    <button class="btn btn-sm btn-outline-danger owner-only" onclick="deleteFixedExpense(${index})">삭제</button>
```

`old_string`:
```html
                        <button class="btn btn-sm btn-outline-primary border-0 me-1" onclick="editTransaction(${t.id})" title="수정하기"><i class="bi bi-pencil"></i></button>
                        <button class="btn btn-sm btn-outline-danger border-0" onclick="deleteItem(${t.id})" title="삭제하기"><i class="bi bi-trash"></i></button>
```
`new_string`:
```html
                        <button class="btn btn-sm btn-outline-primary border-0 me-1 owner-only" onclick="editTransaction(${t.id})" title="수정하기"><i class="bi bi-pencil"></i></button>
                        <button class="btn btn-sm btn-outline-danger border-0 owner-only" onclick="deleteItem(${t.id})" title="삭제하기"><i class="bi bi-trash"></i></button>
```

- [ ] **Step 5: switchBookTab(), setupPartnerTabUI() 함수 추가**

`saveTitle()` 함수 바로 다음에 추가 (Task 7에서 만든 함수 블록 바로 뒤):

`old_string`:
```js
    function saveTitle() {
        localStorage.setItem('budget_title', appTitle);
        saveSettingsToServer();
    }
```
`new_string`:
```js
    function saveTitle() {
        localStorage.setItem('budget_title', appTitle);
        saveSettingsToServer();
    }

    let currentBookTab = 'mine';

    function setupPartnerTabUI() {
        const session = getSyncSession();
        if (!session || !session.partnerId) return;
        document.getElementById('tabPartner').innerText = `${session.partnerName} 가계부`;
        document.getElementById('bookTabBar').style.display = 'block';
    }

    async function switchBookTab(tab) {
        if (tab === currentBookTab) return;
        try {
            const book = tab === 'partner' ? await fetchPartnerBook() : await fetchOwnBook();
            transactions = book.transactions;
            if (book.settings) {
                accounts = book.settings.accounts;
                categories = book.settings.categories;
                monthlyBudgets = book.settings.monthlyBudgets;
                fixedExpenses = book.settings.fixedExpenses;
                monthlyGoals = book.settings.monthlyGoals;
                monthlyAssetsData = book.settings.monthlyAssetsData;
                appTitle = book.settings.title;
            }
            currentBookTab = tab;
            document.getElementById('tabMine').classList.toggle('active', tab === 'mine');
            document.getElementById('tabPartner').classList.toggle('active', tab === 'partner');
            document.body.classList.toggle('read-only-mode', tab === 'partner');
            updateTitleUI();
            renderCategoryOptions();
            renderAll();
        } catch (err) {
            alert('가계부를 불러오지 못했습니다.\n' + err.message);
        }
    }
```

- [ ] **Step 6: DOMContentLoaded에서 setupPartnerTabUI() 호출**

`old_string`:
```js
        try {
            const book = await fetchOwnBook();
            transactions = book.transactions;
            accounts = book.settings.accounts;
            categories = book.settings.categories;
            monthlyBudgets = book.settings.monthlyBudgets;
            fixedExpenses = book.settings.fixedExpenses;
            monthlyGoals = book.settings.monthlyGoals;
            monthlyAssetsData = book.settings.monthlyAssetsData;
            appTitle = book.settings.title;
        } catch (err) {
            alert('온라인 데이터를 불러오지 못했습니다. 인터넷 연결을 확인해주세요.\n' + err.message);
        }
```
`new_string`:
```js
        try {
            const book = await fetchOwnBook();
            transactions = book.transactions;
            accounts = book.settings.accounts;
            categories = book.settings.categories;
            monthlyBudgets = book.settings.monthlyBudgets;
            fixedExpenses = book.settings.fixedExpenses;
            monthlyGoals = book.settings.monthlyGoals;
            monthlyAssetsData = book.settings.monthlyAssetsData;
            appTitle = book.settings.title;
            setupPartnerTabUI();
        } catch (err) {
            alert('온라인 데이터를 불러오지 못했습니다. 인터넷 연결을 확인해주세요.\n' + err.message);
        }
```

- [ ] **Step 7: 브라우저로 수동 확인**

`npx wrangler dev` 실행 상태에서 정태 코드로 로그인 후:
- 상단에 "내 가계부 / 민주 가계부" 탭이 보이는지 확인
- "민주 가계부" 탭을 누르면 입력 폼, 추가/수정/삭제 버튼이 모두 사라지고 목록만 보이는지 확인
- "내 가계부" 탭으로 돌아오면 다시 버튼들이 보이고 정상적으로 추가/삭제할 수 있는지 확인
- 민주 코드로 다시 로그인(다른 브라우저 프로필이나 시크릿 창)해서 "정태 가계부" 탭에서 정태가 입력한 내역이 보이는지 확인

- [ ] **Step 8: 커밋**

```bash
git add index.html
git commit -m "상대방 가계부 읽기 전용 탭 추가"
```

---

## Task 13: PWA — manifest, 아이콘, 서비스 워커

**Files:**
- Create: `manifest.json`
- Create: `sw.js`
- Create: `scripts/generate-icons.js`
- Modify: `index.html:1-15` (`<head>`)

**Interfaces:**
- Produces: 홈 화면에 추가 가능한 PWA. 외부 이미지 편집 도구 없이 Node 내장 모듈(`zlib`)만으로 아이콘 PNG를 생성한다.

- [ ] **Step 1: 아이콘 생성 스크립트 작성**

`scripts/generate-icons.js`:

```js
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

function crc32(buf) {
    if (!crc32.table) {
        const table = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) {
                c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
            }
            table[n] = c >>> 0;
        }
        crc32.table = table;
    }
    let crc = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
        crc = crc32.table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const typeBuf = Buffer.from(type, 'ascii');
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(data.length, 0);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function createSolidPng(size, [r, g, b]) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(size, 0);
    ihdr.writeUInt32BE(size, 4);
    ihdr.writeUInt8(8, 8);
    ihdr.writeUInt8(2, 9);
    ihdr.writeUInt8(0, 10);
    ihdr.writeUInt8(0, 11);
    ihdr.writeUInt8(0, 12);

    const rowLength = size * 3 + 1;
    const raw = Buffer.alloc(rowLength * size);
    for (let y = 0; y < size; y++) {
        const rowStart = y * rowLength;
        raw[rowStart] = 0;
        for (let x = 0; x < size; x++) {
            const px = rowStart + 1 + x * 3;
            raw[px] = r;
            raw[px + 1] = g;
            raw[px + 2] = b;
        }
    }
    const idat = zlib.deflateSync(raw);

    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    return Buffer.concat([
        signature,
        chunk('IHDR', ihdr),
        chunk('IDAT', idat),
        chunk('IEND', Buffer.alloc(0))
    ]);
}

const outDir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'icon-192.png'), createSolidPng(192, [108, 92, 231]));
fs.writeFileSync(path.join(outDir, 'icon-512.png'), createSolidPng(512, [108, 92, 231]));
console.log('Generated icons/icon-192.png and icons/icon-512.png');
```

- [ ] **Step 2: 스크립트 실행해서 아이콘 생성**

Run: `node scripts/generate-icons.js`
Expected: `Generated icons/icon-192.png and icons/icon-512.png` 출력, `icons/` 디렉토리에 두 PNG 파일 생성

- [ ] **Step 3: 생성된 PNG가 유효한 이미지인지 확인**

Run: `file icons/icon-192.png icons/icon-512.png`
Expected: 둘 다 `PNG image data, 192 x 192` / `PNG image data, 512 x 512`로 출력

(주: 지금은 단색 사각형 아이콘이다. 나중에 원하는 디자인으로 같은 파일명으로 교체해도 매니페스트/HTML은 그대로 동작한다.)

- [ ] **Step 4: manifest.json 작성**

`manifest.json`:

```json
{
    "name": "커플 가계부",
    "short_name": "가계부",
    "start_url": "./index.html",
    "display": "standalone",
    "background_color": "#0a081e",
    "theme_color": "#6c5ce7",
    "icons": [
        { "src": "icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
        { "src": "icons/icon-512.png", "sizes": "512x512", "type": "image/png" }
    ]
}
```

- [ ] **Step 5: 최소 서비스 워커 작성**

`sw.js`:

```js
self.addEventListener('install', () => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', () => {
    // 오프라인 캐싱은 하지 않는다. 이 리스너는 PWA 설치 가능 조건을 충족시키기 위한 용도다.
});
```

- [ ] **Step 6: index.html head에 매니페스트/아이콘/서비스워커 등록 추가**

`old_string`:
```html
    <title>가계부</title>
```
`new_string`:
```html
    <title>가계부</title>
    <link rel="manifest" href="manifest.json">
    <link rel="apple-touch-icon" href="icons/icon-192.png">
    <meta name="theme-color" content="#6c5ce7">
    <script>
        if ('serviceWorker' in navigator) {
            window.addEventListener('load', () => navigator.serviceWorker.register('sw.js'));
        }
    </script>
```

- [ ] **Step 7: 브라우저로 확인**

`npx wrangler dev`와 별개로 정적 파일을 서빙(예: `npx serve .` 또는 기존 `wrangler dev`가 정적 파일도 서빙한다면 그대로 사용)한 뒤 브라우저 개발자 도구 Application 탭에서 Manifest가 인식되는지, Service Worker가 `activated`인지 확인한다. 크롬 모바일에서는 주소창 메뉴에 "앱 설치" 항목이 뜨는지 확인한다.

- [ ] **Step 8: 커밋**

```bash
git add manifest.json sw.js scripts/generate-icons.js icons/icon-192.png icons/icon-512.png index.html
git commit -m "PWA 매니페스트/아이콘/서비스워커 추가 (홈 화면 설치 지원)"
```

---

## Task 14: 배포 및 전체 동작 확인

**Files:**
- 없음 (배포/검증 전용 태스크)

**Interfaces:**
- 없음 (최종 통합 검증)

- [ ] **Step 1: 전체 백엔드 테스트 재실행**

Run: `npm test`
Expected: 모든 테스트 PASS

- [ ] **Step 2: 원격 D1 마이그레이션 적용 확인 (이미 Task 2에서 적용했다면 재확인만)**

Run: `npm run d1:migrate:remote`
Expected: `No migrations to apply` 또는 성공 메시지

- [ ] **Step 3: Worker 배포**

Run: `npx wrangler deploy`
Expected: 배포 성공, Worker URL 출력 (예: `https://budget-price-worker.<계정>.workers.dev`)

- [ ] **Step 4: sync.js의 기본 API 주소를 실제 배포 주소로 맞추기 (선택 사항)**

Step 3에서 출력된 URL이 `sync.js`의 `DEFAULT_COUPLE_API_URL`과 다르면, 처음 접속 시 프롬프트에서 직접 실제 주소를 입력하면 된다(코드 수정 불필요, 로컬스토리지에 저장되어 이후 자동 사용됨). 항상 같은 주소를 기본값으로 쓰고 싶다면 `sync.js`의 `DEFAULT_COUPLE_API_URL` 상수를 실제 배포 주소로 바꾸고 커밋한다.

- [ ] **Step 5: GitHub Pages 배포**

Run: `git push origin main`
Expected: GitHub Pages가 자동으로 최신 `index.html`, `sync.js`, `manifest.json` 등을 반영 (배포 완료까지 1-2분 소요될 수 있음)

- [ ] **Step 6: 실기기에서 전체 흐름 확인 (정태)**

1. 정태 폰에서 GitHub Pages URL 접속
2. 서버 주소 프롬프트에 Step 3의 Worker URL 입력
3. 정태 코드 입력
4. 거래 하나 추가
5. 브라우저 메뉴에서 "홈 화면에 추가" → 주소창 없이 열리는지 확인

- [ ] **Step 7: 실기기에서 전체 흐름 확인 (민주)**

1. 민주 폰에서 같은 URL 접속, 서버 주소 동일하게 입력, 민주 코드로 로그인
2. "정태 가계부" 탭에서 Step 6의 거래가 보이는지 확인 (읽기 전용인지도 확인)
3. 민주도 거래를 하나 추가
4. 정태 폰에서 앱을 새로고침(또는 재실행)해서 "민주 가계부" 탭에 방금 추가한 내역이 보이는지 확인

- [ ] **Step 8: 기존 백업 JSON 이전 확인 (선택, 실제 데이터가 있다면)**

정태/민주 각자 기존에 갖고 있던 `정태가계부.json` / `민주가계부.json`을 "📂 백업 불러오기"로 업로드해서 예전 내역이 그대로 들어오는지 확인한다.
