// A thin client-only wrapper around the Railyard Insights tag (`s.js`, loaded
// sitewide from app/layout.tsx with `ry_site_scribase_mail_7e3c28c34586`) so a
// real step-level funnel can be computed for new-customer signup -> Pro/Scale
// checkout the same way bidstage-tenders' web/track.ts already does for its own
// sign-in funnel. `window.railyard` may not exist yet -- the script is
// `defer`red, an ad blocker can drop it, or this can run during SSR -- so this
// never throws and never delays the real UI action it is attached to.
declare global {
  interface Window {
    railyard?: { track: (name: string, data?: Record<string, unknown>) => void };
  }
}

export function track(name: string, data?: Record<string, unknown>): void {
  try {
    window.railyard?.track(name, data);
  } catch {
    // Analytics must never break the real flow.
  }
}
