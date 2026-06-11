import {
  startAuthentication,
  startRegistration,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/browser';
import { PRF_EVAL_INPUT } from '@notes/shared';

const PRF_INPUT = new TextEncoder().encode(PRF_EVAL_INPUT);

/** Inject the PRF eval input. simplewebauthn passes `extensions` through to
 * the browser untouched, so BufferSource values are fine here even though the
 * JSON types disagree. */
function withPrf<T extends object>(options: T): T {
  return {
    ...options,
    extensions: {
      ...(options as { extensions?: object }).extensions,
      prf: { eval: { first: PRF_INPUT } },
    },
  } as T;
}

function extractPrf(response: RegistrationResponseJSON | AuthenticationResponseJSON): Uint8Array | null {
  const ext = response.clientExtensionResults as {
    prf?: { enabled?: boolean; results?: { first?: ArrayBuffer | Uint8Array } };
  };
  const first = ext.prf?.results?.first;
  // PRF results contain ArrayBuffers that won't survive JSON serialization;
  // replace with a JSON-safe marker before the response is sent to the server.
  if (ext.prf) ext.prf = { enabled: first !== undefined || ext.prf.enabled === true };
  if (!first) return null;
  return first instanceof Uint8Array ? first : new Uint8Array(first);
}

export interface PasskeyResult<T> {
  response: T;
  prf: Uint8Array | null;
}

export async function registerPasskey(
  optionsJSON: Record<string, unknown>,
): Promise<PasskeyResult<RegistrationResponseJSON>> {
  const response = await startRegistration({
    optionsJSON: withPrf(optionsJSON) as unknown as PublicKeyCredentialCreationOptionsJSON,
  });
  return { response, prf: extractPrf(response) };
}

export async function authenticatePasskey(
  optionsJSON: Record<string, unknown>,
): Promise<PasskeyResult<AuthenticationResponseJSON>> {
  const response = await startAuthentication({
    optionsJSON: withPrf(optionsJSON) as unknown as PublicKeyCredentialRequestOptionsJSON,
  });
  return { response, prf: extractPrf(response) };
}
