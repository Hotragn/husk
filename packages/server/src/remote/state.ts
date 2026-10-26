import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { chmod, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { writeAtomic } from '../store.js';
import type { StoredClaim } from './claim.js';
import type { Credential } from './webauthn.js';

/**
 * What remote access keeps on disk, in `~/.husk/remote/state.json` (a folder
 * only the user can read): the signing key, the owner's passkey, the chat apps
 * that registered, and refresh tokens by hash, never the tokens themselves.
 */
export interface RemoteState {
  /** The public URL all of it is for: the passkey's relying party and the tokens' issuer. */
  origin?: string;
  key?: { kid: string; pem: string };
  owner?: { id: string; credential: Credential; createdAt: string };
  claim?: StoredClaim;
  /** `signedIn`: when the owner let it in, until it is signed out. One never let in can make way for another. */
  clients: Record<string, { name: string; redirectUris: string[]; createdAt: string; signedIn?: string }>;
  refresh: Record<string, { family: string; clientId: string; owner: string; expiresAt: number; used: boolean }>;
  /** Families a reused refresh token ended, until their tokens would have expired: none is minted in again. */
  revoked?: Record<string, number>;
}

export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

const REFRESH_TTL_MS = 30 * 24 * 3600_000;

export class RemoteStore {
  private state: RemoteState = { clients: {}, refresh: {} };
  private keys?: { kid: string; privateKey: KeyObject; publicKey: KeyObject };

  constructor(readonly dir: string) {}

  private get file(): string {
    return join(this.dir, 'state.json');
  }

  async load(): Promise<RemoteState> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await chmod(this.dir, 0o700).catch(() => undefined);
    try {
      const read = JSON.parse(await readFile(this.file, 'utf8')) as Partial<RemoteState>;
      this.state = { ...read, clients: read.clients ?? {}, refresh: read.refresh ?? {} };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    this.keys = undefined;
    return this.state;
  }

  get current(): RemoteState {
    return this.state;
  }

  async save(): Promise<void> {
    await writeAtomic(this.file, `${JSON.stringify(this.state, null, 2)}\n`);
    await chmod(this.file, 0o600).catch(() => undefined);
  }

  /** The key access tokens are signed with, made the first time it is needed. */
  async signingKey(): Promise<{ kid: string; privateKey: KeyObject; publicKey: KeyObject }> {
    if (this.keys) return this.keys;
    if (!this.state.key) {
      const { privateKey } = generateKeyPairSync('ed25519');
      this.state.key = { kid: randomUUID(), pem: String(privateKey.export({ type: 'pkcs8', format: 'pem' })) };
      await this.save();
    }
    const privateKey = createPrivateKey(this.state.key.pem);
    this.keys = { kid: this.state.key.kid, privateKey, publicKey: createPublicKey(privateKey) };
    return this.keys;
  }

  /** Remote access off: no key, so no token it signed is good any more, no refresh token either, and no app signed in. */
  async revokeAll(): Promise<void> {
    delete this.state.key;
    this.state.refresh = {};
    for (const c of Object.values(this.state.clients)) delete c.signedIn;
    this.keys = undefined;
    await this.save();
  }

  /** One app signed out from the console: forgotten, with every token it holds. */
  async forget(clientId: string): Promise<boolean> {
    if (!Object.hasOwn(this.state.clients, clientId)) return false;
    delete this.state.clients[clientId];
    for (const [h, e] of Object.entries(this.state.refresh)) if (e.clientId === clientId) delete this.state.refresh[h];
    await this.save();
    return true;
  }

  /** `husk remote reset`: no owner, no apps, no tokens. A new claim is needed. */
  async reset(): Promise<void> {
    this.state = { clients: {}, refresh: {} };
    this.keys = undefined;
    await rm(this.file, { force: true });
  }

  /**
   * A new refresh token in `family`, for 30 days, or none when a reused token
   * ended that family. Nothing awaits in here, so a reuse found by a request
   * running at the same time cannot slip in between the check and the mint.
   * The caller saves.
   */
  mintRefresh(family: string, clientId: string, owner: string, now: number): string | undefined {
    const revoked = (this.state.revoked ??= {});
    for (const [f, until] of Object.entries(revoked)) if (now >= until) delete revoked[f];
    if (revoked[family]) return undefined;
    // Spent ones stay, to catch a copy used again, until they would have expired anyway.
    for (const [h, e] of Object.entries(this.state.refresh)) if (now >= e.expiresAt) delete this.state.refresh[h];
    const token = randomBytes(32).toString('base64url');
    this.state.refresh[hashToken(token)] = { family, clientId, owner, expiresAt: now + REFRESH_TTL_MS, used: false };
    return token;
  }

  /**
   * Spend a refresh token. One used before means it was copied: its whole
   * family is revoked, so the copy and the original both stop working, and
   * so does any token a request still in flight would mint in it.
   */
  async spendRefresh(token: string, clientId: string, now: number): Promise<{ family: string; owner: string } | undefined> {
    const hash = hashToken(token);
    const entry = this.state.refresh[hash];
    if (!entry || entry.clientId !== clientId) return undefined;
    if (entry.used || now >= entry.expiresAt) {
      const family = entry.used ? entry.family : undefined;
      if (family) (this.state.revoked ??= {})[family] = now + REFRESH_TTL_MS;
      for (const [h, e] of Object.entries(this.state.refresh)) if (h === hash || e.family === family) delete this.state.refresh[h];
      await this.save();
      return undefined;
    }
    entry.used = true;
    await this.save();
    return { family: entry.family, owner: entry.owner };
  }
}
