export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

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
  created_at: string;
  fingerprint: string;
  entries: Array<{ member_id: number; pv: number }>;
  snapshots_before: LedgerSnapshot[];
  rolled_back_at?: string | null;
};

type SalesLedger = {
  version: 1;
  batches: SalesBatch[];
};

const LEDGER_PATH = process.env.VERCEL ? "/tmp/sales-ledger.json" : join(process.cwd(), "data", "sales-ledger.json");

async function readLedger(): Promise<SalesLedger> {
  try {
    const raw = await fs.readFile(LEDGER_PATH, "utf8");
    const json = JSON.parse(raw);
    if (json && json.version === 1 && Array.isArray(json.batches)) return json as SalesLedger;
    return { version: 1, batches: [] };
  } catch {
    return { version: 1, batches: [] };
  }
}

async function writeLedger(ledger: SalesLedger) {
  await fs.mkdir(dirname(LEDGER_PATH), { recursive: true });
  await fs.writeFile(LEDGER_PATH, JSON.stringify(ledger, null, 2), "utf8");
}

function salesFingerprint(salesMap: Map<number, number>) {
  const normalized = Array.from(salesMap.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([id, pv]) => `${id}:${pv}`)
    .join("|");
  return createHash("sha256").update(normalized).digest("hex");
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
  const out = new Map<number, number>();
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  // Case 1) 한 줄 포맷
  for (const line of lines) {
    if (line.startsWith("//")) continue;
    // 허용: "29527956|1000", "29527956 1000", "이지아 29527956 1,000", "29527956 -1,000"
    const nums = [...line.matchAll(/\d[\d,]*/g)].map((m) => m[0].replace(/,/g, ""));
    const signed = [...line.matchAll(/-?\d[\d,]*/g)].map((m) => m[0].replace(/,/g, ""));
    if (nums.length >= 2 && signed.length >= 1) {
      const member_id = Number(nums.find((n) => n.length >= 7 && n.length <= 9) || 0);
      const pv = Number(signed[signed.length - 1] || 0);
      if (Number.isFinite(member_id) && member_id > 0 && Number.isFinite(pv) && pv !== 0) {
        out.set(member_id, (out.get(member_id) || 0) + Math.trunc(pv));
        continue;
      }
    }
  }

  // Case 2) 여러 줄 블록 포맷
  // (좌/우, 판매/반품, 일자, 법인, 회원번호, 이름, 주문번호, PV)
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
      // 주문번호(11~20자리)는 제외
      if (/^-?\d{11,20}$/.test(raw)) continue;
      const v = Number(raw);
      if (!Number.isFinite(v) || v === 0) continue;
      if (Math.abs(v) > 100000000) continue;
      foundPv = Math.trunc(v);
      break;
    }
    if (foundPv !== null) out.set(member_id, (out.get(member_id) || 0) + foundPv);
  }

  return out;
}

