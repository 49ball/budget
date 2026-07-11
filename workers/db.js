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
