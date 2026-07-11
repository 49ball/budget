import { describe, it, expect } from 'vitest';

describe('vitest-pool-workers 동작 확인', () => {
    it('워커 풀 안에서 테스트가 실행된다', () => {
        expect(1 + 1).toBe(2);
    });
});
