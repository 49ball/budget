self.addEventListener('install', () => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', () => {
    // 오프라인 캐싱은 하지 않는다. 이 리스너는 PWA 설치 가능 조건을 충족시키기 위한 용도다.
});
