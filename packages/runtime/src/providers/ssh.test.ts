import { describe, expect, it } from 'vitest';
import { HuskError } from '@husk-ai/core';
import {
  JAIL_EXIT,
  SshProvider,
  buildScpArgs,
  buildSshArgs,
  diagnoseSsh,
  isStaleSocket,
  jailFor,
  parseSshTarget,
  remoteJailGuard,
  resolveSshSettings,
  scpRemote,
  sshDestination,
  toGuestRemotePath,
  toRemotePath,
} from './ssh.js';

/**
 * No remote host is involved in any of this.
 *
 * Everything that decides where bytes go -- the target, the argv, the path
 * mapping -- is pure, precisely because the alternative is finding out on
 * someone else's production box.
 */

const jail = jailFor('/home/ubuntu/.husk-work/cmp_1');

describe('parseSshTarget', () => {
  it('parses user@host', () => {
    expect(parseSshTarget('ubuntu@example.com')).toEqual({ user: 'ubuntu', host: 'example.com' });
  });

  it('parses user@host:port', () => {
    expect(parseSshTarget('ubuntu@example.com:2222')).toEqual({
      user: 'ubuntu',
      host: 'example.com',
      port: 2222,
    });
  });

  it('accepts a bare host and lets ssh pick the user', () => {
    expect(parseSshTarget('example.com')).toEqual({ host: 'example.com' });
  });

  it('trims surrounding whitespace', () => {
    expect(parseSshTarget('  ubuntu@example.com \n')).toEqual({ user: 'ubuntu', host: 'example.com' });
  });

  it('parses a bracketed IPv6 address with a port', () => {
    expect(parseSshTarget('ubuntu@[2001:db8::1]:2222')).toEqual({
      user: 'ubuntu',
      host: '2001:db8::1',
      port: 2222,
    });
  });

  it('parses a bracketed IPv6 address without a port', () => {
    expect(parseSshTarget('ubuntu@[::1]')).toEqual({ user: 'ubuntu', host: '::1' });
  });

  it('treats an unbracketed IPv6 address as an address, not host:port', () => {
    // 2001:db8::1 ends in ":1", which is exactly what a port looks like.
    expect(parseSshTarget('ubuntu@2001:db8::1')).toEqual({ user: 'ubuntu', host: '2001:db8::1' });
  });

  it('splits on the last @ so a user containing one still works', () => {
    expect(parseSshTarget('me@corp@bastion.example')).toEqual({ user: 'me@corp', host: 'bastion.example' });
  });

  it('rejects an empty target', () => {
    expect(() => parseSshTarget('   ')).toThrow(/empty ssh target/);
  });

  it('rejects a missing host', () => {
    expect(() => parseSshTarget('ubuntu@')).toThrow(/no host/);
  });

  it('rejects a non-numeric port', () => {
    expect(() => parseSshTarget('ubuntu@host:ssh')).toThrow(/invalid port/);
  });

  it('rejects an out-of-range port', () => {
    expect(() => parseSshTarget('ubuntu@host:0')).toThrow(/invalid port/);
    expect(() => parseSshTarget('ubuntu@host:70000')).toThrow(/invalid port/);
  });

  it('rejects an unclosed bracket', () => {
    expect(() => parseSshTarget('ubuntu@[::1')).toThrow(/unclosed/);
  });

  it('carries an actionable hint on every failure', () => {
    try {
      parseSshTarget('ubuntu@host:nope');
      expect.unreachable();
    } catch (e) {
      expect((e as HuskError).code).toBe('E_CONFIG');
      expect((e as HuskError).hint).toBeTruthy();
    }
  });
});

describe('destination formatting', () => {
  it('drops brackets for the ssh command line', () => {
    expect(sshDestination({ user: 'u', host: '2001:db8::1' })).toBe('u@2001:db8::1');
    expect(sshDestination({ host: 'example.com' })).toBe('example.com');
  });

  it('adds brackets for scp, where the colon means "path"', () => {
    expect(scpRemote({ user: 'u', host: '2001:db8::1' }, '/work/a')).toBe('u@[2001:db8::1]:/work/a');
    expect(scpRemote({ user: 'u', host: 'example.com' }, '/work/a')).toBe('u@example.com:/work/a');
  });
});

