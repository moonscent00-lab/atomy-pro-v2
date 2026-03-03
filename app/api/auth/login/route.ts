export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { authCookieMaxAge, authCookieName, hashPassword, signSession, verifyPassword } from "@/lib/auth";

export async function POST(req: NextRequest) {
  try {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
    const supabase = createClient(url, serviceKey, { auth: { persistSession: false } });

    const body = await req.json();
    const member_id = Number(body?.member_id);
    const password = String(body?.password ?? "");
    const remember = Boolean(body?.remember);
    const action = String(body?.action || "login"); // login | setup

    if (!/^\d{8}$/.test(String(member_id))) {
      return NextResponse.json({ ok: false, error: "아이디는 8자리 숫자여야 합니다." }, { status: 400 });
    }
    if (password.length < 4) {
      return NextResponse.json({ ok: false, error: "비밀번호를 입력해 주세요." }, { status: 400 });
    }

    const uResp = await supabase.from("users").select("member_id, password_hash").eq("member_id", member_id).maybeSingle();
    if (uResp.error && !uResp.error.message.includes("users")) {
      return NextResponse.json({ ok: false, error: uResp.error.message }, { status: 500 });
    }

    const user = uResp.data as { member_id: number; password_hash: string } | null;

    if (action === "setup") {
      if (user) return NextResponse.json({ ok: false, error: "이미 비밀번호가 설정된 계정입니다." }, { status: 400 });

      const mResp = await supabase.from("members").select("member_id").eq("member_id", member_id).maybeSingle();
      if (mResp.error) return NextResponse.json({ ok: false, error: mResp.error.message }, { status: 500 });
      if (!mResp.data) {
        return NextResponse.json(
          { ok: false, code: "MEMBER_NOT_FOUND", error: "members에 없는 회원번호입니다." },
          { status: 400 }
        );
      }

      const password_hash = hashPassword(password);
      const iResp = await supabase.from("users").insert([{ member_id, password_hash }]);
      if (iResp.error) return NextResponse.json({ ok: false, error: iResp.error.message }, { status: 500 });
    } else {
      if (!user) return NextResponse.json({ ok: false, error: "계정이 없습니다. 먼저 비밀번호를 설정해 주세요." }, { status: 400 });
      if (!verifyPassword(password, user.password_hash)) {
        return NextResponse.json({ ok: false, error: "아이디 또는 비밀번호가 올바르지 않습니다." }, { status: 401 });
      }
    }

    const token = signSession(member_id, remember);
    const res = NextResponse.json({ ok: true, user: { member_id } });
    res.cookies.set(authCookieName(), token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: authCookieMaxAge(remember),
    });
    return res;
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 500 });
  }
}
