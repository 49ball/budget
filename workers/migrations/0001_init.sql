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
