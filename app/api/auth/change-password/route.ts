export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { authCookieName, hashPassword, verifyPassword, verifySessionToken } from "@/lib/auth";

export async function POST(req: NextRequest) {
  try {
    const token = req.cookies.get(authCookieName())?.value;
    const session = verifySessionToken(token);
    if (!session) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

    const body = await req.json();
    const currentPassword = String(body?.currentPassword ?? "");
    const newPassword = String(body?.newPassword ?? "");
    if (!currentPassword || newPassword.length < 4) {
      return NextResponse.json({ ok: false, error: "비밀번호를 확인해 주세요." }, { status: 400 });
    }

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
    const supabase = createClient(url, serviceKey, { auth: { persistSession: false } });

    const uResp = await supabase.from("users").select("member_id, password_hash").eq("member_id", session.member_id).single();
    if (uResp.error) return NextResponse.json({ ok: false, error: uResp.error.message }, { status: 500 });

    const user = uResp.data as { member_id: number; password_hash: string };
    if (!verifyPassword(currentPassword, user.password_hash)) {
      return NextResponse.json({ ok: false, error: "현재 비밀번호가 맞지 않습니다." }, { status: 400 });
    }

    const password_hash = hashPassword(newPassword);
    const up = await supabase.from("users").update({ password_hash }).eq("member_id", session.member_id);
    if (up.error) return NextResponse.json({ ok: false, error: up.error.message }, { status: 500 });

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 500 });
  }
}
