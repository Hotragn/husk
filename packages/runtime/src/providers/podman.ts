import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Availability, ProviderName } from '@husk/core';
import { OciComputer, OciProvider } from './oci-common.js';

const execFileAsync = promisify(execFile);

/**
 * Podman.
 *
 * Same container CLI as Docker (see oci-common.ts), no daemon, and rootless by
 * default: containers run in a user namespace owned by the invoking user, so a
 * container escape lands on an unprivileged account rather than on root. That
 * is a better default than Docker's, which is why it is priority 18 and not 5 --
 * Docker only wins because it is the one people already have running.
 *
 * The failure mode this provider has to get right is the machine. On macOS and
 * Windows, Podman is a Linux VM plus a client, and "podman is installed" and
 * "podman can start a container" are completely different states. Telling
 * someone to install Podman when what they need is `podman machine start` is
 * the kind of unhelpful that makes people give up.
 */

export class PodmanComputer extends OciComputer {}

/** Machine states we can distinguish from `podman machine list`. */
type MachineState = 'running' | 'stopped' | 'none' | 'unknown';

export class PodmanProvider extends OciProvider {
  readonly name: ProviderName = 'podman';
  readonly description = 'Kernel-level isolation via Podman, rootless and daemonless';
  readonly priority = 18;

  constructor() {
    super({ binary: 'podman', provider: 'podman', rootless: true });
  }

  async isAvailable(): Promise<Availability> {
    // `version` answers from the client alone, so it separates "not installed"
    // from "installed but the engine cannot be reached" in one cheap call.
    let clientVersion: string;
    try {
      const { stdout } = await execFileAsync('podman', ['version', '--format', '{{.Client.Version}}'], {
        timeout: 10_000,
      });
      clientVersion = stdout.trim();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return {
          available: false,
          isolated: true,
        isolationKind: 'kernel',
          reason: 'the podman CLI is not on PATH',
          hint:
            process.platform === 'darwin'
              ? 'install it with `brew install podman`, then `podman machine init && podman machine start`'
              : process.platform === 'win32'
                ? 'install Podman Desktop or `winget install RedHat.Podman`, then `podman machine init`'
                : 'install it with your package manager (`sudo apt install podman` / `sudo dnf install podman`)',
        };
      }
      return {
        available: false,
        isolated: true,
        isolationKind: 'kernel',
        reason: `podman is installed but did not answer: ${firstLine(err)}`,
        hint: 'run `podman version` to see what it reports',
      };
    }

    try {
      const { stdout } = await execFileAsync(
        'podman',
        ['info', '--format', '{{.Version.Version}}|{{.Host.Security.Rootless}}'],
        { timeout: 15_000 },
      );
      const [engineVersion, rootless] = stdout.trim().split('|');
      const version = `podman ${engineVersion || clientVersion}${rootless === 'true' ? ' (rootless)' : ''}`;

      // Running as root is still kernel isolation, but it is not the isolation
      // this provider advertises, so it is said out loud rather than assumed.
      if (rootless === 'false') {
        return {
          available: true,
          isolated: true,
        isolationKind: 'kernel',
          version,
          reason: 'podman is running as root -- containers get kernel isolation, but an escape lands on root',
          hint: 'run husk as an unprivileged user to get rootless containers',
        };
      }
      return { available: true, isolated: true, version };
    } catch (err) {
      return { ...(await this.diagnose(err)), version: `podman ${clientVersion} (client only)` };
    }
  }

  /**
   * Work out why `podman info` failed, given that the client itself is fine.
   *
   * On macOS and Windows the answer is almost always the VM, and it has three
   * distinct states -- never created, created but stopped, running but wedged --
   * with three different fixes.
   */
  private async diagnose(err: unknown): Promise<Availability> {
    const text = errorText(err);

    if (process.platform === 'darwin' || process.platform === 'win32') {
      const state = await machineState();
      if (state === 'none') {
        return {
          available: false,
          isolated: true,
        isolationKind: 'kernel',
          reason: 'podman is installed but has no virtual machine to run containers in',
          hint: 'run `podman machine init && podman machine start`, then re-run `husk doctor`',
        };
      }
      if (state === 'stopped') {
        return {
          available: false,
          isolated: true,
        isolationKind: 'kernel',
          reason: 'the podman machine exists but is not started',
          hint: 'run `podman machine start`, then re-run `husk doctor`',
        };
      }
      return {
        available: false,
        isolated: true,
        isolationKind: 'kernel',
        reason: `the podman machine is not answering: ${firstLine(err)}`,
        hint: 'run `podman machine stop && podman machine start` to restart the VM',
      };
    }

    if (/permission denied/i.test(text)) {
      return {
        available: false,
        isolated: true,
        isolationKind: 'kernel',
        reason: 'podman could not open its runtime directory or socket',
        hint: 'check XDG_RUNTIME_DIR is set for this session, or run `loginctl enable-linger $USER`',
      };
    }
    if (/cannot connect|connection refused|no such file or directory/i.test(text)) {
      return {
        available: false,
        isolated: true,
        isolationKind: 'kernel',
        reason: 'podman is installed but its service socket is not listening',
        hint: 'run `systemctl --user start podman.socket`, then re-run `husk doctor`',
      };
    }
    if (/subuid|subgid|newuidmap|newgidmap/i.test(text)) {
      return {
        available: false,
        isolated: true,
        isolationKind: 'kernel',
        reason: 'rootless podman has no subordinate uid range for this user',
        hint: 'run `sudo usermod --add-subuids 100000-165535 --add-subgids 100000-165535 $USER`, then `podman system migrate`',
      };
    }
    return {
      available: false,
      isolated: true,
        isolationKind: 'kernel',
      reason: `podman is installed but not usable: ${firstLine(err)}`,
      hint: 'run `podman info` to see the full error',
    };
  }
}

async function machineState(): Promise<MachineState> {
  try {
    const { stdout } = await execFileAsync('podman', ['machine', 'list', '--format', '{{.Name}}\t{{.Running}}'], {
      timeout: 15_000,
    });
    const rows = stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    if (rows.length === 0) return 'none';
    // `{{.Running}}` is a bool on podman 4+, and older builds print the word in
    // a Last Up column instead; matching on the word covers both.
    return rows.some((r) => /\btrue\b/i.test(r) || /\brunning\b/i.test(r)) ? 'running' : 'stopped';
  } catch {
    return 'unknown';
  }
}

function errorText(err: unknown): string {
  const e = err as { stderr?: string; message?: string };
  return String(e.stderr ?? e.message ?? '');
}

function firstLine(err: unknown): string {
  const line = errorText(err)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .find((l) => !/^Command failed/i.test(l));
  return (line ?? 'no output').slice(0, 160);
}
