import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HuskError } from '@husk-ai/core';
import { UsageError } from './args.js';
import { renderError } from './render-error.js';
import * as ui from './ui.js';
import { EXIT_ERROR, EXIT_SIGINT, EXIT_USAGE } from './exit.js';

let out: string[];
let err: string[];

beforeEach(() => {
  out = [];
  err = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
    out.push(String(c));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => {
    err.push(String(c));
    return true;
  });
  ui.configure({ color: false });
});

afterEach(() => vi.restoreAllMocks());

const stderr = () => err.join('');
const stdout = () => out.join('');

describe('HuskError rendering', () => {
  it('prints one error line and one hint line, and nothing else', () => {
    const code = renderError(
      new HuskError('E_PROVIDER_UNAVAILABLE', 'provider "docker" is not usable', { hint: 'start Docker Desktop' }),
    );
    expect(code).toBe(EXIT_ERROR);
    expect(stderr()).toBe('error provider "docker" is not usable\nhint:  start Docker Desktop\n');
    expect(stdout()).toBe('');
  });

  it('omits the hint line when there is no hint, rather than printing an empty one', () => {
    renderError(new HuskError('E_INTERNAL', 'something broke'));
    expect(stderr()).toBe('error something broke\n');
  });

  it('never prints a stack trace by default', () => {
    renderError(new HuskError('E_EXEC_FAILED', 'boom', { hint: 'retry' }));
    expect(stderr()).not.toContain('at ');
  });

  it('prints the stack under --debug', () => {
    ui.configure({ color: false, debug: true });
    renderError(new HuskError('E_EXEC_FAILED', 'boom'));
    expect(stderr()).toContain('HuskError');
  });

  it('recognises a HuskError by shape, so one crossing a package boundary still renders', () => {
    // Duck-typed on purpose: importing @husk-ai/core into the renderer would put
    // zod on the startup path of `husk --help`.
    const foreign = Object.assign(new Error('from another realm'), {
      name: 'HuskError',
      code: 'E_QUOTA',
      hint: 'husk rm one',
    });
    expect(renderError(foreign)).toBe(EXIT_ERROR);
    expect(stderr()).toContain('hint:  husk rm one');
  });
});

describe('--json error rendering', () => {
  it('keeps stdout parseable on the failure path', () => {
    ui.configure({ color: false, json: true });
    renderError(new HuskError('E_QUOTA', 'too many computers', { hint: 'husk rm --all' }));
    const parsed = JSON.parse(stdout());
    expect(parsed.error).toMatchObject({ code: 'E_QUOTA', message: 'too many computers', hint: 'husk rm --all' });
  });

  it('still writes the human lines to stderr so an interactive user sees them', () => {
    ui.configure({ color: false, json: true });
    renderError(new HuskError('E_QUOTA', 'too many computers'));
    expect(stderr()).toContain('error too many computers');
  });
});

describe('exit-code mapping', () => {
  it('maps a usage error to 2 and points at the command help', () => {
    expect(renderError(new UsageError('missing <name>', 'exec'))).toBe(EXIT_USAGE);
    expect(stderr()).toContain('hint:  husk help exec');
  });

  it('falls back to the top-level help when the usage error names no command', () => {
    renderError(new UsageError('unknown command "psx"'));
    expect(stderr()).toContain('hint:  husk --help');
  });

  it('maps an abort to 130', () => {
    expect(renderError(Object.assign(new Error('aborted'), { name: 'AbortError' }))).toBe(EXIT_SIGINT);
    expect(renderError(new Error('aborted'))).toBe(EXIT_SIGINT);
  });

  it('maps anything else to 1', () => {
    expect(renderError(new Error('unexpected'))).toBe(EXIT_ERROR);
  });
});

describe('common node errors get a husk-shaped answer', () => {
  it('turns ENOENT into a path and a next step', () => {
    renderError(Object.assign(new Error('ENOENT'), { code: 'ENOENT', path: '/x/husk.yaml' }));
    expect(stderr()).toContain('no such file: /x/husk.yaml');
    expect(stderr()).toContain('husk init');
  });

  it('turns EADDRINUSE into the --port suggestion', () => {
    renderError(Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' }));
    expect(stderr()).toContain('--port');
  });

  it('turns a missing build into the build command', () => {
    renderError(Object.assign(new Error("Cannot find package '@husk-ai/server'"), { code: 'ERR_MODULE_NOT_FOUND' }));
    expect(stderr()).toContain('npm run build');
  });

  it('suggests --debug for anything it does not recognise', () => {
    renderError(new Error('mystery'));
    expect(stderr()).toContain('--debug');
  });
});
