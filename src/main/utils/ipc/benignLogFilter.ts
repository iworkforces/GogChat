import log from 'electron-log';
import { BENIGN_CSP_BLOCKED_HOSTS, getHostname } from '../security/cspHeaderHandler.js';

export function isBenignRendererConsoleMessage(message: string, sourceId: string): boolean {
  if (message.includes('Electron Security Warning (Disabled webSecurity)')) {
    return true;
  }

  if (message.includes('Deprecated API for given entry type.')) {
    return true;
  }

  if (message.includes('WARNING!') || message.includes('Using this console may allow attackers')) {
    return true;
  }

  // When we strip frame-ancestors from CSP, Chromium falls back to X-Frame-Options
  // and warns about the deprecated ALLOW-FROM directive. The header is ignored
  // (frame loads fine), so this is purely cosmetic noise.
  if (
    message.includes("Invalid 'X-Frame-Options' header encountered when loading") &&
    message.includes('is not a recognized directive')
  ) {
    return true;
  }

  if (
    message.includes(
      'allow-scripts and allow-same-origin for its sandbox attribute can escape its sandboxing'
    ) &&
    sourceId.includes('studio.workspace.google.com')
  ) {
    return true;
  }

  const cspFrameAncestorsMatch = message.match(
    /^Framing '([^']+)' violates the following (?:report-only )?Content Security Policy directive:/
  );
  if (!cspFrameAncestorsMatch) {
    return false;
  }

  const blockedUrl = cspFrameAncestorsMatch[1];
  if (!blockedUrl) {
    return false;
  }

  const blockedHostname = getHostname(blockedUrl);
  return blockedHostname !== null && BENIGN_CSP_BLOCKED_HOSTS.has(blockedHostname);
}

export function isBenignSubframeLoadFailure(
  errorCode: number,
  validatedURL: string,
  isMainFrame: boolean
): boolean {
  if (isMainFrame || errorCode !== -27) {
    return false;
  }

  const hostname = getHostname(validatedURL);
  return hostname !== null && BENIGN_CSP_BLOCKED_HOSTS.has(hostname);
}

/**
 * Check if a Node.js process warning is a benign Electron URL load failure.
 * Electron emits these via process.emitWarning() when subframes fail to load,
 * which bypasses our did-fail-load handler and goes directly to stderr.
 */
export function isBenignElectronUrlWarning(message: string): boolean {
  const match = message.match(/Failed to load URL: (.+) with error: ERR_BLOCKED_BY_RESPONSE/);
  if (!match) return false;

  const hostname = getHostname(match[1]!);
  return hostname !== null && BENIGN_CSP_BLOCKED_HOSTS.has(hostname);
}

/**
 * Suppress Electron's internal Node.js process warnings for benign subframe
 * load failures. Adding a 'warning' listener disables Node.js default stderr
 * output for ALL warnings, so non-benign warnings are re-printed manually.
 */
export function installBenignWarningFilter(): void {
  process.on('warning', (warning: Error) => {
    if (isBenignElectronUrlWarning(warning.message)) {
      log.debug('[Load] Suppressed Electron process warning');
      return;
    }
    // Non-benign warnings: re-print to stderr since adding a 'warning'
    // listener disables Node.js default stderr output for warnings
    process.stderr.write(`${warning.name}: ${warning.message}\n`);
  });
}
