/**
 * @husk/browser -- a real Chromium, inside the agent's computer, over CDP.
 *
 * `browseInComputer` in `@husk/core` fetches HTML and strips the tags. That is
 * the right zero-dependency floor and it stays, but it cannot see a page that
 * only exists after JavaScript runs, cannot log in, and cannot click. This can.
 */

export { CdpConnection, ComputerDriverTransport, createTarget, waitResultOf } from './cdp.js';
export type {
  CdpOptions,
  CdpParams,
  CdpTransport,
  ComputerTransportOptions,
  DriverRequest,
  DriverResult,
  DriverStep,
  SendStep,
  SkipIf,
  WaitResult,
  WaitStep,
} from './cdp.js';

export { DRIVER_PATH, DRIVER_SOURCE } from './driver.js';

export { Page, backendNodeIdOf, flattenAxTree, keyDescriptor } from './page.js';
export type { AxNodeLike, GotoResult, ScreenshotOptions, SnapshotNode } from './page.js';

export {
  CACHE_ROOT,
  CHROME_FOR_TESTING_MANIFEST,
  PLAYWRIGHT_CHROMIUM_REVISION,
  downloadPlanFor,
  findInstalledChromium,
  normaliseArch,
  parseMissingLibs,
  pickChromeForTestingAsset,
  provisionChromium,
} from './provision.js';
export type { BrowserArch, DownloadPlan, ProvisionOptions, ProvisionResult } from './provision.js';

export {
  BrowserSession,
  browserFor,
  closeAllBrowsers,
  closeBrowserFor,
  warnIfDebugPortIsExposed,
} from './session.js';
export type { SessionOptions } from './session.js';
