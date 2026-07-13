import { OAuth2Client } from "google-auth-library";
import { withCause } from "../../shared/errors/app-error.js";
import { ERRORS } from "../../shared/errors/catalog.js";

export type GoogleIdentity = {
  sub: string;
  email: string;
  name: string;
  picture: string | null;
  emailVerified: boolean;
};

export interface GoogleGateway {
  /** Verify a Google ID token and return the identity, or throw AUTH-T0004. */
  verifyIdToken(idToken: string): Promise<GoogleIdentity>;
}

export function createGoogleGateway(opts: { clientIds: string[] }): GoogleGateway {
  const client = new OAuth2Client();

  return {
    async verifyIdToken(idToken) {
      try {
        const ticket = await client.verifyIdToken({ idToken, audience: opts.clientIds });
        const payload = ticket.getPayload();
        if (!payload?.sub || !payload.email) {
          throw ERRORS.AUTH.GOOGLE_VERIFICATION_FAILED();
        }
        return {
          sub: payload.sub,
          email: payload.email,
          name: payload.name ?? payload.email,
          picture: payload.picture ?? null,
          emailVerified: payload.email_verified ?? false,
        };
      } catch (err) {
        // The library throws for bad signature / wrong audience / expired token.
        throw withCause(ERRORS.AUTH.GOOGLE_VERIFICATION_FAILED(), err);
      }
    },
  };
}
