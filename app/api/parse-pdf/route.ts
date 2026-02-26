import { NextResponse } from "next/server";

type ParsedMember = {
  member_id: number;
  name: string;
  rank: string; // backward-compatible alias of nominal_rank
  nominal_rank: string;
  current_rank: string;
  cumulative_pv: number;
  center: string;
  corporation: string;
  last_purchase_date: string | null;
  raw: string;
  confidence: number;
};

const RANKS = ["다이아몬드마스터", "세일즈마스터", "특약점", "대리점", "에이전트", "판매원", "회원", "자가소비회원", "총판"];
const NOISE_LINE = /^(명목|현재|법인|센터|인증|가입일|탈퇴일|매출일|누적PV|좌\s*좌|좌\s*우|우\s*좌|우\s*우|좌|우|ROOT|L|R)$/;
const MARKER_ONLY = /^[🤍💛♡]\s*$/;
const DEPTH_AND_ID = /(\d{1,3})\s+(\d{7,9})\b/;
const ID_ONLY = /\b\d{7,9}\b/g;

function cleanLines(raw: string) {
  const src = raw
    .replace(/\r/g, "")
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("// ---"));

  const out: string[] = [];
  let pendingMarker = "";

  for (const line of src) {
    if (MARKER_ONLY.test(line)) {
      pendingMarker = line;
      continue;
    }

    if (pendingMarker && /^\d+\s+\d{7,9}\b/.test(line)) {
      out.push(`${pendingMarker} ${line}`);
      pendingMarker = "";
      continue;
    }

    if (pendingMarker) {
      out.push(pendingMarker);
      pendingMarker = "";
    }

    out.push(line);
  }

  if (pendingMarker) out.push(pendingMarker);
  return out;
}

function isRankLine(line?: string) {
  const txt = String(line || "").trim();
  if (!txt) return false;
  return RANKS.includes(txt);
}

function splitBlocks(lines: string[]) {
  const blocks: string[][] = [];
  let cur: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    cur.push(line);

    if (DEPTH_AND_ID.test(line)) {
      const hasFields = cur.some((x) => x.startsWith("누적PV") || x.startsWith("매출일") || x.startsWith("가입일"));
      if (hasFields) {
        // ID 라인 바로 다음의 단독 등급(예: 대리점/특약점/에이전트)은
        // 현재 멤버의 표시 등급으로 붙여준다.
        const next = lines[i + 1];
        if (isRankLine(next)) {
          cur.push(next.trim());
          i += 1;
        }
        blocks.push(cur);
        cur = [];
      }
    }
  }

  if (cur.length > 0) blocks.push(cur);
  return blocks;
}

function extractMemberId(lines: string[]) {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const m = lines[i].match(DEPTH_AND_ID);
    if (m) {
      const id = Number(m[m.length - 1]);
      if (Number.isFinite(id)) return id;
    }

    const all = [...lines[i].matchAll(ID_ONLY)].map((x) => Number(x[0])).filter(Number.isFinite);
    if (all.length) return all[all.length - 1];
  }
  return 0;
}

