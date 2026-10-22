/**
 * The desktop app's own small windows, served by Husk like the console and
 * opened by apps/desktop with the console's token: a computer's window, the
 * row of 3D computers, and the notch. None of them shows the console's chrome.
 */

import './desktop.css';
import type { DesktopView as View } from '../state/viewerToken';
import { ComputerWindow } from './ComputerWindow';
import { Dock } from './Dock';
import { Pill } from './Pill';

export function DesktopView({ view }: { view: View }) {
  if (view.view === 'dock') return <Dock />;
  if (view.view === 'pill') return <Pill />;
  return <ComputerWindow id={view.id} />;
}