describe('buildSshArgs', () => {
  const target = { user: 'ubuntu', host: 'example.com' };

  it('never prompts and never hangs on the handshake', () => {
    const args = buildSshArgs({ target });
    expect(args).toContain('BatchMode=yes');
    expect(args).toContain('StrictHostKeyChecking=accept-new');
    expect(args).toContain('ConnectTimeout=10');
    expect(args).toContain('ServerAliveInterval=15');
  });

  it('shares one connection when given a control path', () => {
    const args = buildSshArgs({ target, controlPath: '/tmp/hk-abc.sock' });
    expect(args).toContain('ControlMaster=auto');
    expect(args).toContain('ControlPath=/tmp/hk-abc.sock');
    expect(args).toContain('ControlPersist=60');
  });

  it('builds the master itself with ControlMaster=yes and no persist window', () => {
    const args = buildSshArgs({ target, controlPath: '/tmp/hk-abc.sock', master: true });
    expect(args).toContain('ControlMaster=yes');
    expect(args).toContain('ControlPersist=no');
    // -N: open the connection, run nothing on it.
    expect(args).toContain('-N');
  });

  it('omits every control option when sharing is off', () => {
    const args = buildSshArgs({ target });
    expect(args.join(' ')).not.toMatch(/Control/);
  });

  it('pins the identity so a loaded agent cannot trip MaxAuthTries', () => {
    const args = buildSshArgs({ target, keyPath: '/home/me/.ssh/oracle' });
    expect(args).toContain('-i');
    expect(args[args.indexOf('-i') + 1]).toBe('/home/me/.ssh/oracle');
    expect(args).toContain('IdentitiesOnly=yes');
  });

  it('passes the port with -p', () => {
    const args = buildSshArgs({ target: { ...target, port: 2222 } });
    expect(args[args.indexOf('-p') + 1]).toBe('2222');
  });

  it('forces a pty only when asked, and forbids one otherwise', () => {
    expect(buildSshArgs({ target })).toContain('-T');
    expect(buildSshArgs({ target, tty: true })).toContain('-tt');
    expect(buildSshArgs({ target, tty: true })).not.toContain('-T');
  });

  it('puts the destination last, with the remote command after it', () => {
    const args = buildSshArgs({ target, command: 'echo hi' });
    expect(args.slice(-2)).toEqual(['ubuntu@example.com', 'echo hi']);
  });

  it('inserts extra options before the destination', () => {
    const args = buildSshArgs({ target, extra: ['-L', '127.0.0.1:5000:127.0.0.1:8000'] });
    expect(args.indexOf('-L')).toBeLessThan(args.indexOf('ubuntu@example.com'));
  });
});

describe('buildScpArgs', () => {
  const target = { user: 'ubuntu', host: 'example.com', port: 2222 };

  it('spells the port -P, unlike ssh', () => {
    const args = buildScpArgs({ target, source: 'a', dest: 'b' });
    expect(args[args.indexOf('-P') + 1]).toBe('2222');
    expect(args).not.toContain('-p');
  });

  it('reuses the control socket so a copy costs no extra handshake', () => {
    const args = buildScpArgs({ target, controlPath: '/tmp/hk-abc.sock', source: 'a', dest: 'b' });
    expect(args).toContain('ControlPath=/tmp/hk-abc.sock');
  });

  it('puts source and dest last, in that order', () => {
    const args = buildScpArgs({ target, source: 'a', dest: 'b', recursive: true });
    expect(args.slice(-3)).toEqual(['-r', 'a', 'b']);
  });
});

