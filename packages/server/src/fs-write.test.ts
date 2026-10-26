import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp } from './testing.js';
import type { TestApp } from './testing.js';

let harness: TestApp | undefined;
afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

describe('PUT /v1/computers/:id/fs/write', () => {
  it('writes the body as sent, whatever its content type', async () => {
    harness = await buildTestApp();
    const id = (await harness.app.inject({ method: 'POST', url: '/v1/computers', payload: {} })).json().id as string;
    const put = (path: string, type: string, payload: string) =>
      harness!.app.inject({ method: 'PUT', url: `/v1/computers/${id}/fs/write?path=${path}`, headers: { 'content-type': type }, payload });
    const read = async (path: string) => (await harness!.app.inject({ method: 'GET', url: `/v1/computers/${id}/fs/read?path=${path}` })).body;

    const json = '{ "b": 2,\n  "a": [1, "x"] }';
    expect((await put('/work/a.json', 'application/json', json)).statusCode).toBe(204);
    expect(await read('/work/a.json')).toBe(json);
    expect((await put('/work/a.txt', 'text/plain', 'plain text')).statusCode).toBe(204);
    expect(await read('/work/a.txt')).toBe('plain text');
    expect((await put('/work/a.bin', 'application/octet-stream', 'bytes')).statusCode).toBe(204);
    expect(await read('/work/a.bin')).toBe('bytes');
  });
});
