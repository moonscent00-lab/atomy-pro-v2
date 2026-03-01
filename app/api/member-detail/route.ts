export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export async function GET(req: NextRequest) {
  try {
    const idParam = req.nextUrl.searchParams.get("member_id");
    const memberId = Number(idParam);
    if (!Number.isFinite(memberId) || memberId <= 0) {
      return NextResponse.json({ ok: false, error: "유효한 member_id가 필요합니다." }, { status: 400 });
    }

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
    const supabase = createClient(url, serviceKey, { auth: { persistSession: false } });

    const candidates = [
      "member_id, name, center, rank, current_rank, nominal_rank, corporation",
      "member_id, name, center, rank, current_rank, corporation",
      "member_id, name, center, rank, nominal_rank, corporation",
      "member_id, name, center, rank, corporation",
      "member_id, name, center, rank",
      "member_id, name, rank",
      "member_id, name",
    ];
    let data: any = null;
    let lastErr: string | null = null;
    for (const cols of candidates) {
      const r = await supabase.from("members").select(cols).eq("member_id", memberId).maybeSingle();
      if (!r.error) {
        data = r.data;
        break;
      }
      lastErr = r.error.message;
    }
    if (!data && lastErr) return NextResponse.json({ ok: false, error: lastErr }, { status: 500 });
    if (!data) return NextResponse.json({ ok: false, error: "회원을 찾지 못했습니다." }, { status: 404 });

    return NextResponse.json({
      ok: true,
      item: {
        member_id: Number(data.member_id),
        name: String(data.name || ""),
        center: data.center == null ? "" : String(data.center),
        rank: String(data.current_rank || data.rank || data.nominal_rank || ""),
        corporation: data.corporation == null ? "" : String(data.corporation),
      },
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 500 });
  }
}
