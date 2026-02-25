export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { authCookieName, verifySessionToken } from "@/lib/auth";

type LedgerSnapshot = {
  member_id: number;
  cumulative_pv: number;
  left_line_pv: number;
  right_line_pv: number;
  tier_grade: number | null;
  tier_points: number | null;
  tier_title: string | null;
};

function isMissingTableError(error: any, table: string) {
  const msg = String(error?.message || "");
  return msg.includes(`relation "${table}" does not exist`) || msg.includes(table);
}

export async function POST(req: NextRequest) {
  try {
    const token = req.cookies.get(authCookieName())?.value;
    const session = verifySessionToken(token);
    if (!session?.member_id) {
      return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }
    const ownerMemberId = Number(session.member_id);

    const body = await req.json().catch(() => ({}));
    const mode = String(body?.mode || "last").toLowerCase(); // last | all
    const confirm = String(body?.confirm || "").toUpperCase();
    if (confirm !== "ROLLBACK") {
      return NextResponse.json({ ok: false, error: "confirm=ROLLBACK 가 필요합니다." }, { status: 400 });
    }

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
    const supabase = createClient(url, serviceKey, { auth: { persistSession: false } });

    const activeResp = await supabase
      .from("sales_batches")
      .select("batch_id, created_at")
      .eq("owner_member_id", ownerMemberId)
      .is("rolled_back_at", null)
      .order("created_at", { ascending: true });
    if (activeResp.error) {
      if (isMissingTableError(activeResp.error, "sales_batches")) {
        return NextResponse.json({ ok: false, error: "sales ledger 테이블이 없습니다. 마이그레이션 SQL을 먼저 적용해 주세요." }, { status: 400 });
      }
      return NextResponse.json({ ok: false, error: activeResp.error.message }, { status: 500 });
    }

    const active = (activeResp.data || []) as Array<{ batch_id: string; created_at: string }>;
    if (active.length === 0) {
      return NextResponse.json({ ok: true, rolledBackBatches: 0, rolledBackMembers: 0, message: "롤백할 매출 반영 이력이 없습니다." });
    }

    const target = mode === "all" ? active : [active[active.length - 1]];
    const targetIds = target.map((b) => b.batch_id);

    let rolledBackMembers = 0;
    for (const batchId of [...targetIds].reverse()) {
      const snapResp = await supabase
        .from("sales_batch_snapshots")
        .select("member_id, cumulative_pv, left_line_pv, right_line_pv, tier_grade, tier_points, tier_title")
        .eq("batch_id", batchId);
      if (snapResp.error) {
        if (isMissingTableError(snapResp.error, "sales_batch_snapshots")) {
          return NextResponse.json({ ok: false, error: "sales_batch_snapshots 테이블이 없습니다. 마이그레이션 SQL을 먼저 적용해 주세요." }, { status: 400 });
        }
        return NextResponse.json({ ok: false, error: snapResp.error.message }, { status: 500 });
      }

      const snapshots = (snapResp.data || []) as LedgerSnapshot[];
      for (const s of snapshots) {
        const basePayload: Record<string, string | number | null> = {
          cumulative_pv: Math.max(0, Math.trunc(Number(s.cumulative_pv || 0))),
          left_line_pv: Math.max(0, Math.trunc(Number(s.left_line_pv || 0))),
          right_line_pv: Math.max(0, Math.trunc(Number(s.right_line_pv || 0))),
          tier_grade: s.tier_grade == null ? null : Number(s.tier_grade),
          tier_points: s.tier_points == null ? null : Number(s.tier_points),
          tier_title: s.tier_title == null ? null : String(s.tier_title),
        };

        const attempts = [
          [],
          ["tier_grade", "tier_points", "tier_title"],
          ["tier_grade", "tier_points", "tier_title", "left_line_pv", "right_line_pv"],
        ];
        let ok = false;
        for (const drop of attempts) {
          const payload = { ...basePayload };
          for (const k of drop) delete payload[k];
          const { error } = await supabase.from("members").update(payload).eq("member_id", s.member_id);
          if (!error) {
            ok = true;
            break;
          }
        }
        if (ok) rolledBackMembers += 1;
      }
    }

    const rolledAt = new Date().toISOString();
    const upd = await supabase
      .from("sales_batches")
      .update({ rolled_back_at: rolledAt })
      .eq("owner_member_id", ownerMemberId)
      .in("batch_id", targetIds);
    if (upd.error) return NextResponse.json({ ok: false, error: upd.error.message }, { status: 500 });

    return NextResponse.json({
      ok: true,
      mode,
      rolledBackBatches: target.length,
      rolledBackMembers,
      batchIds: targetIds,
      warning: null,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 500 });
  }
}
