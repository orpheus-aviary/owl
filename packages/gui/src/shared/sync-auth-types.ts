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
}
