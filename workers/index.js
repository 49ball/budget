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
