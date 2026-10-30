/**
 * @husk-ai/browser -- a real Chromium, inside the agent's computer, over CDP.
 *
 * `browseInComputer` in `@husk-ai/core` fetches HTML and strips the tags. That is
 * the right zero-dependency floor and it stays, but it cannot see a page that
 * only exists after JavaScript runs, cannot log in, and cannot click. This can.
 */

export { CdpConnection, ComputerDriverTransport, createTarget, waitResultOf, withCallSignal } from './cdp.js';
export type {
  CdpOptions,
  CdpParams,
  CdpTransport,
  ComputerTransportOptions,
  DriverRequest,
  DriverResult,
  ActionStep,
  DriverStep,
  HostCall,
  ScreencastEvent,
  ScreenFrame,
  SendStep,
  SkipIf,
  WaitResult,
  WaitStep,
} from './cdp.js';

export { DRIVER_PATH, DRIVER_SOURCE } from './driver.js';

export { Page, backendNodeIdOf, compactAxTree, describeHappened, describeWaited, flattenAxTree, happenedOf, keyDescriptor, waitExpression } from './page.js';
export type { ActionOutcome, AxNodeLike, ClickOptions, ElementTarget, GotoResult, Happened, PageAction, ScreenshotOptions, ScriptOutcome, SnapshotNode, WaitTarget, Waited } from './page.js';

export {
  CACHE_ROOT,
  DOWNLOADS_DIR,
  CHROME_FOR_TESTING_MANIFEST,
  PLAYWRIGHT_CHROMIUM_REVISION,
  downloadPlanFor,
  findInstalledChromium,
  inspectBrowserCapability,
  normaliseArch,
  parseMissingLibs,
  pickChromeForTestingAsset,
  provisionChromium,
} from './provision.js';
export type { BrowserArch, BrowserCapability, DownloadPlan, ProvisionOptions, ProvisionResult } from './provision.js';

export {
  BrowserSession,
  browserFor,
  browserSessionFor,
  closeAllBrowsers,
  closeBrowserFor,
  livePageFor,
  markUsedFor,
  warnIfDebugPortIsExposed,
} from './session.js';
export type { SessionOptions } from './session.js';
