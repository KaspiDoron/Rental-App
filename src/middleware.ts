import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Signed-out visitors hitting the app root meet the public landing page
// (/welcome - outside the matcher, so it can never loop); any other gated
// path goes to /login. This checks cookie presence at the edge; API routes
// verify the HMAC signature and role server-side, so a forged cookie gets
// no data.
export function middleware(req: NextRequest) {
  const hasSession = Boolean(req.cookies.get("wd_session")?.value);
  const { pathname } = req.nextUrl;

  if (!hasSession && pathname !== "/login") {
    const url = req.nextUrl.clone();
    url.pathname = pathname === "/" ? "/welcome" : "/login";
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/", "/admin", "/profile", "/deals"],
};
