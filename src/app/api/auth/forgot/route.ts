import { NextResponse } from "next/server";
import { getUser, setPassword } from "@/lib/access";
import { sendEmail } from "@/lib/email";
import { randomBytes } from "crypto";

// Forgot password: set a temporary password, email it with an easy-copy block,
// and force a change on next login (profile page opens first).
export async function POST(req: Request) {
  const { email } = await req.json().catch(() => ({}));
  const key = String(email ?? "").trim().toLowerCase();
  const user = getUser(key);

  // Do not reveal whether an account exists.
  const generic = {
    ok: true,
    message:
      "If this email has an account, a temporary password is on its way. Check your inbox.",
  };
  if (!user) return NextResponse.json(generic);

  const temp = randomBytes(4).toString("hex").toUpperCase(); // e.g. 8 chars
  await setPassword(key, temp, true);

  const result = await sendEmail({
    to: [key],
    subject: "Your WheelDeal temporary password",
    html: `
      <p>Hi! You asked to reset your WheelDeal password.</p>
      <p>Your temporary password (tap to select, then copy):</p>
      <p style="font-size:22px;font-weight:800;letter-spacing:2px;background:#f4f6f9;border:2px dashed #2f6fed;border-radius:12px;padding:14px 18px;display:inline-block;font-family:monospace">${temp}</p>
      <p>Log in with it, then <b>change your password right away</b> in the
      Profile page (it will open first automatically).</p>
      <p>If you didn't request this, you can ignore this email.</p>
    `,
  });

  if (!result.sent) {
    return NextResponse.json(
      {
        error:
          "Email sending isn't configured yet (add RESEND_API_KEY in Admin -> Keys). Ask the app owner to reset your password.",
      },
      { status: 503 }
    );
  }
  return NextResponse.json(generic);
}
