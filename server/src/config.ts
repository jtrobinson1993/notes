export interface Config {
  port: number;
  host: string;
  dataDir: string;
  /** Full origin the app is served from, e.g. https://notes.example.com */
  appOrigin: string;
  /** WebAuthn relying party ID (hostname of appOrigin) */
  rpId: string;
  appName: string;
  /** Directory of the built SPA, or null to disable static serving */
  webDist: string | null;
  /** KLIPY API key for the server-side GIF-search proxy; null disables GIF search */
  klipyApiKey: string | null;
  /** Per-IP request ceiling per minute for the global rate limiter. Liberal by
   *  default so normal use is never throttled; tests raise it out of the way. */
  rateLimitMax: number;
}

export function loadConfig(): Config {
  const port = Number(process.env.PORT ?? 3000);
  const appOrigin = (process.env.APP_ORIGIN ?? `http://localhost:${port}`).replace(/\/$/, '');
  let rpId: string;
  try {
    rpId = new URL(appOrigin).hostname;
  } catch {
    throw new Error(`APP_ORIGIN is not a valid URL: ${appOrigin}`);
  }
  return {
    port,
    host: process.env.HOST ?? '0.0.0.0',
    dataDir: process.env.DATA_DIR ?? './data',
    appOrigin,
    rpId,
    appName: process.env.APP_NAME ?? 'Notes',
    webDist: process.env.WEB_DIST === 'off' ? null : (process.env.WEB_DIST ?? null),
    klipyApiKey: process.env.KLIPY_API_KEY?.trim() || null,
    rateLimitMax: Number(process.env.RATE_LIMIT_MAX ?? 600),
  };
}
