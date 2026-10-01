import { useEffect } from 'react';
import { startCliBridge } from '../services/cliBridge';
import { cliHandlers } from '../services/cliHandlers';

/** Headless: answers `arbor` and its MCP server for what the window works out itself, while the window is loaded. */
export function CliBridgeMonitor() {
  useEffect(() => startCliBridge(cliHandlers), []);
  return null;
}