function normalizeName(name: string) {
  return name
    .replace(/[🤍💛♡]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function pickName(lines: string[]) {
  const candidates = lines.filter((line) => {
    if (!line) return false;
    if (NOISE_LINE.test(line)) return false;
    if (line.startsWith("명목 ") || line.startsWith("현재 ") || line.startsWith("법인 ") || line.startsWith("센터 ")) return false;
    if (line.startsWith("인증 ") || line.startsWith("가입일 ") || line.startsWith("탈퇴일 ") || line.startsWith("매출일 ") || line.startsWith("누적PV ")) return false;
    if (RANKS.includes(line)) return false;
    if (DEPTH_AND_ID.test(line)) return false;
    if (/^\d+\s+\d{7,9}\b/.test(line)) return false;
    return true;
  });

  return normalizeName(candidates[0] || "");
}

function pickRank(lines: string[]) {
  // ID 라인 아래에 붙어있는 표시등급을 우선 사용
  for (let i = 0; i < lines.length; i += 1) {
    if (!DEPTH_AND_ID.test(lines[i])) continue;
    const next = (lines[i + 1] || "").trim();
    if (isRankLine(next)) return next;
  }

  for (const line of lines) {
    const m1 = line.match(/현재(?:등급)?\s*[:：]?\s*(.+)$/);
    if (m1?.[1]) {
      const v = m1[1].trim();
      for (const r of RANKS) if (v.includes(r)) return r;
      if (v && !NOISE_LINE.test(v)) return v;
    }
    const m2 = line.match(/현재(?:등급)?\s*(자가소비회원|회원|판매원|에이전트|특약점|대리점|총판)/);
    if (m2?.[1]) return m2[1];
  }

  const idx = lines.findIndex((l) => /^현재(?:등급)?(?:\s+.*)?$/.test(l));
  if (idx >= 0) {
    const inline = lines[idx].replace(/^현재(?:등급)?\s*/, "").trim();
    if (inline) return inline;
    const next = (lines[idx + 1] || "").trim();
    if (next && !NOISE_LINE.test(next) && !DEPTH_AND_ID.test(next)) return next;
    return "판매원";
  }

  const singleRank = lines.find((l) => RANKS.includes(l.trim()));
  if (singleRank) return singleRank.trim();

  const merged = lines.join(" ");
  for (const r of RANKS) {
    if (merged.includes(r)) return r;
  }
  return "판매원";
}

function pickNominalRank(lines: string[]) {
  for (const line of lines) {
    const m1 = line.match(/명목(?:등급)?\s*[:：]?\s*(.+)$/);
    if (m1?.[1]) {
      const v = m1[1].trim();
      for (const r of RANKS) if (v.includes(r)) return r;
      if (v && !NOISE_LINE.test(v)) return v;
    }
  }

  const idx = lines.findIndex((l) => /^명목(?:등급)?(?:\s+.*)?$/.test(l));
  if (idx >= 0) {
    const inline = lines[idx].replace(/^명목(?:등급)?\s*/, "").trim();
    if (inline) return inline;
    const next = (lines[idx + 1] || "").trim();
    if (next && !NOISE_LINE.test(next) && !DEPTH_AND_ID.test(next)) return next;
    return "판매원";
  }
  return pickRank(lines);
}

function pickDate(lines: string[]) {
  const line = lines.find((l) => l.startsWith("매출일 "));
  if (!line) return null;
  const m = line.match(/\b20\d{2}-\d{2}-\d{2}\b/);
  return m ? m[0] : null;
}

function pickPv(lines: string[]) {
  const line = lines.find((l) => l.startsWith("누적PV"));
  if (!line) return 0;
  const m = line.match(/([0-9][0-9,]*)/);
  if (!m) return 0;
  return Number(m[1].replace(/,/g, "")) || 0;
}

function pickCorp(lines: string[]) {
  const line = lines.find((l) => l.startsWith("법인 "));
  if (!line) return "-";
  return line.replace(/^법인\s+/, "").trim() || "-";
}

function pickCenter(lines: string[]) {
  const idx = lines.findIndex((l) => l.startsWith("센터 "));
  if (idx < 0) return "-";
  let center = lines[idx].replace(/^센터\s+/, "").trim();

  const next = lines[idx + 1] || "";
  if (next && !next.startsWith("인증 ") && !NOISE_LINE.test(next) && !DEPTH_AND_ID.test(next) && !RANKS.includes(next)) {
    center = `${center} ${next}`.replace(/\s+/g, " ").trim();
  }

  return center || "-";
}

function parseMembers(raw: string) {
  const lines = cleanLines(raw);
  const blocks = splitBlocks(lines);
  const out: ParsedMember[] = [];
  const seen = new Set<number>();

  for (const linesBlock of blocks) {
    const member_id = extractMemberId(linesBlock);
    if (!member_id || seen.has(member_id)) continue;

    const name = pickName(linesBlock);
    const nominal_rank = pickNominalRank(linesBlock);
    const current_rank = pickRank(linesBlock);
    const cumulative_pv = pickPv(linesBlock);
    const center = pickCenter(linesBlock);
    const corporation = pickCorp(linesBlock);
    const last_purchase_date = pickDate(linesBlock);

    let confidence = 0.35;
    if (name.length >= 2) confidence += 0.25;
    if (nominal_rank || current_rank) confidence += 0.1;
    if (center !== "-") confidence += 0.1;
    if (corporation !== "-") confidence += 0.1;
    if (last_purchase_date) confidence += 0.05;
    if (cumulative_pv >= 0) confidence += 0.05;

    out.push({
      member_id,
      name: name || `회원_${member_id}`,
      rank: current_rank || nominal_rank,
      nominal_rank,
      current_rank,
      cumulative_pv,
      center,
      corporation,
      last_purchase_date,
      raw: linesBlock.join("\n"),
      confidence: Math.min(confidence, 0.99),
    });
    seen.add(member_id);
  }

  return out;
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const raw = String(body?.raw ?? "");

    const items = parseMembers(raw);
    const rowsText = items
      .map((m) =>
        [
          m.member_id,
          0,
          "ROOT",
          m.name,
          m.center || "-",
          m.rank || "판매원",
          m.last_purchase_date || "-",
          m.cumulative_pv || 0,
          m.corporation || "-",
        ].join(" | ")
      )
      .join("\n");

    return NextResponse.json({
      ok: true,
      items,
      text: rowsText,
      stats: { parsed: items.length },
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? "parse failed" }, { status: 500 });
  }
}
