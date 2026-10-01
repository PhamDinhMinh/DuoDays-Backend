/** The authenticated caller, as established by JwtAuthGuard from the access token. */
export interface AuthContext {
  /** `usr_…` */
  userId: string;
  /** `ses_…` */
  sessionId: string;
}

export interface AuthenticatedRequest {
  auth?: AuthContext;
}
