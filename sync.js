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
