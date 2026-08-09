// KIS 접근토큰 관리.
//
// KIS 토큰은 24시간짜리인데 (1) 발급할 때마다 사용자에게 알림톡이 발송되고
// (2) 1분에 1회만 발급할 수 있다. Worker는 요청마다 새로 뜨므로 토큰을 D1에
// 저장해두고 재사용하지 않으면 곧바로 알림톡 폭탄과 발급 제한에 걸린다.

const DEFAULT_BASE_URL = 'https://openapi.koreainvestment.com:9443';

// 만료 10분 전부터 갱신을 시도한다.
const RENEW_MARGIN_MS = 10 * 60 * 1000;

// 갱신 선점이 이 시간보다 오래되면 실패한 것으로 보고 다른 요청이 다시 시도한다.
const CLAIM_TTL_MS = 60 * 1000;

// 같은 isolate 안에서 동시에 들어온 요청이 각자 발급하지 않도록 묶어준다.
let inflightRenewal = null;

export function kisBaseUrl(env) {
    return String(env?.KIS_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, '');
}

export function kisCredentials(env) {
    const appKey = env?.KIS_APP_KEY;
    const appSecret = env?.KIS_APP_SECRET;
    if (!appKey || !appSecret) {
        throw new Error('KIS_APP_KEY / KIS_APP_SECRET secret이 설정되지 않았습니다.');
    }
    return { appKey, appSecret };
}

export async function getAccessToken(env, { forceRenew = false } = {}) {
    if (!forceRenew) {
        const cached = await readToken(env.DB);
        if (cached && !needsRenewal(cached.expires_at)) {
            return cached.access_token;
        }
    }

    if (inflightRenewal) return inflightRenewal;

    inflightRenewal = renewToken(env, forceRenew).finally(() => {
        inflightRenewal = null;
    });
    return inflightRenewal;
}

async function renewToken(env, forceRenew) {
    const claimed = await claimRenewal(env.DB);

    // 다른 요청이 이미 갱신 중이다. 아직 만료되지 않은 토큰이 있으면 그대로 쓰면 된다
    // (갱신 여유 10분 안에 든 토큰도 호출에는 문제가 없다). 강제 갱신일 때는 예외.
    if (!claimed && !forceRenew) {
        const current = await readToken(env.DB);
        if (current && !isExpired(current.expires_at)) {
            return current.access_token;
        }
    }

    try {
        const issued = await issueToken(env);
        await saveToken(env.DB, issued);
        return issued.accessToken;
    } catch (error) {
        await releaseClaim(env.DB);

        // 발급에 실패해도 아직 살아있는 토큰이 있으면 그걸로 버틴다.
        const fallback = await readToken(env.DB);
        if (fallback && !isExpired(fallback.expires_at)) {
            return fallback.access_token;
        }
        throw error;
    }
}

async function issueToken(env) {
    const { appKey, appSecret } = kisCredentials(env);

    const response = await fetch(`${kisBaseUrl(env)}/oauth2/tokenP`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
            grant_type: 'client_credentials',
            appkey: appKey,
            appsecret: appSecret
        })
    });

    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.access_token) {
        const detail = data?.error_description || data?.msg1 || `HTTP ${response.status}`;
        throw new Error(`KIS 토큰 발급 실패: ${String(detail).trim()}`);
    }

    // access_token_token_expired는 타임존 없는 KST 문자열이라 expires_in(초)을 쓴다.
    const lifetimeMs = (Number(data.expires_in) || 86400) * 1000;
    return {
        accessToken: data.access_token,
        expiresAt: new Date(Date.now() + lifetimeMs).toISOString()
    };
}

async function readToken(db) {
    const row = await db.prepare('SELECT access_token, expires_at FROM kis_token WHERE id = 1').first();
    if (!row || !row.access_token) return null;
    return row;
}

async function saveToken(db, { accessToken, expiresAt }) {
    await db.prepare(
        `UPDATE kis_token
         SET access_token = ?, expires_at = ?, renewing_at = NULL, updated_at = ?
         WHERE id = 1`
    ).bind(accessToken, expiresAt, new Date().toISOString()).run();
}

async function claimRenewal(db) {
    const now = new Date();
    const staleBefore = new Date(now.getTime() - CLAIM_TTL_MS).toISOString();

    const result = await db.prepare(
        `UPDATE kis_token
         SET renewing_at = ?
         WHERE id = 1 AND (renewing_at IS NULL OR renewing_at < ?)`
    ).bind(now.toISOString(), staleBefore).run();

    return result.meta.changes === 1;
}

async function releaseClaim(db) {
    await db.prepare('UPDATE kis_token SET renewing_at = NULL WHERE id = 1').run();
}

function needsRenewal(expiresAt) {
    const at = Date.parse(expiresAt);
    if (!Number.isFinite(at)) return true;
    return at - Date.now() <= RENEW_MARGIN_MS;
}

function isExpired(expiresAt) {
    const at = Date.parse(expiresAt);
    if (!Number.isFinite(at)) return true;
    return at <= Date.now();
}

// 테스트에서 isolate 단위 캐시를 초기화하기 위한 훅.
export function resetInflightRenewal() {
    inflightRenewal = null;
}
