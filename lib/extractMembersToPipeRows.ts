// app/lib/extractMembersToPipeRows.ts
export function extractMembersToPipeRows(raw: string) {
  const ranks = ["다이아몬드마스터", "세일즈마스터", "특약점", "대리점", "에이전트", "판매원"];

  const rankPrefixes = [
    "다이아몬드마스터",
    "세일즈마스터",
    "특약점",
    "대리점",
    "에이전트",
    "판매원",
    "이전트",
    "회원",
    "비회원",
  ];

  // ✅ 하트 문자가 PDF마다 달라질 수 있어서 2종 같이 잡는 걸 권장
  const heartCount = (raw.match(/[🤍♡]/g) || []).length;

  let made = 0;
  let skippedNoName = 0;
  let skippedNoId = 0;
  let skippedNoPv = 0;

  const rows: string[] = [];

  // ✅ 사람 기준: 하트 + ID
  const re = /[🤍♡]\s*([0-9]{7,9})/g;

  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const idStr = m[1];
    const idNum = Number(idStr);
    if (!Number.isFinite(idNum)) {
      skippedNoId++;
      continue;
    }

    const tailStart = m.index + m[0].length;
    const tail = raw.slice(tailStart, tailStart + 200);
    const nomokIdx = tail.indexOf("명목");
    const nameZone = (nomokIdx >= 0 ? tail.slice(0, nomokIdx) : tail).replace(/\s+/g, "");

    let cleanName = nameZone;

    let changed = true;
    while (changed) {
      changed = false;
      for (const p of rankPrefixes) {
        if (cleanName.startsWith(p)) {
          cleanName = cleanName.slice(p.length).trim();
          changed = true;
          break;
        }
      }
    }

    if (!cleanName || cleanName.length < 2) {
      skippedNoName++;
      continue;
    }

    let rank = "판매원";
    for (const r of ranks) {
      if (tail.includes(r)) {
        rank = r;
        break;
      }
    }
    if (tail.includes("이전트")) rank = "에이전트";

    const head = raw.slice(Math.max(0, m.index - 240), m.index);

    const pvMatch = head.match(/누적\s*PV\s*([0-9,]+)/);
    const pv = pvMatch ? Number(pvMatch[1].replace(/,/g, "")) : 0;
    if (!pvMatch) skippedNoPv++;

    const dateMatch = head.match(/매출일\s*(\d{4}-\d{2}-\d{2})/);
    const lastDate = dateMatch ? dateMatch[1] : "-";

    const centerMatch = head.match(/본사센터\s*([가-힣0-9\s]{2,40}?)\s*인증/);
    const center = centerMatch ? centerMatch[1].replace(/\s+/g, "").trim() : "-";

    rows.push([idNum, 0, "ROOT", cleanName, center, rank, lastDate, pv].join(" | "));
    made++;
  }

  rows.unshift(
    `// DEBUG heartCount=${heartCount} made=${made} skippedNoName=${skippedNoName} skippedNoId=${skippedNoId} skippedNoPv=${skippedNoPv}`
  );

  return rows.join("\n");
}