describe('the remote path jail', () => {
  it('maps /work and /tmp onto the computer directory', () => {
    expect(toRemotePath('/work', jail)).toBe('/home/ubuntu/.husk-work/cmp_1/work');
    expect(toRemotePath('/work/src/main.py', jail)).toBe('/home/ubuntu/.husk-work/cmp_1/work/src/main.py');
    expect(toRemotePath('/tmp/scratch', jail)).toBe('/home/ubuntu/.husk-work/cmp_1/tmp/scratch');
  });

  it('resolves a relative path against /work', () => {
    expect(toRemotePath('src/main.py', jail)).toBe('/home/ubuntu/.husk-work/cmp_1/work/src/main.py');
  });

  it('collapses . and redundant separators', () => {
    expect(toRemotePath('/work/./a//b/', jail)).toBe('/home/ubuntu/.husk-work/cmp_1/work/a/b');
  });

  it('produces POSIX paths even when husk runs on Windows', () => {
    expect(toRemotePath('/work/a/b', jail)).not.toMatch(/\\/);
  });

  it('refuses a climb out of the workspace', () => {
    expect(() => toRemotePath('/work/../../../etc/passwd', jail)).toThrow(/outside|escapes/);
  });

  it('normalises a climb into the other mount rather than refusing it', () => {
    // /work/../tmp is /tmp, which is a mount this computer really does expose.
    // The same is true on the local provider; the guest sees one namespace.
    expect(toRemotePath('/work/../tmp/x', jail)).toBe('/home/ubuntu/.husk-work/cmp_1/tmp/x');
  });

  it('refuses an absolute path outside the two mounts', () => {
    expect(() => toRemotePath('/etc/passwd', jail)).toThrow(/outside/);
    expect(() => toRemotePath('/', jail)).toThrow(/outside/);
    expect(() => toRemotePath('/home/ubuntu/.ssh/id_rsa', jail)).toThrow(/outside/);
  });

  it('is not fooled by a backslash-separated path', () => {
    // normaliseGuestPath folds \ into /, so this is /work/../../etc, not a name.
    expect(() => toRemotePath('\\work\\..\\..\\etc', jail)).toThrow(/outside|escapes/);
  });

  it('reports E_FS_DENIED with a hint naming the writable area', () => {
    try {
      toRemotePath('/etc/passwd', jail);
      expect.unreachable();
    } catch (e) {
      expect((e as HuskError).code).toBe('E_FS_DENIED');
      expect((e as HuskError).hint).toMatch(/\/work/);
    }
  });

  it('maps remote paths back to what the agent should see', () => {
    expect(toGuestRemotePath('/home/ubuntu/.husk-work/cmp_1/work/a', jail)).toBe('/work/a');
    expect(toGuestRemotePath('/home/ubuntu/.husk-work/cmp_1/tmp', jail)).toBe('/tmp');
    expect(toGuestRemotePath('/etc/passwd', jail)).toBe('/etc/passwd');
  });

  it('round-trips every guest path it accepts', () => {
    for (const p of ['/work', '/work/a/b.txt', '/tmp', '/tmp/x']) {
      expect(toGuestRemotePath(toRemotePath(p, jail), jail)).toBe(p);
    }
  });
});

describe('remoteJailGuard', () => {
  const guard = remoteJailGuard('/home/ubuntu/.husk-work/cmp_1/work/a', jail);

  it('resolves symlinks on the far end before touching anything', () => {
    expect(guard).toMatch(/readlink -f/);
  });

  it('accepts only paths under the two mounts', () => {
    expect(guard).toContain('/home/ubuntu/.husk-work/cmp_1/work/*');
    expect(guard).toContain('/home/ubuntu/.husk-work/cmp_1/tmp/*');
  });

  it('exits with a code the command itself cannot produce by accident', () => {
    expect(guard).toContain(`exit ${JAIL_EXIT}`);
    expect(JAIL_EXIT).toBe(77);
  });

  it('quotes a path containing a quote rather than ending the string', () => {
    const nasty = remoteJailGuard("/home/u/.husk-work/c/work/it's; rm -rf /", jail);
    // The whole path stays inside one single-quoted word; the embedded quote is
    // closed, escaped and reopened, so `rm -rf /` is filename text, not a command.
    expect(nasty).toContain(`__h='/home/u/.husk-work/c/work/it'\\''s; rm -rf /'; `);
  });
});

describe('resolveSshSettings', () => {
  it('is null when nothing is configured, so the provider can say so cleanly', () => {
    expect(resolveSshSettings(undefined, {})).toBeNull();
    expect(resolveSshSettings(undefined, { HUSK_SSH_TARGET: '   ' })).toBeNull();
  });

  it('reads the target and key from the environment', () => {
    expect(
      resolveSshSettings(undefined, { HUSK_SSH_TARGET: 'u@h:22', HUSK_SSH_KEY: '/k' }),
    ).toEqual({ target: { user: 'u', host: 'h', port: 22 }, keyPath: '/k' });
  });

  it('lets a husk override the environment, so one machine can drive several boxes', () => {
    const settings = resolveSshSettings(
      { labels: { 'husk.ssh': 'other@box', 'husk.ssh.key': '/other' } },
      { HUSK_SSH_TARGET: 'u@h', HUSK_SSH_KEY: '/k' },
    );
    expect(settings).toEqual({ target: { user: 'other', host: 'box' }, keyPath: '/other' });
  });
});

