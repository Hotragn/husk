import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Availability, ProviderName } from '@husk-ai/core';
import { OciComputer, OciProvider } from './oci-common.js';

const execFileAsync = promisify(execFile);

/**
 * Docker.
 *
 * Everything about driving the container -- run flags, exec, cp, ports,
 * snapshots -- lives in oci-common.ts, because Podman speaks the same CLI.
 * What is left here is the part that is genuinely about Docker: telling a user
 * why their daemon is not answering.
 */

/** Kept as a named export: it was part of the public surface before the split. */
export class DockerComputer extends OciComputer {}

export class DockerProvider extends OciProvider {
  readonly name: ProviderName = 'docker';
  readonly description = 'Kernel-level isolation via Docker';
  readonly priority = 20;

  constructor() {
    super({ binary: 'docker', provider: 'docker', rootless: false });
  }

  /**
   * "Docker is missing" and "Docker is installed but not running" are different
   * problems with different fixes, and conflating them sends people to a download
   * page they do not need.
   */
  async isAvailable(): Promise<Availability> {
    try {
      const { stdout } = await execFileAsync('docker', ['info', '--format', '{{.ServerVersion}}'], {
        timeout: 10_000,
      });
      const version = stdout.trim();
      if (version) return { available: true, version, isolated: true, isolationKind: 'kernel' };
      return {
        available: false,
        isolated: true,
        isolationKind: 'kernel',
        reason: 'docker responded without a server version',
        hint: 'run `docker info` to see what the daemon reports',
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const text = String((err as { stderr?: string }).stderr ?? (err as Error).message ?? '');

      if (code === 'ENOENT') {
        return {
          available: false,
          isolated: true,
        isolationKind: 'kernel',
          reason: 'the docker CLI is not on PATH',
          hint: 'install Docker Desktop or Docker Engine, then re-run `husk doctor`',
        };
      }
      if (/permission denied/i.test(text)) {
        return {
          available: false,
          isolated: true,
        isolationKind: 'kernel',
          reason: 'the docker socket refused this user',
          hint: 'add yourself to the docker group (`sudo usermod -aG docker $USER`), then log back in',
        };
      }
      return {
        available: false,
        isolated: true,
        isolationKind: 'kernel',
        reason: 'docker is installed but the daemon is not reachable',
        hint: 'start Docker Desktop (or `sudo systemctl start docker`), then re-run `husk doctor`',
      };
    }
  }
}
