export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { authCookieName, verifySessionToken } from "@/lib/auth";

type Edge = { parent_id: number; child_id: number; side: "L" | "R" };

type MemberRow = {
  member_id: number;
  cumulative_pv?: number | null;
  left_line_pv?: number | null;
  right_line_pv?: number | null;
  tier_grade?: number | null;
  tier_points?: number | null;
  tier_title?: string | null;
};

type TierResult = {
  grade: number;
  points: number;
  title: string;
  thresholdPv: number;
};

type LedgerSnapshot = {
  member_id: number;
  cumulative_pv: number;
  left_line_pv: number;
  right_line_pv: number;
  tier_grade: number | null;
  tier_points: number | null;
  tier_title: string | null;
};

type SalesBatch = {
  batch_id: string;
  owner_member_id: number;
  created_at: string;
  fingerprint: string;
  entries: Array<{ member_id: number; pv: number }>;
  snapshots_before: LedgerSnapshot[];
  rolled_back_at?: string | null;
};

type SalesEvent = {
  member_id: number;
  pv: number;
  sale_date: string; // YYYY-MM-DD (KST)
  row_index: number;
};

function isMissingTableError(error: any, table: string) {
  const msg = String(error?.message || "");
  return msg.includes(`relation "${table}" does not exist`) || msg.includes(`${table}`);
}

function salesFingerprint(events: SalesEvent[]) {
  const normalized = [...events]
    .sort((a, b) => {
      if (a.sale_date !== b.sale_date) return a.sale_date.localeCompare(b.sale_date);
      if (a.member_id !== b.member_id) return a.member_id - b.member_id;
      if (a.pv !== b.pv) return a.pv - b.pv;
      return a.row_index - b.row_index;
    })
    .map((e) => `${e.sale_date}:${e.member_id}:${e.pv}`)
    .join("|");
  return createHash("sha256").update(normalized).digest("hex");
}

function todayKstYmd() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

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

function parseSalesText(text: string) {
  const out: SalesEvent[] = [];
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  const fallbackDate = todayKstYmd();
  const DATE_RE = /\b20\d{2}-\d{2}-\d{2}\b/;

  // Case 1) one-line format: "29527956|1000", "29527956 1000", "이지아 29527956 1,000"
  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx];
    if (line.startsWith("//")) continue;
    const nums = [...line.matchAll(/\d[\d,]*/g)].map((m) => m[0].replace(/,/g, ""));
    const signed = [...line.matchAll(/-?\d[\d,]*/g)].map((m) => m[0].replace(/,/g, ""));
    if (nums.length >= 2 && signed.length >= 1) {
      const member_id = Number(nums.find((n) => n.length >= 7 && n.length <= 9) || 0);
      const pv = Number(signed[signed.length - 1] || 0);
      if (Number.isFinite(member_id) && member_id > 0 && Number.isFinite(pv) && pv !== 0) {
        const date = line.match(DATE_RE)?.[0] || fallbackDate;
        out.push({ member_id, pv: Math.trunc(pv), sale_date: date, row_index: idx });
        continue;
      }
    }
  }

  // Case 2) block format copied from 하위매출 page.
  for (let i = 0; i < lines.length; i += 1) {
    const idLine = lines[i];
    if (!/^\d{7,9}$/.test(idLine)) continue;
    const member_id = Number(idLine);
    if (!Number.isFinite(member_id) || member_id <= 0) continue;

    let foundPv: number | null = null;
    for (let j = i + 1; j < Math.min(i + 8, lines.length); j += 1) {
      const s = lines[j].replace(/\s/g, "");
      if (!/^-?\d[\d,]*$/.test(s)) continue;
      const raw = s.replace(/,/g, "");
      if (/^-?\d{11,20}$/.test(raw)) continue; // order number
      const v = Number(raw);
      if (!Number.isFinite(v) || v === 0) continue;
      if (Math.abs(v) > 100000000) continue;
      foundPv = Math.trunc(v);
      break;
    }
    if (foundPv !== null) {
      let date = fallbackDate;
      for (let j = Math.max(0, i - 8); j <= Math.min(i + 2, lines.length - 1); j += 1) {
        const d = lines[j].match(DATE_RE)?.[0];
        if (d) date = d;
      }
      out.push({ member_id, pv: foundPv, sale_date: date, row_index: i });
    }
  }

  return out;
}

function ymdFromIsoOrDate(raw: string | null | undefined) {
  if (!raw) return null;
  const s = String(raw);
  const m = s.match(/\b20\d{2}-\d{2}-\d{2}\b/);
  return m?.[0] || null;
}

