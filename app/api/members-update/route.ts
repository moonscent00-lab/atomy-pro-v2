export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

type TierResult = {
  grade: number;
  points: number;
  title: string;
  thresholdPv: number;
};

function evaluateTier(ownPv: number, leftPv: number, rightPv: number): TierResult | null {
  const pair = Math.min(leftPv, rightPv);
  if (pair >= 50000000) return { grade: 1, points: 300, title: "총판", thresholdPv: 50000000 };
  if (pair >= 20000000) return { grade: 2, points: 250, title: "총판", thresholdPv: 20000000 };
  if (pair >= 6000000) return { grade: 3, points: 150, title: "총판", thresholdPv: 6000000 };
  if (pair >= 2400000) return { grade: 4, points: 90, title: "총판", thresholdPv: 2400000 };
  if (pair >= 1500000) return { grade: 5, points: 60, title: "대리점", thresholdPv: 1500000 };
  if (pair >= 700000) return { grade: 6, points: 30, title: "특약점", thresholdPv: 700000 };
  if (pair >= 300000) {
    if (ownPv >= 300000) return { grade: 7, points: 15, title: "에이전트", thresholdPv: 300000 };
    return { grade: 8, points: 5, title: "회원", thresholdPv: 300000 };
  }
  return null;
}

export async function POST(req: NextRequest) {
  try {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
    const supabase = createClient(url, serviceKey, { auth: { persistSession: false } });

    const body = await req.json();
    const member_id = Number(body.member_id);
    const name = String(body.name ?? "").trim();
    const rank = body.rank == null ? null : String(body.rank).trim();
    const drivingSideRaw = body.driving_side;
    const cumulativePvRaw = body.cumulative_pv;
    const leftLinePvRaw = body.left_line_pv;
    const rightLinePvRaw = body.right_line_pv;
    const lastPurchaseRaw = body.last_purchase_date;

    if (!member_id) return NextResponse.json({ ok: false, error: "member_id required" }, { status: 400 });
    if (!name) return NextResponse.json({ ok: false, error: "name required" }, { status: 400 });

    let cumulative_pv: number | null = null;
    if (cumulativePvRaw !== undefined && cumulativePvRaw !== null && String(cumulativePvRaw).trim() !== "") {
      const pv = Number(cumulativePvRaw);
      if (!Number.isFinite(pv) || pv < 0) {
        return NextResponse.json({ ok: false, error: "cumulative_pv must be a non-negative number" }, { status: 400 });
      }
      cumulative_pv = Math.trunc(pv);
    }

    let last_purchase_date: string | null = null;
    if (lastPurchaseRaw !== undefined && lastPurchaseRaw !== null && String(lastPurchaseRaw).trim() !== "") {
      const s = String(lastPurchaseRaw).trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
        return NextResponse.json({ ok: false, error: "last_purchase_date must be YYYY-MM-DD" }, { status: 400 });
      }
      last_purchase_date = s;
    }

    let driving_side: "L" | "R" | null = null;
    if (drivingSideRaw !== undefined && drivingSideRaw !== null && String(drivingSideRaw).trim() !== "") {
      const s = String(drivingSideRaw).trim().toUpperCase();
      if (s !== "L" && s !== "R") {
        return NextResponse.json({ ok: false, error: "driving_side must be L or R" }, { status: 400 });
      }
      driving_side = s as "L" | "R";
    }

    let left_line_pv: number | null = null;
    if (leftLinePvRaw !== undefined && leftLinePvRaw !== null && String(leftLinePvRaw).trim() !== "") {
      const v = Number(leftLinePvRaw);
      if (!Number.isFinite(v) || v < 0) {
        return NextResponse.json({ ok: false, error: "left_line_pv must be a non-negative number" }, { status: 400 });
      }
      left_line_pv = Math.trunc(v);
    }

    let right_line_pv: number | null = null;
    if (rightLinePvRaw !== undefined && rightLinePvRaw !== null && String(rightLinePvRaw).trim() !== "") {
      const v = Number(rightLinePvRaw);
      if (!Number.isFinite(v) || v < 0) {
        return NextResponse.json({ ok: false, error: "right_line_pv must be a non-negative number" }, { status: 400 });
      }
      right_line_pv = Math.trunc(v);
    }

    const ownPvForTier = Number(cumulative_pv ?? 0);
    const leftForTier = Number(left_line_pv ?? 0);
    const rightForTier = Number(right_line_pv ?? 0);
    const tier = evaluateTier(ownPvForTier, leftForTier, rightForTier);
    const shouldResetByTier = Boolean(tier);

    const payload: Record<string, string | number | null> = {
      name,
      driving_side,
      cumulative_pv,
      left_line_pv: shouldResetByTier ? 0 : left_line_pv,
      right_line_pv: shouldResetByTier ? 0 : right_line_pv,
      tier_grade: tier?.grade ?? null,
      tier_points: tier?.points ?? null,
      tier_title: tier?.title ?? null,
      last_purchase_date,
    };

    let warning: string | null = null;
    let saveError: string | null = null;
    const removed = new Set<string>();
    const colWarn: Record<string, string> = {
      driving_side: "driving_side 컬럼이 없어 방향 저장은 제외되었습니다.",
      left_line_pv: "left_line_pv 컬럼이 없어 좌 라인PV 저장은 제외되었습니다.",
      right_line_pv: "right_line_pv 컬럼이 없어 우 라인PV 저장은 제외되었습니다.",
      tier_grade: "티어 컬럼이 없어 티어 저장은 제외되었습니다.",
      tier_points: "티어 컬럼이 없어 티어 저장은 제외되었습니다.",
      tier_title: "티어 컬럼이 없어 티어 저장은 제외되었습니다.",
    };

    // 누락된 컬럼만 제거하면서 최대 8회 재시도
    for (let i = 0; i < 8; i += 1) {
      const tryPayload = { ...payload } as Record<string, string | number | null>;
      for (const key of removed) delete tryPayload[key];

      // 명목등급 우선 저장: nominal_rank 컬럼이 있으면 nominal_rank로 저장,
      // nominal_rank가 없는 구 스키마에서는 rank 컬럼으로 저장.
      if (rank || rank === "") {
        if (!removed.has("nominal_rank")) {
          tryPayload.nominal_rank = rank || null;
        } else {
          tryPayload.rank = rank || null;
        }
      }

      const { error } = await supabase.from("members").update(tryPayload).eq("member_id", member_id);
      if (!error) {
        saveError = null;
        if (removed.size > 0) {
          const msgs = Array.from(new Set(Array.from(removed).map((k) => colWarn[k]).filter(Boolean)));
          warning = msgs.join(" ");
        }
        break;
      }

      saveError = error.message;
      const m = error.message.match(/column\s+["']?([a-zA-Z0-9_]+)["']?/i);
      const missingCol = m?.[1];
      if (missingCol && Object.prototype.hasOwnProperty.call(payload, missingCol)) {
        removed.add(missingCol);
        continue;
      }
      if (missingCol === "nominal_rank") {
        removed.add("nominal_rank");
        continue;
      }
      // 컬럼 식별 못하면 기존 호환 처리
      if (error.message.includes("driving_side")) {
        removed.add("driving_side");
        continue;
      }
      if (error.message.includes("left_line_pv")) {
        removed.add("left_line_pv");
        continue;
      }
      if (error.message.includes("right_line_pv")) {
        removed.add("right_line_pv");
        continue;
      }
      if (error.message.includes("tier_")) {
        removed.add("tier_grade");
        removed.add("tier_points");
        removed.add("tier_title");
        continue;
      }
      break;
    }

    if (saveError) return NextResponse.json({ ok: false, error: saveError }, { status: 500 });

    return NextResponse.json(
      {
        ok: true,
        warning,
        tier_result: tier
          ? {
              ...tier,
              reset_applied: true,
            }
          : null,
      },
      { status: 200 }
    );
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 500 });
  }
}
