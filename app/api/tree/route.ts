// app/api/tree/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { authCookieName, verifySessionToken } from "@/lib/auth";

type Edge = { parent_id: number; child_id: number; side: "L" | "R" };
type Member = {
  member_id: number;
  name: string | null;
  nominal_rank?: string | null;
  current_rank?: string | null;
  rank?: string | null;
  driving_side?: "L" | "R" | null;
  cumulative_pv?: number | null;
  last_purchase_date?: string | null;
  left_line_pv?: number | null;
  right_line_pv?: number | null;
  tier_grade?: number | null;
  tier_points?: number | null;
  tier_title?: string | null;
};

function parseDate(input?: string | null) {
  if (!input) return null;
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function monthsDiff(from: Date, to: Date) {
  return (to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24 * 30.4375);
}

function isLeavingCandidate(lastPurchaseDate?: string | null, cumulativePv?: number | null) {
  const now = new Date();
  const d = parseDate(lastPurchaseDate);
  const monthsFromLastPurchase = d ? monthsDiff(d, now) : null;
  const pv = cumulativePv == null ? null : Number(cumulativePv);
  const hasPv = pv != null && Number.isFinite(pv);

  const noPurchaseOver12 = monthsFromLastPurchase !== null && monthsFromLastPurchase >= 12;
  const pvZeroNoPurchaseOver6 = hasPv && (pv as number) <= 0 && (monthsFromLastPurchase === null || monthsFromLastPurchase >= 6);
  return noPurchaseOver12 || pvZeroNoPurchaseOver6;
}

function canReachFromRoot(byParent: Map<number, Edge[]>, startId: number, targetId: number) {
  if (startId === targetId) return true;
  const q: number[] = [startId];
  const seen = new Set<number>([startId]);
  while (q.length > 0) {
    const cur = q.shift()!;
    const kids = byParent.get(cur) || [];
    for (const k of kids) {
      const cid = Number(k.child_id);
      if (!Number.isFinite(cid) || cid <= 0) continue;
      if (cid === targetId) return true;
      if (seen.has(cid)) continue;
      seen.add(cid);
      q.push(cid);
    }
  }
  return false;
}

export async function GET(req: NextRequest) {
  try {
    const token = req.cookies.get(authCookieName())?.value;
    const session = verifySessionToken(token);
    if (!session?.member_id) {
      return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
    const supabase = createClient(url, serviceKey, { auth: { persistSession: false } });

    const { searchParams } = new URL(req.url);
    const root = Number(searchParams.get("root") || "0");
    const rawDepth = searchParams.get("depth");
    const parsedDepth = Number(rawDepth ?? "30");
    const depth = Math.min(Math.max(Number.isFinite(parsedDepth) ? parsedDepth : 30, 1), 30);

    if (!root || !Number.isFinite(root)) {
      return NextResponse.json({ ok: false, error: "root(회원번호)가 필요합니다." }, { status: 400 });
    }

    // 1) edges 전체 읽기 (네 규모면 OK)
    const { data: edges, error: e1 } = await supabase
      .from("edges")
      .select("parent_id, child_id, side");

    if (e1) return NextResponse.json({ ok: false, error: e1.message }, { status: 500 });

    const byParent = new Map<number, Edge[]>();
    for (const ed of (edges || []) as Edge[]) {
      if (!byParent.has(ed.parent_id)) byParent.set(ed.parent_id, []);
      byParent.get(ed.parent_id)!.push(ed);
    }
    // side 정렬(L 먼저)
    for (const [k, arr] of byParent.entries()) {
      arr.sort((a, b) => (a.side === b.side ? 0 : a.side === "L" ? -1 : 1));
      byParent.set(k, arr);
    }

    const ownerId = Number(session.member_id);
    if (!canReachFromRoot(byParent, ownerId, root)) {
      return NextResponse.json(
        { ok: false, error: "조회 권한이 없습니다. 본인 또는 하위 라인만 조회할 수 있습니다." },
        { status: 403 }
      );
    }

    // 2) BFS로 root 기준 depth까지 노드 id 수집
    const levels: number[][] = [];
    const visited = new Set<number>();
    let frontier: number[] = [root];
    visited.add(root);

    for (let d = 0; d <= depth; d++) {
      levels.push(frontier);
      const next: number[] = [];
      for (const pid of frontier) {
        const kids = byParent.get(pid) || [];
        for (const k of kids) {
          if (!visited.has(k.child_id)) {
            visited.add(k.child_id);
            next.push(k.child_id);
          }
        }
      }
      frontier = next;
      if (frontier.length === 0) break;
    }

    const allIds = Array.from(visited);

    // 3) members에서 이름/등급/PV/구매일/좌우PV/티어 가져오기 (컬럼 없는 DB도 폴백)
    let members: Member[] | null = null;
    let e2: { message: string } | null = null;
    {
      const resp = await supabase
        .from("members")
        .select(
          "member_id, name, nominal_rank, current_rank, rank, driving_side, cumulative_pv, last_purchase_date, left_line_pv, right_line_pv, tier_grade, tier_points, tier_title"
        )
        .in("member_id", allIds);
      members = (resp.data as Member[] | null) ?? null;
      e2 = resp.error ? { message: resp.error.message } : null;
    }
    if (e2) {
      const fallbackA = await supabase
        .from("members")
        .select("member_id, name, rank, cumulative_pv, last_purchase_date, left_line_pv, right_line_pv")
        .in("member_id", allIds);
      if (!fallbackA.error) {
        members = ((fallbackA.data ?? []) as Array<{ member_id: number; name: string | null; rank?: string | null; cumulative_pv?: number | null; last_purchase_date?: string | null; left_line_pv?: number | null; right_line_pv?: number | null }>).map((m) => ({
          ...m,
          nominal_rank: null,
          current_rank: null,
          rank: m.rank ?? null,
          driving_side: "L",
          cumulative_pv: m.cumulative_pv ?? null,
          last_purchase_date: m.last_purchase_date ?? null,
          left_line_pv: m.left_line_pv ?? 0,
          right_line_pv: m.right_line_pv ?? 0,
          tier_grade: null,
          tier_points: null,
          tier_title: null,
        }));
      } else {
        const fallbackB = await supabase
          .from("members")
          .select("member_id, name, rank, cumulative_pv, last_purchase_date")
          .in("member_id", allIds);
        if (!fallbackB.error) {
          members = ((fallbackB.data ?? []) as Array<{ member_id: number; name: string | null; rank?: string | null; cumulative_pv?: number | null; last_purchase_date?: string | null }>).map((m) => ({
            ...m,
            nominal_rank: null,
            current_rank: null,
            rank: m.rank ?? null,
            driving_side: "L",
            cumulative_pv: m.cumulative_pv ?? null,
            last_purchase_date: m.last_purchase_date ?? null,
            left_line_pv: 0,
            right_line_pv: 0,
            tier_grade: null,
            tier_points: null,
            tier_title: null,
          }));
        } else {
          const fallbackC = await supabase
            .from("members")
            .select("member_id, name")
            .in("member_id", allIds);
          if (fallbackC.error) return NextResponse.json({ ok: false, error: fallbackC.error.message }, { status: 500 });
          members = ((fallbackC.data ?? []) as Array<{ member_id: number; name: string | null }>).map((m) => ({
            ...m,
            rank: null,
            driving_side: "L",
            cumulative_pv: null,
            last_purchase_date: null,
            left_line_pv: 0,
            right_line_pv: 0,
            tier_grade: null,
            tier_points: null,
            tier_title: null,
          }));
        }
      }
      e2 = null;
    }

    const nameMap = new Map<number, string>();
    const rankMap = new Map<number, string | null>();
    const pvMap = new Map<number, number | null>();
    const leftLinePvMap = new Map<number, number>();
    const rightLinePvMap = new Map<number, number>();
    const tierGradeMap = new Map<number, number | null>();
    const tierPointsMap = new Map<number, number | null>();
    const tierTitleMap = new Map<number, string | null>();
    const purchaseDateMap = new Map<number, string | null>();
    const drivingSideMap = new Map<number, "L" | "R">();
    const leavingMap = new Map<number, boolean>();
    for (const m of (members || []) as Member[]) {
      nameMap.set(m.member_id, (m.name || "").trim() || "(이름없음)");
      const current = (m.current_rank || "").trim();
      const legacy = (m.rank || "").trim();
      const nominal = (m.nominal_rank || "").trim();
      // 트리 노드 표시/색상은 현재등급 우선
      rankMap.set(m.member_id, current || legacy || nominal || null);
      drivingSideMap.set(m.member_id, m.driving_side === "R" ? "R" : "L");
      const pv = m.cumulative_pv == null ? null : Number(m.cumulative_pv);
      pvMap.set(m.member_id, pv != null && Number.isFinite(pv) ? pv : null);
      const l = Number(m.left_line_pv ?? 0);
      const r = Number(m.right_line_pv ?? 0);
      leftLinePvMap.set(m.member_id, Number.isFinite(l) && l > 0 ? Math.trunc(l) : 0);
      rightLinePvMap.set(m.member_id, Number.isFinite(r) && r > 0 ? Math.trunc(r) : 0);
      tierGradeMap.set(m.member_id, m.tier_grade == null ? null : Number(m.tier_grade));
      tierPointsMap.set(m.member_id, m.tier_points == null ? null : Number(m.tier_points));
      tierTitleMap.set(m.member_id, m.tier_title ? String(m.tier_title) : null);
      purchaseDateMap.set(m.member_id, m.last_purchase_date || null);
      leavingMap.set(m.member_id, isLeavingCandidate(m.last_purchase_date, pv));
    }

    // 4) 트리(JSON) 만들기
    const getName = (id: number) => nameMap.get(id) || "(이름없음)";
    const getRank = (id: number) => rankMap.get(id) || null;
    const getDrivingSide = (id: number): "L" | "R" => drivingSideMap.get(id) === "R" ? "R" : "L";
    const getPv = (id: number) => pvMap.get(id) ?? 0;
    const getLastPurchaseDate = (id: number) => purchaseDateMap.get(id) || null;
    const getLeaving = (id: number) => leavingMap.get(id) ?? false;

    const getLeftLinePv = (id: number) => leftLinePvMap.get(id) ?? 0;
    const getRightLinePv = (id: number) => rightLinePvMap.get(id) ?? 0;
    const getTierGrade = (id: number) => tierGradeMap.get(id) ?? null;
    const getTierPoints = (id: number) => tierPointsMap.get(id) ?? null;
    const getTierTitle = (id: number) => tierTitleMap.get(id) ?? null;

    const build = (id: number, d: number): any => {
    const edges = byParent.get(id) || [];

    // L/R 슬롯을 고정(없으면 placeholder로 채움)
    const left = edges.find((e) => e.side === "L");
    const right = edges.find((e) => e.side === "R");

    const makeChild = (side: "L" | "R", childId?: number) => {
        if (!childId) {
        return {
            id: 0,
            name: "(비어있음)",
            side,
            placeholder: true,
            children: [],
        };
        }

        // depth 끝이어도 id/name은 내려줌
        if (d >= depth) {
        return {
          id: childId,
          name: getName(childId),
          rank: getRank(childId),
          driving_side: getDrivingSide(childId),
          cumulative_pv: getPv(childId),
          left_line_pv: getLeftLinePv(childId),
          right_line_pv: getRightLinePv(childId),
          tier_grade: getTierGrade(childId),
          tier_points: getTierPoints(childId),
          tier_title: getTierTitle(childId),
          last_purchase_date: getLastPurchaseDate(childId),
          is_leaving: getLeaving(childId),
          side,
          children: [],
        };
        }
        return { side, ...build(childId, d + 1) };
    };

    return {
        id,
        name: getName(id),
        rank: getRank(id),
        driving_side: getDrivingSide(id),
        cumulative_pv: getPv(id),
        left_line_pv: getLeftLinePv(id),
        right_line_pv: getRightLinePv(id),
        tier_grade: getTierGrade(id),
        tier_points: getTierPoints(id),
        tier_title: getTierTitle(id),
        last_purchase_date: getLastPurchaseDate(id),
        is_leaving: getLeaving(id),
        children: [makeChild("L", left?.child_id), makeChild("R", right?.child_id)],
    };
    };

    return NextResponse.json({
      ok: true,
      root,
      depth,
      tree: build(root, 0),
      stats: { edges: (edges || []).length, nodes: allIds.length },
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
