// Company deployments run with capture and device pairing switched off
// (MINDBASE_DISABLE_CAPTURE=1): the pairing flow issues long-lived device
// tokens outside the Authentik login, and mDNS advertising is pointless in a
// container. The inbox itself stays available because RSS feeds use it.
import type { RequestHandler } from 'express';

export interface ServerFeatures {
  capture: boolean;
}

export function isCaptureDisabled(env: NodeJS.ProcessEnv): boolean {
  const v = env['MINDBASE_DISABLE_CAPTURE']?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/** Mount in front of capture/pairing routers: 404 when capture is disabled. */
export function captureGate(env: NodeJS.ProcessEnv): RequestHandler {
  const disabled = isCaptureDisabled(env);
  return (_req, res, next) => {
    if (!disabled) { next(); return; }
    res.status(404).json({ error: 'Not found' });
  };
}

export function serverFeatures(env: NodeJS.ProcessEnv): ServerFeatures {
  return { capture: !isCaptureDisabled(env) };
}

export function shouldStartCaptureWorker(env: NodeJS.ProcessEnv): boolean {
  return !isCaptureDisabled(env);
}

export function shouldStartMdns(env: NodeJS.ProcessEnv): boolean {
  return env['MINDBASE_MDNS'] !== 'off' && !isCaptureDisabled(env);
}
