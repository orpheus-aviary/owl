/**
 * Input shape for skybridge login. Owned by `shared/` so both main
 * (`sync-auth.ts`) and renderer (`owl-api.d.ts`) reference the same
 * type without renderer reaching into main — `tsconfig.web.json`
 * include does not cover `src/main/**`, and dragging Electron / Node
 * main modules into the web type-graph would type-collapse the
 * renderer build.
 */
export interface LoginAndOpenSessionInput {
  serverUrl: string;
  email: string;
  password: string;
  /**
   * ④ web「记住我」— opt the session token into `sessionStorage` persistence so a
   * refresh rehydrates instead of forcing re-login. Web-only; the desktop main
   * process ignores it (its local session isn't browser-persisted).
   */
  remember?: boolean;
}