export async function POST(req: NextRequest) {
  try {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
    const supabase = createClient(url, serviceKey, { auth: { persistSession: false } });

    const body = await req.json();
    const salesText = String(body?.text ?? "");
    const salesMap = parseSalesText(salesText);
    if (salesMap.size === 0) {
      return NextResponse.json({ ok: false, error: "유효한 매출 데이터가 없습니다. (회원번호 + PV)" }, { status: 400 });
    }

    const fingerprint = salesFingerprint(salesMap);
    const ledger = await readLedger();
    const duplicated = ledger.batches.find((b) => b.fingerprint === fingerprint && !b.rolled_back_at);
    if (duplicated) {
      return NextResponse.json({
        ok: true,
        duplicated: true,
        skipped: true,
        reason: "같은 매출 묶음이 이미 반영되어 중복 적용을 건너뛰었습니다.",
        batch_id: duplicated.batch_id,
      });
    }

    const { data: edges, error: edgeErr } = await supabase.from("edges").select("parent_id, child_id, side");
    if (edgeErr) return NextResponse.json({ ok: false, error: edgeErr.message }, { status: 500 });

    const parentByChild = new Map<number, { parent_id: number; side: "L" | "R" }>();
    for (const e of (edges || []) as Edge[]) {
      parentByChild.set(e.child_id, { parent_id: e.parent_id, side: e.side === "R" ? "R" : "L" });
    }

    const impacted = new Set<number>();
    for (const member_id of salesMap.keys()) {
      impacted.add(member_id);
      let cur = member_id;
      let guard = 0;
      while (parentByChild.has(cur) && guard < 2000) {
        const up = parentByChild.get(cur)!;
        impacted.add(up.parent_id);
        cur = up.parent_id;
        guard += 1;
      }
    }

    const impactedIds = Array.from(impacted);

    // 컬럼 폴백 select
    let rows: MemberRow[] = [];
    {
      const r1 = await supabase
        .from("members")
        .select("member_id, cumulative_pv, left_line_pv, right_line_pv, tier_grade, tier_points, tier_title")
        .in("member_id", impactedIds);
      if (!r1.error) rows = (r1.data || []) as MemberRow[];
      else {
        const r2 = await supabase
          .from("members")
          .select("member_id, cumulative_pv, left_line_pv, right_line_pv")
          .in("member_id", impactedIds);
        if (!r2.error) rows = (r2.data || []) as MemberRow[];
        else {
          const r3 = await supabase.from("members").select("member_id, cumulative_pv").in("member_id", impactedIds);
          if (r3.error) return NextResponse.json({ ok: false, error: r3.error.message }, { status: 500 });
          rows = (r3.data || []) as MemberRow[];
        }
      }
    }

    const map = new Map<number, MemberRow>();
    for (const r of rows) {
      map.set(r.member_id, {
        member_id: r.member_id,
        cumulative_pv: Number(r.cumulative_pv ?? 0) || 0,
        left_line_pv: Number(r.left_line_pv ?? 0) || 0,
        right_line_pv: Number(r.right_line_pv ?? 0) || 0,
        tier_grade: r.tier_grade ?? null,
        tier_points: r.tier_points ?? null,
        tier_title: r.tier_title ?? null,
      });
    }

    const missingMemberIds: number[] = [];
    const touched = new Set<number>();
    const beforeMap = new Map<number, LedgerSnapshot>();
    const ledgerDelta = new Map<string, number>();
    const trace: Array<{
      member_id: number;
      add_pv: number;
      own_updated: boolean;
      chain: Array<{ parent_id: number; side: "L" | "R" }>;
    }> = [];

    for (const [member_id, addPv] of salesMap.entries()) {
      const self = map.get(member_id);
      if (!self) {
        missingMemberIds.push(member_id);
        trace.push({ member_id, add_pv: addPv, own_updated: false, chain: [] });
        continue;
      }

      if (!beforeMap.has(member_id)) {
        beforeMap.set(member_id, {
          member_id,
          cumulative_pv: Number(self.cumulative_pv ?? 0),
          left_line_pv: Number(self.left_line_pv ?? 0),
          right_line_pv: Number(self.right_line_pv ?? 0),
          tier_grade: self.tier_grade == null ? null : Number(self.tier_grade),
          tier_points: self.tier_points == null ? null : Number(self.tier_points),
          tier_title: self.tier_title == null ? null : String(self.tier_title),
        });
      }
      self.cumulative_pv = Math.max(0, (Number(self.cumulative_pv ?? 0) || 0) + addPv);
      touched.add(member_id);
      {
        const key = `${member_id}|SELF`;
        ledgerDelta.set(key, (ledgerDelta.get(key) || 0) + addPv);
      }
      const chain: Array<{ parent_id: number; side: "L" | "R" }> = [];

      let cur = member_id;
      let guard = 0;
      while (parentByChild.has(cur) && guard < 2000) {
        const up = parentByChild.get(cur)!;
        chain.push({ parent_id: up.parent_id, side: up.side });
        const p = map.get(up.parent_id);
        if (!p) break;
        if (!beforeMap.has(up.parent_id)) {
          beforeMap.set(up.parent_id, {
            member_id: up.parent_id,
            cumulative_pv: Number(p.cumulative_pv ?? 0),
            left_line_pv: Number(p.left_line_pv ?? 0),
            right_line_pv: Number(p.right_line_pv ?? 0),
            tier_grade: p.tier_grade == null ? null : Number(p.tier_grade),
            tier_points: p.tier_points == null ? null : Number(p.tier_points),
            tier_title: p.tier_title == null ? null : String(p.tier_title),
          });
        }
        if (up.side === "L") p.left_line_pv = Math.max(0, (Number(p.left_line_pv ?? 0) || 0) + addPv);
        else p.right_line_pv = Math.max(0, (Number(p.right_line_pv ?? 0) || 0) + addPv);
        {
          const key = `${up.parent_id}|${up.side}`;
          ledgerDelta.set(key, (ledgerDelta.get(key) || 0) + addPv);
        }
        touched.add(up.parent_id);
        cur = up.parent_id;
        guard += 1;
      }

      if (trace.length < 120) {
        trace.push({
          member_id,
          add_pv: addPv,
          own_updated: true,
          chain,
        });
      }
    }

    const tierAchieved: Array<{ member_id: number; grade: number; points: number; title: string; thresholdPv: number }> = [];
    for (const id of touched) {
      const row = map.get(id);
      if (!row) continue;
      const own = Number(row.cumulative_pv ?? 0) || 0;
      const left = Number(row.left_line_pv ?? 0) || 0;
      const right = Number(row.right_line_pv ?? 0) || 0;
      const tier = evaluateTier(own, left, right);
      if (!tier) continue;
      row.tier_grade = tier.grade;
      row.tier_points = tier.points;
      row.tier_title = tier.title;
      row.left_line_pv = 0;
      row.right_line_pv = 0;
      tierAchieved.push({ member_id: id, ...tier });
    }

    let saved = 0;
    let warning = "";
    for (const id of touched) {
      const row = map.get(id);
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
        const after = map.get(id) || { cumulative_pv: 0, left_line_pv: 0, right_line_pv: 0 };
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

    const batch: SalesBatch = {
      batch_id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      created_at: new Date().toISOString(),
      fingerprint,
      entries: Array.from(salesMap.entries()).map(([member_id, pv]) => ({ member_id, pv })),
      snapshots_before: Array.from(beforeMap.values()),
      rolled_back_at: null,
    };
    ledger.batches.push(batch);
    await writeLedger(ledger);

    // pv_ledger 기록 (테이블/컬럼이 없으면 경고만 남기고 진행)
    let ledgerWarning: string | null = null;
    const ledgerRows = Array.from(ledgerDelta.entries())
      .map(([k, delta]) => {
        const [member, side] = k.split("|");
        return {
          batch_id: batch.batch_id,
          member_id: Number(member),
          side,
          delta_pv: Math.trunc(Number(delta) || 0),
          source: "sales",
          memo: null,
          occurred_at: new Date().toISOString(),
        };
      })
      .filter((r) => Number.isFinite(r.member_id) && r.member_id > 0 && r.delta_pv !== 0);
    if (ledgerRows.length > 0) {
      const ins = await supabase.from("pv_ledger").insert(ledgerRows);
      if (ins.error) ledgerWarning = `pv_ledger 기록 실패: ${ins.error.message}`;
    }

    if (tierAchieved.length > 0) {
      const evRows = tierAchieved.map((t) => ({
        member_id: t.member_id,
        event_type: "MATCHING_TIER",
        amount: null,
        memo: `${t.grade}급 달성`,
        occurred_at: new Date().toISOString(),
      }));
      const ev = await supabase.from("allowance_events").insert(evRows);
      if (ev.error) ledgerWarning = ledgerWarning ? `${ledgerWarning} / allowance_events 기록 실패` : `allowance_events 기록 실패: ${ev.error.message}`;
    }

    const envWarning = process.env.VERCEL
      ? "배포환경에서는 중복 방지/롤백 이력이 인스턴스별로 일시적으로 달라질 수 있습니다."
      : null;

    return NextResponse.json({
      ok: true,
      duplicated: false,
      batch_id: batch.batch_id,
      salesRows: salesMap.size,
      touchedMembers: touched.size,
      savedMembers: saved,
      missingMemberIds,
      tierAchieved,
      trace,
      changedPreview,
      warning: [warning, ledgerWarning, envWarning].filter(Boolean).join(" / ") || null,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 500 });
  }
}
