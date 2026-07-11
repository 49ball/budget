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

async function parseJsonBody(request) {
    try {
        const body = await request.json();
        return { body };
    } catch (e) {
        return { error: json({ success: false, message: '잘못된 요청 본문입니다.' }, 400) };
    }
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
            const { body, error: parseError } = await parseJsonBody(request);
            if (parseError) return parseError;
            await db.insertTransaction(env.DB, targetMemberId, body.transaction);
            return json({ success: true }, 201);
        }

        if (parts.length === 5 && parts[3] === 'transactions' && request.method === 'DELETE') {
            await db.deleteTransaction(env.DB, targetMemberId, parts[4]);
            return json({ success: true });
        }

        if (parts.length === 4 && parts[3] === 'settings' && request.method === 'PUT') {
            const { body, error: parseError } = await parseJsonBody(request);
            if (parseError) return parseError;
            await db.putSettings(env.DB, targetMemberId, body.settings);
            return json({ success: true });
        }

        if (parts.length === 4 && parts[3] === 'import' && request.method === 'POST') {
            const { body, error: parseError } = await parseJsonBody(request);
            if (parseError) return parseError;
            const importedCount = await db.importBook(env.DB, targetMemberId, body.backup);
            return json({ success: true, importedCount });
        }
    }

    return json({ success: false, message: 'Not found' }, 404);
}
