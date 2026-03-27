export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { authCookieMaxAge, authCookieName, signSession, verifyPassword } from "@/lib/auth";

function redirectWithMessage(req: NextRequest, kind: "ok" | "err", message: string) {
  const url = new URL("/", req.nextUrl.origin);
  url.searchParams.set(kind === "ok" ? "auth_ok" : "auth_error", message);
  return NextResponse.redirect(url);
}

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const member_id = Number(form.get("member_id") || 0);
    const password = String(form.get("password") || "");
    const remember = String(form.get("remember") || "") === "1";

    if (!/^\d{8}$/.test(String(member_id))) {
      return redirectWithMessage(req, "err", "아이디는 8자리 숫자여야 합니다.");
    }
    if (!password.trim()) {
      return redirectWithMessage(req, "err", "비밀번호를 입력해 주세요.");
    }

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
    const supabase = createClient(url, serviceKey, { auth: { persistSession: false } });

    const uResp = await supabase.from("users").select("member_id, password_hash").eq("member_id", member_id).maybeSingle();
    if (uResp.error && !uResp.error.message.includes("users")) {
      return redirectWithMessage(req, "err", uResp.error.message);
    }

    const user = uResp.data as { member_id: number; password_hash: string } | null;
    if (!user) {
      return redirectWithMessage(req, "err", "계정이 없습니다. 먼저 비밀번호를 설정해 주세요.");
    }
    if (!verifyPassword(password, user.password_hash)) {
      return redirectWithMessage(req, "err", "아이디 또는 비밀번호가 올바르지 않습니다.");
    }

    const token = signSession(member_id, remember);
    const res = redirectWithMessage(req, "ok", "로그인 완료");
    const maxAge = authCookieMaxAge(remember);
    res.cookies.set(authCookieName(), token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge,
      expires: new Date(Date.now() + maxAge * 1000),
    });
    return res;
  } catch (e: any) {
    return redirectWithMessage(req, "err", e?.message ?? String(e));
  }
}
