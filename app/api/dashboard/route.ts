export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { authCookieName, verifySessionToken } from "@/lib/auth";

type MemberRow = {
  member_id: number;
  name: string | null;
  cumulative_pv?: number | null;
  left_line_pv?: number | null;
  right_line_pv?: number | null;
  last_purchase_date?: string | null;
};

const THRESHOLDS = [300000, 700000, 1500000, 2400000, 6000000, 20000000, 50000000];

function nextThreshold(left: number, right: number) {
  const base = Math.min(left, right);
  for (const t of THRESHOLDS) {
    if (base < t) return t;
  }
  return THRESHOLDS[THRESHOLDS.length - 1];
}

function pvNum(v: unknown) {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
}

function pvSigned(v: unknown) {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function ymdInSeoul(d: Date) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(d);
}

export async function GET(req: NextRequest) {
  try {
    const token = req.cookies.get(authCookieName())?.value;
    const session = verifySessionToken(token);
    if (!session) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    const ownerId = Number(session.member_id);

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
    const supabase = createClient(url, serviceKey, { auth: { persistSession: false } });

    const ownerResp = await supabase
      .from("members")
      .select("member_id, name, cumulative_pv, left_line_pv, right_line_pv, last_purchase_date")
      .eq("member_id", ownerId)
      .maybeSingle();
    if (ownerResp.error) return NextResponse.json({ ok: false, error: ownerResp.error.message }, { status: 500 });
    const owner = (ownerResp.data || null) as MemberRow | null;
    if (!owner) return NextResponse.json({ ok: false, error: "members에 본인 정보가 없습니다." }, { status: 400 });

    const today = ymdInSeoul(new Date());
    const [yearStr, monthStr, dayStr] = today.split("-");
    const day = Number(dayStr);
    const firstHalfStart = `${yearStr}-${monthStr}-01`;
    const firstHalfEnd = `${yearStr}-${monthStr}-15`;
    const secondHalfStart = `${yearStr}-${monthStr}-16`;

    const firstHalf = await supabase
      .from("pv_ledger")
      .select("delta_pv")
      .eq("member_id", ownerId)
      .in("side", ["SELF", "L", "R"])
      .gte("occurred_at", `${firstHalfStart}T00:00:00+09:00`)
      .lte("occurred_at", `${firstHalfEnd}T23:59:59+09:00`);
    const secondHalf = await supabase
      .from("pv_ledger")
      .select("delta_pv")
      .eq("member_id", ownerId)
      .in("side", ["SELF", "L", "R"])
      .gte("occurred_at", `${secondHalfStart}T00:00:00+09:00`)
      .lte("occurred_at", `${today}T23:59:59+09:00`);
    if (firstHalf.error) return NextResponse.json({ ok: false, error: firstHalf.error.message }, { status: 500 });
    if (secondHalf.error) return NextResponse.json({ ok: false, error: secondHalf.error.message }, { status: 500 });

    const firstHalfPvRaw = (firstHalf.data || []).reduce((s: number, r: any) => s + pvSigned(r.delta_pv), 0);
    const secondHalfPvRaw = (secondHalf.data || []).reduce((s: number, r: any) => s + pvSigned(r.delta_pv), 0);
    const firstHalfPv = firstHalfPvRaw;
    const secondHalfPv = day >= 16 ? secondHalfPvRaw : 0;

    const lastAllowanceResp = await supabase
      .from("allowance_events")
      .select("occurred_at")
      .eq("member_id", ownerId)
      .order("occurred_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const lastAllowanceDate = lastAllowanceResp.error ? null : (lastAllowanceResp.data?.occurred_at || null);

    const favResp = await supabase
      .from("favorites")
      .select("id, target_member_id, bucket, memo, sort_order")
      .eq("owner_member_id", ownerId)
      .order("bucket", { ascending: true })
      .order("sort_order", { ascending: true })
      .order("id", { ascending: true });
    if (favResp.error) return NextResponse.json({ ok: false, error: favResp.error.message }, { status: 500 });

    const favRows = (favResp.data || []) as Array<{
      id: number;
      target_member_id: number;
      bucket: "DAILY" | "OCCASIONAL";
      memo: string | null;
      sort_order: number | null;
    }>;
    const targetIds = [...new Set(favRows.map((r) => Number(r.target_member_id)).filter((n) => Number.isFinite(n) && n > 0))];

    let targetMembers: MemberRow[] = [];
    if (targetIds.length > 0) {
      const tResp = await supabase
        .from("members")
        .select("member_id, name, cumulative_pv, left_line_pv, right_line_pv, last_purchase_date")
        .in("member_id", targetIds);
      if (tResp.error) return NextResponse.json({ ok: false, error: tResp.error.message }, { status: 500 });
      targetMembers = (tResp.data || []) as MemberRow[];
    }
    const targetMap = new Map<number, MemberRow>();
    for (const m of targetMembers) targetMap.set(Number(m.member_id), m);

    const allowanceResp = targetIds.length
      ? await supabase
          .from("allowance_events")
          .select("member_id, occurred_at")
          .in("member_id", targetIds)
          .order("occurred_at", { ascending: false })
      : { data: [], error: null } as any;
    if (allowanceResp.error) return NextResponse.json({ ok: false, error: allowanceResp.error.message }, { status: 500 });
    const allowanceMap = new Map<number, string>();
    for (const r of allowanceResp.data || []) {
      const id = Number(r.member_id);
      if (!allowanceMap.has(id)) allowanceMap.set(id, String(r.occurred_at));
    }

    const favItems = favRows
      .map((f) => {
        const m = targetMap.get(Number(f.target_member_id));
        if (!m) return null;
        const own = pvNum(m.cumulative_pv);
        const left = pvNum(m.left_line_pv);
        const right = pvNum(m.right_line_pv);
        const target = nextThreshold(left, right);
        return {
          id: f.id,
          bucket: f.bucket,
          memo: f.memo || "",
          member_id: m.member_id,
          name: (m.name || "").trim() || "(이름없음)",
          cumulative_pv: own,
          left_line_pv: left,
          right_line_pv: right,
          last_allowance_date: allowanceMap.get(Number(m.member_id)) || null,
          target_threshold: target,
          부족: {
            left: Math.max(0, target - left),
            right: Math.max(0, target - right),
            own: Math.max(0, 300000 - own),
          },
        };
      })
      .filter(Boolean);

    return NextResponse.json({
      ok: true,
      owner: {
        member_id: owner.member_id,
        name: (owner.name || "").trim() || "(이름없음)",
        cumulative_pv: pvNum(owner.cumulative_pv),
        left_line_pv: pvNum(owner.left_line_pv),
        right_line_pv: pvNum(owner.right_line_pv),
        last_purchase_date: owner.last_purchase_date || null,
        last_allowance_date: lastAllowanceDate,
        half_month: {
          first_half_pv: firstHalfPv,
          second_half_pv: secondHalfPv,
        },
      },
      favorites: {
        daily: favItems.filter((x: any) => x.bucket === "DAILY"),
        occasional: favItems.filter((x: any) => x.bucket !== "DAILY"),
      },
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 500 });
  }
}
