export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";

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

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const mode = String(body?.mode || "last").toLowerCase(); // last | all
    const confirm = String(body?.confirm || "").toUpperCase();
    if (confirm !== "ROLLBACK") {
      return NextResponse.json({ ok: false, error: "confirm=ROLLBACK 가 필요합니다." }, { status: 400 });
    }

    const ledger = await readLedger();
    const active = ledger.batches.filter((b) => !b.rolled_back_at);
    if (active.length === 0) {
      return NextResponse.json({ ok: true, rolledBackBatches: 0, rolledBackMembers: 0, message: "롤백할 매출 반영 이력이 없습니다." });
    }

    const target = mode === "all" ? active : [active[active.length - 1]];
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
    const supabase = createClient(url, serviceKey, { auth: { persistSession: false } });

    let rolledBackMembers = 0;
    for (const batch of [...target].reverse()) {
      for (const s of batch.snapshots_before) {
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
      batch.rolled_back_at = new Date().toISOString();
    }

    await writeLedger(ledger);

    return NextResponse.json({
      ok: true,
      mode,
      rolledBackBatches: target.length,
      rolledBackMembers,
      batchIds: target.map((b) => b.batch_id),
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 500 });
  }
}
