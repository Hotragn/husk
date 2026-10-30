import { describe, expect, it } from 'vitest';
import { listenOn } from './serve.js';

describe('husk serve: where it listens', () => {
  it('takes the flags, then HUSK_HOST and HUSK_PORT, then the defaults', () => {
    const env = { HUSK_HOST: '0.0.0.0', HUSK_PORT: '8080' };
    expect(listenOn({}, env)).toEqual({ host: '0.0.0.0', port: 8080 });
    expect(listenOn({ host: '127.0.0.1', port: '9000' }, env)).toEqual({ host: '127.0.0.1', port: 9000 });
    expect(listenOn({}, {})).toEqual({ host: '127.0.0.1', port: 7377 });
    expect(() => listenOn({}, { HUSK_PORT: 'abc' })).toThrow(/HUSK_PORT expects a positive number/);
  });
});