describe('SshProvider.isAvailable', () => {
  it('sits below docker and podman but above fly', () => {
    expect(new SshProvider().priority).toBe(16);
  });

  it('says what to set, and never throws, when no target is configured', async () => {
    const a = await new SshProvider({ env: {} }).isAvailable();
    expect(a.available).toBe(false);
    expect(a.reason).toMatch(/no remote host/);
    expect(a.hint).toMatch(/HUSK_SSH_TARGET/);
  });

  it('turns a malformed target into a hint instead of an exception', async () => {
    const a = await new SshProvider({ env: { HUSK_SSH_TARGET: 'u@h:nope' } }).isAvailable();
    expect(a.available).toBe(false);
    expect(a.reason).toMatch(/invalid port/);
    expect(a.hint).toBeTruthy();
  });
});

describe('diagnoseSsh', () => {
  const settings = { target: { user: 'ubuntu', host: 'example.com' } };

  it('tells a user to install ssh when it is not on PATH', () => {
    const d = diagnoseSsh({ code: 127, stderr: '', timedOut: false }, settings);
    expect(d.reason).toMatch(/not on PATH/);
  });

  it('blames the firewall on a timeout, not the key', () => {
    const d = diagnoseSsh({ code: 124, stderr: '', timedOut: true }, settings);
    expect(d.reason).toMatch(/did not answer/);
    expect(d.hint).toMatch(/port 22|security list/);
  });

  it('points at the configured key when auth fails', () => {
    const d = diagnoseSsh(
      { code: 255, stderr: 'ubuntu@example.com: Permission denied (publickey).', timedOut: false },
      { ...settings, keyPath: '/home/me/.ssh/oracle' },
    );
    expect(d.reason).toMatch(/refused the key/);
    expect(d.hint).toContain('/home/me/.ssh/oracle');
  });

  it('points at ssh-agent when no key was configured', () => {
    const d = diagnoseSsh({ code: 255, stderr: 'Permission denied (publickey).', timedOut: false }, settings);
    expect(d.hint).toMatch(/HUSK_SSH_KEY|ssh-agent/);
  });

  it('separates DNS failure from a refused connection', () => {
    expect(
      diagnoseSsh({ code: 255, stderr: 'ssh: Could not resolve hostname example.com', timedOut: false }, settings)
        .reason,
    ).toMatch(/cannot resolve/);
    expect(
      diagnoseSsh({ code: 255, stderr: 'connect to host port 22: Connection refused', timedOut: false }, settings)
        .reason,
    ).toMatch(/refused the connection/);
  });

  it('does not tell anyone to blindly clear known_hosts on a key change', () => {
    const d = diagnoseSsh(
      { code: 255, stderr: 'REMOTE HOST IDENTIFICATION HAS CHANGED!', timedOut: false },
      settings,
    );
    expect(d.hint).toMatch(/investigate/);
  });

  it('falls back to the first line of stderr with a way to see the rest', () => {
    const d = diagnoseSsh({ code: 255, stderr: 'kex_exchange_identification: banner', timedOut: false }, settings);
    expect(d.reason).toContain('kex_exchange_identification');
    expect(d.hint).toContain('ssh ubuntu@example.com');
  });
});

describe('isStaleSocket', () => {
  it('recognises ssh complaining about a dead multiplexing socket', () => {
    expect(isStaleSocket('Control socket connect(/tmp/hk-a.sock): Connection refused')).toBe(true);
    expect(isStaleSocket('mux_client_hello_exchange: write packet: Broken pipe')).toBe(true);
  });

  it('does not mistake a normal command failure for a stale socket', () => {
    expect(isStaleSocket('ls: cannot access /work/nope: No such file or directory')).toBe(false);
    expect(isStaleSocket('')).toBe(false);
  });
});
