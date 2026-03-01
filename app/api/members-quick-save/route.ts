export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

type Body = {
  member_id?: number | string;
  name?: string;
  center?: string;
  sponsor_id?: number | string;
  side?: "L" | "R" | "" | null;
  corporation?: string;
  mode?: "create" | "update";
};

export async function POST(req: NextRequest) {
  try {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
    const supabase = createClient(url, serviceKey, { auth: { persistSession: false } });

    const body = (await req.json()) as Body;
    const mode = body.mode === "create" ? "create" : "update";
    const memberId = Number(body.member_id);
    const sponsorId = body.sponsor_id == null || String(body.sponsor_id).trim() === "" ? null : Number(body.sponsor_id);
    const name = String(body.name ?? "").trim();
    const center = String(body.center ?? "").trim();
    const corporation = String(body.corporation ?? "").trim() || "본사";
    const sideRaw = String(body.side ?? "").trim().toUpperCase();

    if (!Number.isFinite(memberId) || memberId <= 0) {
      return NextResponse.json({ ok: false, error: "유효한 회원번호가 필요합니다." }, { status: 400 });
    }
    if (!name) {
      return NextResponse.json({ ok: false, error: "이름은 필수입니다." }, { status: 400 });
    }
    if (sponsorId != null && (!Number.isFinite(sponsorId) || sponsorId <= 0)) {
      return NextResponse.json({ ok: false, error: "유효한 스폰서 번호가 필요합니다." }, { status: 400 });
    }
    if (sideRaw && sideRaw !== "L" && sideRaw !== "R") {
      return NextResponse.json({ ok: false, error: "side는 L 또는 R만 가능합니다." }, { status: 400 });
    }

    const { data: existingMember, error: existingErr } = await supabase
      .from("members")
      .select("member_id")
      .eq("member_id", memberId)
      .maybeSingle();
    if (existingErr) return NextResponse.json({ ok: false, error: existingErr.message }, { status: 500 });

    if (mode === "create" && existingMember?.member_id) {
      return NextResponse.json({ ok: false, error: "이미 등록된 회원번호입니다." }, { status: 400 });
    }

    const isCreate = !existingMember?.member_id;
    const basePayload: Record<string, any> = {
      member_id: memberId,
      name,
      center: center || "센터",
      rank: "회원",
      current_rank: "회원",
      nominal_rank: "회원",
      corporation,
    };

    if (isCreate) {
      basePayload.cumulative_pv = 0;
      basePayload.last_purchase_date = null;
      basePayload.left_line_pv = 0;
      basePayload.right_line_pv = 0;
    }

    const removed = new Set<string>();
    let saveErr: string | null = null;
    for (let i = 0; i < 10; i += 1) {
      const payload = { ...basePayload } as Record<string, any>;
      for (const k of removed) delete payload[k];

      const r = await supabase.from("members").upsert([payload], { onConflict: "member_id" });
      if (!r.error) {
        saveErr = null;
        break;
      }
      saveErr = r.error.message;
      const m = r.error.message.match(/column\s+["']?([a-zA-Z0-9_]+)["']?/i);
      const missing = m?.[1];
      if (missing && Object.prototype.hasOwnProperty.call(payload, missing)) {
        removed.add(missing);
        continue;
      }
      if (saveErr.includes("current_rank")) {
        removed.add("current_rank");
        continue;
      }
      if (saveErr.includes("nominal_rank")) {
        removed.add("nominal_rank");
        continue;
      }
      if (saveErr.includes("left_line_pv")) {
        removed.add("left_line_pv");
        continue;
      }
      if (saveErr.includes("right_line_pv")) {
        removed.add("right_line_pv");
        continue;
      }
      if (saveErr.includes("corporation")) {
        removed.add("corporation");
        continue;
      }
      if (saveErr.includes("center")) {
        removed.add("center");
        continue;
      }
      break;
    }
    if (saveErr) return NextResponse.json({ ok: false, error: saveErr }, { status: 500 });

    let usedSide: "L" | "R" | null = null;
    if (sponsorId != null) {
      const { data: sponsor, error: sponsorErr } = await supabase
        .from("members")
        .select("member_id")
        .eq("member_id", sponsorId)
        .maybeSingle();
      if (sponsorErr) return NextResponse.json({ ok: false, error: sponsorErr.message }, { status: 500 });
      if (!sponsor?.member_id) {
        return NextResponse.json({ ok: false, error: "스폰서가 members에 없습니다." }, { status: 400 });
      }

      if (sideRaw === "L" || sideRaw === "R") {
        usedSide = sideRaw as "L" | "R";
      } else {
        const { data: edgeRows, error: edgeErr } = await supabase.from("edges").select("side").eq("parent_id", sponsorId);
        if (edgeErr) return NextResponse.json({ ok: false, error: edgeErr.message }, { status: 500 });
        const hasL = (edgeRows || []).some((e: any) => String(e.side).toUpperCase() === "L");
        const hasR = (edgeRows || []).some((e: any) => String(e.side).toUpperCase() === "R");
        if (!hasL) usedSide = "L";
        else if (!hasR) usedSide = "R";
        else {
          return NextResponse.json(
            { ok: false, error: "스폰서 좌/우가 모두 사용 중입니다. 연결 탭에서 직접 L/R 지정 연결해 주세요." },
            { status: 400 }
          );
        }
      }

      const linkResp = await supabase.from("edges").upsert([{ parent_id: sponsorId, child_id: memberId, side: usedSide }], { onConflict: "child_id" });
      if (linkResp.error) return NextResponse.json({ ok: false, error: linkResp.error.message }, { status: 500 });
    }

    return NextResponse.json({
      ok: true,
      created: isCreate,
      linked: sponsorId != null,
      side: usedSide,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 500 });
  }
}
