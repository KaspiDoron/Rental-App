import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Everyone must be signed in: unauthenticated visitors are sent to /login.
// This checks cookie presence at the edge; API routes verify the HMAC
// signature and role server-side, so a forged cookie gets no data.
export function middleware(req: NextRequest) {
  const hasSession = Boolean(req.cookies.get("wd_session")?.value);
  const { pathname } = req.nextUrl;

  if (!hasSession && pathname !== "/login") {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/", "/admin", "/profile", "/deals"],
};
