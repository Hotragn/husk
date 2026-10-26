// The desktop app keeps itself current from its GitHub releases. Where the
// platform checks a new version's signature against this one's (a signed
// Windows build, a Mac app with a Developer ID), the new version downloads in
// the background and installs when the person restarts Husk from the tray.
// Elsewhere (an unsigned build, Linux), nothing is installed: the person is
// told a new version is out, with its page.

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import updater from 'electron-updater';
import { signedBuild } from './lib.mjs';

const RELEASES = 'https://github.com/Hotragn/husk/releases/latest';
/** How often a running app looks again, after once as it starts. */
const EVERY_MS = 6 * 60 * 60 * 1000;

/**
 * Start looking. `onNews` hears of a new version once per check:
 * `{ version, ready: true }` once it is downloaded and installs on restart,
 * `{ version, page }` where the person installs it themselves.
 */
export async function watchUpdates({ log, onNews }) {
  const { autoUpdater } = updater;
  const install = await isSignedBuild();
  autoUpdater.autoDownload = install;
  autoUpdater.autoInstallOnAppQuit = install;
  autoUpdater.logger = { info: (m) => log(`update: ${m}`), warn: (m) => log(`update: ${m}`), error: (m) => log(`update: ${m}`), debug: () => {} };
  autoUpdater.on('update-available', (info) => {
    if (!install) onNews({ version: info.version, page: RELEASES });
  });
  autoUpdater.on('update-downloaded', (info) => onNews({ version: info.version, ready: true }));
  autoUpdater.on('error', (err) => log(`update failed: ${err.message}`));
  const check = () => void autoUpdater.checkForUpdates().catch((err) => log(`update check failed: ${err.message}`));
  log(install ? 'updates install themselves: this build is signed' : 'updates are announced, not installed: this build is not signed, or is a Linux one');
  check();
  setInterval(check, EVERY_MS).unref();
}

/** Restart into the downloaded version: quietly, and open again after. */
export function restartToUpdate() {
  updater.autoUpdater.quitAndInstall(true, true);
}

/** Whether this build is signed the way a new version's signature is checked against it. */
export function isSignedBuild() {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      let appUpdate = '';
      try {
        appUpdate = readFileSync(join(process.resourcesPath, 'app-update.yml'), 'utf8');
      } catch {
        // not written: a build with no update source
      }
      resolve(signedBuild('win32', { appUpdate }));
      return;
    }
    if (process.platform !== 'darwin') return resolve(false);
    // The bundle, Husk.app, three levels above Contents/MacOS/Husk. codesign writes to stderr.
    execFile('codesign', ['-dv', '--verbose=2', join(process.execPath, '..', '..', '..')], (_err, _out, err) =>
      resolve(signedBuild('darwin', { codesign: String(err ?? '') })),
    );
  });
}
