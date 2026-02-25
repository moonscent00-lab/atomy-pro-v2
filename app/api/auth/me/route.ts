export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { authCookieName, verifySessionToken } from "@/lib/auth";

export async function GET(req: NextRequest) {
  const token = req.cookies.get(authCookieName())?.value;
  const session = verifySessionToken(token);
  if (!session) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  return NextResponse.json({ ok: true, user: { member_id: session.member_id } });
}