function kstIsoAt(dateYmd: string, hhmmss: string) {
  return `${dateYmd}T${hhmmss}+09:00`;
}

export async function POST(req: NextRequest) {
  try {
    const token = req.cookies.get(authCookieName())?.value;
    const session = verifySessionToken(token);
    if (!session?.member_id) {
      return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }
    const ownerMemberId = Number(session.member_id);

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
    const supabase = createClient(url, serviceKey, { auth: { persistSession: false } });

    const body = await req.json();
    const salesText = String(body?.text ?? "");
    const salesEvents = parseSalesText(salesText)
      .filter((e) => Number.isFinite(e.member_id) && e.member_id > 0 && Number.isFinite(e.pv) && e.pv !== 0)
      .sort((a, b) => (a.sale_date === b.sale_date ? a.row_index - b.row_index : a.sale_date.localeCompare(b.sale_date)));

    if (salesEvents.length === 0) {
      return NextResponse.json({ ok: false, error: "유효한 매출 데이터가 없습니다. (회원번호 + PV)" }, { status: 400 });
    }

    const warnings: string[] = [];
    const fingerprint = salesFingerprint(salesEvents);
    {
      const dup = await supabase
        .from("sales_batches")
        .select("batch_id")
        .eq("owner_member_id", ownerMemberId)
        .eq("fingerprint", fingerprint)
        .is("rolled_back_at", null)
        .maybeSingle();
      if (dup.error) {
        if (isMissingTableError(dup.error, "sales_batches")) {
          warnings.push("sales ledger 테이블이 없어 중복 방지/롤백 이력 저장이 비활성화됩니다.");
        } else {
          return NextResponse.json({ ok: false, error: dup.error.message }, { status: 500 });
        }
      } else if (dup.data?.batch_id) {
        return NextResponse.json({
          ok: true,
          duplicated: true,
          skipped: true,
          reason: "같은 매출 묶음이 이미 반영되어 중복 적용을 건너뛰었습니다.",
          batch_id: dup.data.batch_id,
        });
      }
    }

    const { data: edges, error: edgeErr } = await supabase.from("edges").select("parent_id, child_id, side");
    if (edgeErr) return NextResponse.json({ ok: false, error: edgeErr.message }, { status: 500 });

    const parentByChild = new Map<number, { parent_id: number; side: "L" | "R" }>();
    for (const e of (edges || []) as Edge[]) {
      parentByChild.set(e.child_id, { parent_id: e.parent_id, side: e.side === "R" ? "R" : "L" });
    }

    const impacted = new Set<number>();
    for (const ev of salesEvents) {
      impacted.add(ev.member_id);
      let cur = ev.member_id;
      let guard = 0;
      while (parentByChild.has(cur) && guard < 2000) {
        const up = parentByChild.get(cur)!;
        impacted.add(up.parent_id);
        cur = up.parent_id;
        guard += 1;
      }
    }
    const impactedIds = Array.from(impacted);

    let rows: MemberRow[] = [];
    {
      const r1 = await supabase
        .from("members")
        .select("member_id, cumulative_pv, left_line_pv, right_line_pv, tier_grade, tier_points, tier_title")
        .in("member_id", impactedIds);
      if (!r1.error) rows = (r1.data || []) as MemberRow[];
      else {
        const r2 = await supabase.from("members").select("member_id, cumulative_pv, left_line_pv, right_line_pv").in("member_id", impactedIds);
        if (!r2.error) rows = (r2.data || []) as MemberRow[];
        else {
          const r3 = await supabase.from("members").select("member_id, cumulative_pv").in("member_id", impactedIds);
          if (r3.error) return NextResponse.json({ ok: false, error: r3.error.message }, { status: 500 });
          rows = (r3.data || []) as MemberRow[];
        }
      }
    }

    const memberMap = new Map<number, MemberRow>();
    for (const r of rows) {
      memberMap.set(r.member_id, {
        member_id: r.member_id,
        cumulative_pv: Number(r.cumulative_pv ?? 0) || 0,
        left_line_pv: Number(r.left_line_pv ?? 0) || 0,
        right_line_pv: Number(r.right_line_pv ?? 0) || 0,
        tier_grade: r.tier_grade ?? null,
        tier_points: r.tier_points ?? null,
        tier_title: r.tier_title ?? null,
      });
    }

    const latestTierDateByMember = new Map<number, string>();
    const latestResetDateByMember = new Map<number, string>();
    {
      const ev = await supabase
        .from("allowance_events")
        .select("member_id, event_type, occurred_at")
        .in("event_type", ["MATCHING_TIER", "MATCHING_RESET"])
        .in("member_id", impactedIds);
      if (ev.error) {
        if (isMissingTableError(ev.error, "allowance_events")) {
          warnings.push("allowance_events 테이블이 없어 지연 초기화 기준일 로딩을 건너뜁니다.");
        } else {
          warnings.push(`allowance_events 조회 실패: ${ev.error.message}`);
        }
      } else {
        for (const row of ev.data || []) {
          const id = Number((row as any).member_id);
          const ymd = ymdFromIsoOrDate((row as any).occurred_at);
          if (!Number.isFinite(id) || !ymd) continue;
          const eventType = String((row as any).event_type || "");
          if (eventType === "MATCHING_TIER") {
            const prev = latestTierDateByMember.get(id);
            if (!prev || ymd > prev) latestTierDateByMember.set(id, ymd);
          } else if (eventType === "MATCHING_RESET") {
            const prev = latestResetDateByMember.get(id);
            if (!prev || ymd > prev) latestResetDateByMember.set(id, ymd);
          }
        }
      }
    }

    const pendingResetDateByMember = new Map<number, string>();
    for (const [id, tierDate] of latestTierDateByMember.entries()) {
      const resetDate = latestResetDateByMember.get(id);
      if (!resetDate || tierDate > resetDate) {
        pendingResetDateByMember.set(id, tierDate);
      }
    }
    const touched = new Set<number>();
    const missingMemberIds: number[] = [];
    const beforeMap = new Map<number, LedgerSnapshot>();
    const ledgerDelta = new Map<string, number>(); // key: date|member|side
    const trace: Array<{
      member_id: number;
      add_pv: number;
      own_updated: boolean;
      sale_date: string;
      chain: Array<{ parent_id: number; side: "L" | "R" }>;
    }> = [];

    const ensureBefore = (id: number, row: MemberRow) => {
      if (beforeMap.has(id)) return;
      beforeMap.set(id, {
        member_id: id,
        cumulative_pv: Number(row.cumulative_pv ?? 0) || 0,
        left_line_pv: Number(row.left_line_pv ?? 0) || 0,
        right_line_pv: Number(row.right_line_pv ?? 0) || 0,
        tier_grade: row.tier_grade == null ? null : Number(row.tier_grade),
        tier_points: row.tier_points == null ? null : Number(row.tier_points),
        tier_title: row.tier_title == null ? null : String(row.tier_title),
      });
    };

    const maybeApplyDeferredReset = (id: number, row: MemberRow, saleDate: string) => {
      const pendingDate = pendingResetDateByMember.get(id);
      if (!pendingDate) return;
      if (saleDate > pendingDate) {
        ensureBefore(id, row);
        row.left_line_pv = 0;
        row.right_line_pv = 0;
        touched.add(id);
        resetAppliedMap.set(id, saleDate);
        pendingResetDateByMember.delete(id);
      }
    };

    const tierAchievedMap = new Map<number, TierResult & { sale_date: string }>();
    const resetAppliedMap = new Map<number, string>();
    const recordTierAchieved = (id: number, tier: TierResult, saleDate: string) => {
      const prev = tierAchievedMap.get(id);
      if (!prev) {
        tierAchievedMap.set(id, { ...tier, sale_date: saleDate });
        return;
      }
      if (saleDate > prev.sale_date || (saleDate === prev.sale_date && tier.thresholdPv >= prev.thresholdPv)) {
        tierAchievedMap.set(id, { ...tier, sale_date: saleDate });
      }
    };

    for (const ev of salesEvents) {
      const member_id = ev.member_id;
      const addPv = ev.pv;
      const saleDate = ev.sale_date;
      const self = memberMap.get(member_id);
      if (!self) {
        missingMemberIds.push(member_id);
        if (trace.length < 120) trace.push({ member_id, add_pv: addPv, own_updated: false, sale_date: saleDate, chain: [] });
        continue;
      }

      maybeApplyDeferredReset(member_id, self, saleDate);
      ensureBefore(member_id, self);
      self.cumulative_pv = Math.max(0, (Number(self.cumulative_pv ?? 0) || 0) + addPv);
      touched.add(member_id);
      {
        const key = `${saleDate}|${member_id}|SELF`;
        ledgerDelta.set(key, (ledgerDelta.get(key) || 0) + addPv);
      }

      const chain: Array<{ parent_id: number; side: "L" | "R" }> = [];
      const candidates = new Set<number>([member_id]);
      let cur = member_id;
      let guard = 0;
      while (parentByChild.has(cur) && guard < 2000) {
        const up = parentByChild.get(cur)!;
        chain.push({ parent_id: up.parent_id, side: up.side });
        const parent = memberMap.get(up.parent_id);
        if (!parent) break;
        maybeApplyDeferredReset(up.parent_id, parent, saleDate);
        ensureBefore(up.parent_id, parent);
        if (up.side === "L") parent.left_line_pv = Math.max(0, (Number(parent.left_line_pv ?? 0) || 0) + addPv);
        else parent.right_line_pv = Math.max(0, (Number(parent.right_line_pv ?? 0) || 0) + addPv);
        touched.add(up.parent_id);
        candidates.add(up.parent_id);
        const key = `${saleDate}|${up.parent_id}|${up.side}`;
        ledgerDelta.set(key, (ledgerDelta.get(key) || 0) + addPv);
        cur = up.parent_id;
        guard += 1;
      }

      for (const candidateId of candidates) {
        const row = memberMap.get(candidateId);
        if (!row) continue;
        const own = Number(row.cumulative_pv ?? 0) || 0;
        const left = Number(row.left_line_pv ?? 0) || 0;
        const right = Number(row.right_line_pv ?? 0) || 0;
        const tier = evaluateTier(own, left, right);
        if (!tier) continue;
        row.tier_grade = tier.grade;
        row.tier_points = tier.points;
        row.tier_title = tier.title;
        touched.add(candidateId);
        const prevPending = pendingResetDateByMember.get(candidateId);
        if (!prevPending || saleDate >= prevPending) {
          pendingResetDateByMember.set(candidateId, saleDate);
          recordTierAchieved(candidateId, tier, saleDate);
        }
      }

      if (trace.length < 120) {
        trace.push({
          member_id,
          add_pv: addPv,
          own_updated: true,
          sale_date: saleDate,
          chain,
        });
      }
    }

    let saved = 0;
    let warning = "";
    for (const id of touched) {
      const row = memberMap.get(id);
      if (!row) continue;

      const basePayload: Record<string, string | number | null> = {
        cumulative_pv: Math.trunc(Number(row.cumulative_pv ?? 0) || 0),
        left_line_pv: Math.trunc(Number(row.left_line_pv ?? 0) || 0),
        right_line_pv: Math.trunc(Number(row.right_line_pv ?? 0) || 0),
        tier_grade: row.tier_grade == null ? null : Number(row.tier_grade),
        tier_points: row.tier_points == null ? null : Number(row.tier_points),
        tier_title: row.tier_title == null ? null : String(row.tier_title),
      };

      const attempts: Array<{ drop: string[]; warn?: string }> = [
        { drop: [] },
        { drop: ["tier_grade", "tier_points", "tier_title"], warn: "티어 컬럼이 없어 티어 저장은 제외됨" },
        { drop: ["tier_grade", "tier_points", "tier_title", "left_line_pv", "right_line_pv"], warn: "라인PV 컬럼이 없어 라인PV 저장은 제외됨" },
      ];

      let ok = false;
      for (const at of attempts) {
        const payload = { ...basePayload };
        for (const k of at.drop) delete payload[k];
        const { error } = await supabase.from("members").update(payload).eq("member_id", id);
        if (!error) {
          ok = true;
          if (at.warn) warning = at.warn;
          break;
        }
      }
      if (ok) saved += 1;
    }

    const changedPreview = Array.from(touched)
      .slice(0, 200)
      .map((id) => {
        const before =
          beforeMap.get(id) ||
          ({ member_id: id, cumulative_pv: 0, left_line_pv: 0, right_line_pv: 0, tier_grade: null, tier_points: null, tier_title: null } as LedgerSnapshot);
        const after = memberMap.get(id) || { cumulative_pv: 0, left_line_pv: 0, right_line_pv: 0 };
        return {
          member_id: id,
          before,
          after: {
            cumulative_pv: Number(after.cumulative_pv ?? 0) || 0,
            left_line_pv: Number(after.left_line_pv ?? 0) || 0,
            right_line_pv: Number(after.right_line_pv ?? 0) || 0,
          },
        };
      });

    const entryMap = new Map<number, number>();
    for (const ev of salesEvents) {
      entryMap.set(ev.member_id, (entryMap.get(ev.member_id) || 0) + ev.pv);
    }

    const batch: SalesBatch = {
      batch_id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      owner_member_id: ownerMemberId,
      created_at: new Date().toISOString(),
      fingerprint,
      entries: Array.from(entryMap.entries()).map(([member_id, pv]) => ({ member_id, pv })),
      snapshots_before: Array.from(beforeMap.values()),
      rolled_back_at: null,
    };

    {
      const b = await supabase.from("sales_batches").insert({
        batch_id: batch.batch_id,
        owner_member_id: batch.owner_member_id,
        created_at: batch.created_at,
        fingerprint: batch.fingerprint,
        rolled_back_at: null,
      });
      if (b.error) {
        if (isMissingTableError(b.error, "sales_batches")) {
          warnings.push("sales ledger 테이블이 없어 중복 방지/롤백 이력 저장이 비활성화됩니다.");
        } else {
          warnings.push(`sales_batches 저장 실패: ${b.error.message}`);
        }
      } else {
        const entryRows = batch.entries.map((e) => ({
          batch_id: batch.batch_id,
          member_id: e.member_id,
          pv: e.pv,
        }));
        if (entryRows.length > 0) {
          const eIns = await supabase.from("sales_batch_entries").insert(entryRows);
          if (eIns.error) warnings.push(`sales_batch_entries 저장 실패: ${eIns.error.message}`);
        }

        const snapRows = batch.snapshots_before.map((s) => ({
          batch_id: batch.batch_id,
          member_id: s.member_id,
          cumulative_pv: s.cumulative_pv,
          left_line_pv: s.left_line_pv,
          right_line_pv: s.right_line_pv,
          tier_grade: s.tier_grade,
          tier_points: s.tier_points,
          tier_title: s.tier_title,
        }));
        if (snapRows.length > 0) {
          const sIns = await supabase.from("sales_batch_snapshots").upsert(snapRows, { onConflict: "batch_id,member_id" });
          if (sIns.error) warnings.push(`sales_batch_snapshots 저장 실패: ${sIns.error.message}`);
        }
      }
    }

    let ledgerWarning: string | null = null;
    const ledgerRows = Array.from(ledgerDelta.entries())
      .map(([k, delta]) => {
        const [saleDate, member, side] = k.split("|");
        return {
          batch_id: batch.batch_id,
          member_id: Number(member),
          side,
          delta_pv: Math.trunc(Number(delta) || 0),
          source: "sales",
          memo: null,
          occurred_at: kstIsoAt(saleDate, "12:00:00"),
        };
      })
      .filter((r) => Number.isFinite(r.member_id) && r.member_id > 0 && r.delta_pv !== 0);
    if (ledgerRows.length > 0) {
      const ins = await supabase.from("pv_ledger").insert(ledgerRows);
      if (ins.error) ledgerWarning = `pv_ledger 기록 실패: ${ins.error.message}`;
    }

    const tierAchieved = Array.from(tierAchievedMap.entries())
      .map(([member_id, t]) => ({
        member_id,
        grade: t.grade,
        points: t.points,
        title: t.title,
        thresholdPv: t.thresholdPv,
        sale_date: t.sale_date,
      }))
      .sort((a, b) => (a.sale_date === b.sale_date ? a.member_id - b.member_id : a.sale_date.localeCompare(b.sale_date)));

    if (tierAchieved.length > 0) {
      const evRows = tierAchieved.map((t) => ({
        member_id: t.member_id,
        event_type: "MATCHING_TIER",
        amount: null,
        memo: `${t.grade}급 달성`,
        occurred_at: kstIsoAt(t.sale_date, "23:59:59"),
      }));
      const ev = await supabase.from("allowance_events").insert(evRows);
      if (ev.error) ledgerWarning = ledgerWarning ? `${ledgerWarning} / allowance_events 기록 실패` : `allowance_events 기록 실패: ${ev.error.message}`;
    }

    if (resetAppliedMap.size > 0) {
      const resetRows = Array.from(resetAppliedMap.entries()).map(([member_id, sale_date]) => ({
        member_id,
        event_type: "MATCHING_RESET",
        amount: null,
        memo: "라인PV 초기화",
        occurred_at: kstIsoAt(sale_date, "00:00:01"),
      }));
      const resetIns = await supabase.from("allowance_events").insert(resetRows);
      if (resetIns.error) {
        ledgerWarning = ledgerWarning ? `${ledgerWarning} / MATCHING_RESET 기록 실패` : `MATCHING_RESET 기록 실패: ${resetIns.error.message}`;
      }
    }

    return NextResponse.json({
      ok: true,
      duplicated: false,
      batch_id: batch.batch_id,
      salesRows: salesEvents.length,
      touchedMembers: touched.size,
      savedMembers: saved,
      missingMemberIds,
      tierAchieved,
      trace,
      changedPreview,
      warning: [warning, ledgerWarning, ...warnings].filter(Boolean).join(" / ") || null,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 500 });
  }
}
