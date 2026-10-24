/**
 * The desktop app's own small windows, served by Husk like the console and
 * opened by apps/desktop with the console's token: the Computers window, the
 * corner row, and the notch. None of them shows the console's chrome.
 */

import './desktop.css';
import type { DesktopView as View } from '../state/viewerToken';
import { ComputersWindow } from './ComputersWindow';
import { Dock } from './Dock';
import { Pill } from './Pill';

export function DesktopView({ view }: { view: View }) {
  if (view.view === 'dock') return <Dock />;
  if (view.view === 'pill') return <Pill />;
  return <ComputersWindow />;
}
