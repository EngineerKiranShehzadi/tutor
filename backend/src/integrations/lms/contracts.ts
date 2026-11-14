/**
 * Future LMS port: inert contracts only. No LMS requests, authentication,
 * grade passback, provisioning or auto-enrollment are performed by this module.
 *
 * A university adapter must use verified LTI 1.3 OIDC/JWT launches, issue/deployment
 * binding, state/nonce replay protection and short-lived platform keys from a
 * trusted registry. Do not trust browser-supplied course or user identifiers.
 */
export interface UniversityRef {
  institutionId: string;
  externalCourseId: string;
}
export interface VerifiedLmsPrincipal {
  institutionId: string;
  deploymentId: string;
  externalUserId: string;
  roles: readonly ('LEARNER'|'INSTRUCTOR'|'ADMINISTRATOR')[];
}
export interface LmsLaunchContext {
  principal: VerifiedLmsPrincipal;
  course: UniversityRef;
  resourceLinkId: string;
}
export interface LmsCourseRosterEntry {
  externalUserId: string;
  role: 'LEARNER'|'INSTRUCTOR';
}
export interface LmsToolAdapter {
  readonly adapterName: string;
  /** Must verify issuer, audience, signatures, deployment, state, nonce and expiry. */
  verifyLaunch(token:string, trustedState:string):Promise<LmsLaunchContext>;
  /** Optional and permission-scoped: no automatic enrollment without approval. */
  listCourseRoster?(course:UniversityRef):Promise<readonly LmsCourseRosterEntry[]>;
}
// Future service adapters may implement this interface after university security approval.
// Current standalone account and course flows remain the only active entry points.
