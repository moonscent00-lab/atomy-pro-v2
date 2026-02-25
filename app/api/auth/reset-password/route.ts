export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { hashPassword } from "@/lib/auth";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const member_id = Number(body?.member_id);
    const newPassword = String(body?.newPassword ?? "");
    const adminCode = String(body?.adminCode ?? "");

    if (!/^\d{8}$/.test(String(member_id))) {
      return NextResponse.json({ ok: false, error: "아이디는 8자리 숫자여야 합니다." }, { status: 400 });
    }
    if (newPassword.length < 4) {
      return NextResponse.json({ ok: false, error: "새 비밀번호는 4자 이상이어야 합니다." }, { status: 400 });
    }

    const expected = String(process.env.ADMIN_RESET_CODE || "").trim();
    if (!expected) {
      return NextResponse.json({ ok: false, error: "서버에 ADMIN_RESET_CODE 설정이 없습니다." }, { status: 500 });
    }
    if (adminCode !== expected) {
      return NextResponse.json({ ok: false, error: "관리자 확인코드가 올바르지 않습니다." }, { status: 401 });
    }

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
    const supabase = createClient(url, serviceKey, { auth: { persistSession: false } });

    const uResp = await supabase.from("users").select("member_id").eq("member_id", member_id).maybeSingle();
    if (uResp.error) return NextResponse.json({ ok: false, error: uResp.error.message }, { status: 500 });
    if (!uResp.data) return NextResponse.json({ ok: false, error: "등록된 계정이 없습니다." }, { status: 404 });

    const password_hash = hashPassword(newPassword);
    const up = await supabase.from("users").update({ password_hash }).eq("member_id", member_id);
    if (up.error) return NextResponse.json({ ok: false, error: up.error.message }, { status: 500 });

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 500 });
  }
}
