export interface Config {
  port: number;
  host: string;
  dataDir: string;
  /** Full origin the relay is reached at, e.g. https://relay.example.com. Used
   *  for the CSP/HSTS decisions in security-headers.ts. */
  appOrigin: string;
  /** Hostname of appOrigin (default VAPID `mailto:` subject for web push). */
  originHost: string;
  /** KLIPY API key for the relay-side GIF-search proxy; null disables GIF search */
  klipyApiKey: string | null;
  /** Per-IP request ceiling per minute for the global rate limiter. Liberal by
   *  default so normal use is never throttled; tests raise it out of the way. */
  rateLimitMax: number;
  /** v6 voice (mediasoup SFU) network settings. */
  voice: VoiceConfig;
  /** Full-AKD key-transparency sidecar (akd-sidecar). When set, the relay drives
   *  KT through it (VRF-blinded inclusion + consistency proofs); when null it
   *  falls back to the interim Merkle KT. Localhost-only; the token is the shared
   *  bearer the sidecar checks. */
  akdSidecarUrl: string | null;
  akdSidecarToken: string | null;
  /** Who may create an account on this relay (`POST /api/relay/register`):
   *  - `'public'` — open registration, anyone can create an account.
   *  - `'invite'` — closed: an existing user must mint an invite for each new
   *    account (the greenfield friend-graph bootstrap). The very first account
   *    (userCount 0) is always allowed and becomes the admin, so a fresh relay
   *    can be claimed.
   *  Defaults to `'invite'` — a relay is closed unless the operator opts it open. */
  registrationMode: 'public' | 'invite';
}

export interface VoiceConfig {
  /** IP advertised in ICE candidates — clients connect here, so it must be
   *  reachable by them: the public/LAN IP in prod, 127.0.0.1 for local dev. */
  announcedIp: string;
  /** Interface the mediasoup RTC transports bind to (0.0.0.0 = all). */
  listenIp: string;
  /** UDP/TCP port range mediasoup allocates RTC ports from (must be reachable;
   *  forward this range on a home router). */
  rtcMinPort: number;
  rtcMaxPort: number;
}

export function loadConfig(): Config {
  const port = Number(process.env.PORT ?? 3000);
  const appOrigin = (process.env.APP_ORIGIN ?? `http://localhost:${port}`).replace(/\/$/, '');
  let originHost: string;
  try {
    originHost = new URL(appOrigin).hostname;
  } catch {
    throw new Error(`APP_ORIGIN is not a valid URL: ${appOrigin}`);
  }
  return {
    port,
    host: process.env.HOST ?? '0.0.0.0',
    // `?.trim() ||`, not `??`: an *empty* DATA_DIR (a systemd unit with
    // `Environment=DATA_DIR=`, a compose file with an unset variable) would
    // otherwise resolve to the process's working directory and scatter the
    // relay's database and identity bundle wherever it happened to be started.
    dataDir: process.env.DATA_DIR?.trim() || './data',
    appOrigin,
    originHost,
    klipyApiKey: process.env.KLIPY_API_KEY?.trim() || null,
    rateLimitMax: Number(process.env.RATE_LIMIT_MAX ?? 600),
    voice: {
      announcedIp: process.env.VOICE_ANNOUNCED_IP ?? '127.0.0.1',
      listenIp: process.env.VOICE_LISTEN_IP ?? '0.0.0.0',
      rtcMinPort: Number(process.env.VOICE_RTC_MIN_PORT ?? 40000),
      rtcMaxPort: Number(process.env.VOICE_RTC_MAX_PORT ?? 40100),
    },
    akdSidecarUrl: process.env.AKD_SIDECAR_URL?.trim() || null,
    akdSidecarToken: process.env.AKD_SIDECAR_TOKEN?.trim() || null,
    // Secure default: closed to open registration. Only the exact string
    // 'public' opens it; anything else (incl. unset/typo) stays invite-only.
    registrationMode: process.env.RELAY_REGISTRATION_MODE === 'public' ? 'public' : 'invite',
  };
}
