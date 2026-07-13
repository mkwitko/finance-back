/** Claims carried by the app access JWT (what we sign and verify). Identity only. */
export type AccessTokenClaims = {
  sub: string; // internal user uuid (public id)
  email: string;
  name: string;
};

/** The authenticated principal attached to `req.user` by the auth hook. */
export type AuthUser = {
  sub: string;
  email: string;
  name: string;
};

/** Token bundle returned by /auth/google and /auth/refresh. */
export type AuthTokens = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number; // access token TTL in seconds
};
