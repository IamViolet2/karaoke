// check.mjs — AI가 준 코드를 붙여 넣은 뒤 점검한다 (npm run ai:check)
//
// 코드를 고치지는 않는다. 바뀐 파일을 살펴 다음을 알려 준다.
//   1) 바뀐 파일과 늘어난/지워진 줄 수 — 생각보다 많이 지워졌으면 AI가 코드를 빠뜨렸을 수 있다
//   2) 생략 흔적 — "...", "// 기존 코드 동일" 처럼 AI가 코드를 줄여 쓴 자리
//   3) 잘못 붙여 넣은 것 — 답변의 ``` 나 "### 파일:" 머리말, 나눠 받은 조각 표시
//   4) 타입 검사(tsc)와 ESLint — 오류가 있으면 .ai/last-error.txt 로 저장해
//      npm run ai:context -- --type bugfix --error .ai/last-error.txt ... 로 바로 물어볼 수 있게 한다
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const FRONT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CODE = /\.(tsx?|jsx?|mjs|css)$/;
const SKIP = /^(\.ai\/|scripts\/ai\/|node_modules\/|\.next\/|out\/|next-env\.d\.ts$|tsconfig\.tsbuildinfo$)/;

const OMISSION = [
  [/^\s*(\/\/|\/\*|\{\/\*|\*)\s*(\.{3}|…)/, "주석이 '...'로 시작합니다"],
  [/^\s*(\.{3}|…)\s*$/, "'...' 만 있는 줄입니다"],
  [/(기존|이전|위와|아래와|나머지|이하|원래|앞과|위의)\s*(코드|내용|부분|로직|구현|함수|컴포넌트)?\s*(와|과|은|는)?\s*(동일|같음|같습니다|그대로|생략|유지)/, "'기존과 동일·나머지 그대로' 같은 생략 표시입니다"],
  [/(생략|중략)\s*(됨|함|합니다)?\s*(\)|\]|\*\/|$)/, "'생략' 표시입니다"],
  [/(\/\/|\/\*|\{\/\*).*\b(rest of (the )?(code|file|component)|existing code|unchanged|same as (before|above)|omitted for brevity)\b/i, "영어 생략 표시입니다"],
];
const PASTE_MISTAKE = [
  [/^\s*```/, "답변의 ``` 표시까지 붙여 넣었습니다"],
  [/^\s*###\s*파일\s*:/, "답변의 '### 파일:' 머리말까지 붙여 넣었습니다"],
  [/^\s*\d{1,4}\|\s/, "줄 번호(예: '  12| ')까지 붙여 넣었습니다"],
];
const PART = /=====\s*(여기까지|파일 끝)\s*\((\d+)\/(\d+)\)/;

function run(cmd, args) {
  return spawnSync(cmd, args, { cwd: FRONT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
}
const nodeBin = (rel, args) => run(process.execPath, [path.join(FRONT, rel), ...args]);

// ── 1. 바뀐 파일 ───────────────────────────────────────────────────────────
const st = run("git", ["status", "--porcelain", "-uall", "--", "."]);
if (st.status !== 0) {
  console.error("\n❌ git 저장소에서 실행해 주세요 (frontend 폴더 안에서 npm run ai:check).\n");
  process.exit(1);
}
const prefix = run("git", ["rev-parse", "--show-prefix"]).stdout.trim(); // 보통 "frontend/"
const changed = [];
for (const line of st.stdout.split("\n").filter(Boolean)) {
  const code = line.slice(0, 2);
  let file = line.slice(3).replace(/^"|"$/g, "");
  if (file.includes(" -> ")) file = file.split(" -> ")[1];
  if (prefix && file.startsWith(prefix)) file = file.slice(prefix.length);
  if (SKIP.test(file) || code.includes("D")) continue;
  changed.push({ file, isNew: code === "??" || code.includes("A") });
}

console.log("\n🔎 AI 코드 붙여넣기 점검\n");
if (!changed.length) {
  console.log("바뀐 파일이 없습니다. 붙여 넣은 뒤 파일을 저장(Ctrl+S)했는지 확인하세요.\n");
  process.exit(0);
}

let problems = 0, cautions = 0;
const report = [];
for (const { file, isNew } of changed) {
  const abs = path.join(FRONT, file);
  if (!fs.existsSync(abs) || !CODE.test(file)) {
    report.push(`• frontend/${file} ${isNew ? "(새 파일)" : ""}`);
    continue;
  }
  const text = fs.readFileSync(abs, "utf8");
  const lines = text.split(/\r?\n/);
  let added = lines.length, removed = 0, before = 0;
  if (!isNew) {
    const ns = run("git", ["diff", "--numstat", "HEAD", "--", file]).stdout.trim().split(/\s+/);
    added = Number(ns[0]) || 0;
    removed = Number(ns[1]) || 0;
    const old = run("git", ["show", `HEAD:${prefix}${file}`]);
    before = old.status === 0 ? old.stdout.split("\n").length : 0;
  }
  const notes = [];
  lines.forEach((l, i) => {
    for (const [re, why] of OMISSION) if (re.test(l)) { notes.push(`❌ ${i + 1}번째 줄 — ${why}: ${l.trim().slice(0, 70)}`); problems++; break; }
    for (const [re, why] of PASTE_MISTAKE) if (re.test(l)) { notes.push(`❌ ${i + 1}번째 줄 — ${why}`); problems++; break; }
  });
  // 나눠 받은 큰 파일: 조각 표시가 1, 2, …, n 순서로 모두 있는지
  const parts = lines.map((l, i) => [l.match(PART), i + 1]).filter(([m]) => m);
  if (parts.length) {
    const total = Number(parts[0][0][3]);
    const nums = parts.map(([m]) => Number(m[2]));
    const ok = nums.length === total && nums.every((n, k) => n === k + 1) && /파일 끝/.test(parts[parts.length - 1][0][1]);
    if (ok) {
      notes.push(`⚠️ 나눠 받은 조각 ${total}개가 순서대로 다 붙었습니다. 확인이 끝나면 조각 표시 줄(${parts.map(([, n]) => n).join(", ")}번째 줄)을 지우세요.`);
      cautions++;
    } else {
      notes.push(`❌ 나눠 받은 조각이 빠졌거나 순서가 틀립니다 (붙은 조각: ${nums.join(", ")} / 전체 ${total}개).`);
      problems++;
    }
  }
  if (!isNew && removed >= 15 && removed > before * 0.25) {
    notes.push(`⚠️ ${removed}줄이 지워졌습니다(원래 ${before}줄). 계획에 없던 삭제라면 AI가 코드를 빠뜨린 것입니다 — VS Code 소스 제어에서 빨간 줄을 확인하세요.`);
    cautions++;
  }
  if (!isNew && removed > added * 3 && removed >= 10) {
    notes.push("⚠️ 늘어난 줄보다 지워진 줄이 훨씬 많습니다. 파일 일부만 붙여 넣지 않았는지 확인하세요.");
    cautions++;
  }
  report.push(`• frontend/${file} ${isNew ? `(새 파일, ${lines.length}줄)` : `(+${added} −${removed})`}`);
  for (const n of notes) report.push(`    ${n}`);
}
console.log(report.join("\n"));

// ── 2. 타입 검사와 ESLint ───────────────────────────────────────────────────
console.log("\n⏳ 타입 검사(tsc) 중…");
let tsc = nodeBin("node_modules/typescript/bin/tsc", ["--noEmit", "-p", "."]);
if (/Cannot find name 'LayoutProps'/.test(tsc.stdout)) {
  nodeBin("node_modules/next/dist/bin/next", ["typegen"]);
  tsc = nodeBin("node_modules/typescript/bin/tsc", ["--noEmit", "-p", "."]);
}
const tsOut = (tsc.stdout + tsc.stderr).trim();
const tsErrors = (tsOut.match(/error TS\d+/g) || []).length;

const lintFiles = changed.map((c) => c.file).filter((f) => /\.(tsx?|jsx?|mjs)$/.test(f) && fs.existsSync(path.join(FRONT, f)));
let lintOut = "", lintErrors = 0, lintWarnings = 0;
if (lintFiles.length) {
  console.log("⏳ ESLint 검사 중…");
  const lint = nodeBin("node_modules/eslint/bin/eslint.js", lintFiles);
  lintOut = (lint.stdout + lint.stderr).trim();
  const m = lintOut.match(/(\d+) errors?, (\d+) warnings?/);
  if (m) { lintErrors = Number(m[1]); lintWarnings = Number(m[2]); }
  else if (lint.status !== 0) lintErrors = 1;
}

console.log(`\n${tsErrors ? "❌" : "✅"} 타입 검사: ${tsErrors ? `오류 ${tsErrors}개` : "통과"}`);
console.log(`${lintErrors ? "❌" : lintWarnings ? "⚠️" : "✅"} ESLint: ${lintErrors || lintWarnings ? `오류 ${lintErrors}개, 경고 ${lintWarnings}개` : "통과"}`);

const errFile = path.join(FRONT, ".ai", "last-error.txt");
if (tsErrors || lintErrors) {
  fs.mkdirSync(path.dirname(errFile), { recursive: true });
  const body = [tsErrors ? `[타입 검사 tsc]\n${tsOut}` : "", lintErrors ? `[ESLint]\n${lintOut}` : ""].filter(Boolean).join("\n\n");
  fs.writeFileSync(errFile, body + "\n", "utf8");
  console.log("\n오류 앞부분:");
  console.log(body.split("\n").slice(0, 12).map((l) => "   " + l).join("\n"));
  console.log("\n전체 오류는 frontend/.ai/last-error.txt 에 저장했습니다. AI에게 물어보려면:");
  console.log(`   npm run ai:context -- --type bugfix --task "붙여 넣은 뒤 이런 오류가 납니다" --error .ai/last-error.txt --files ${lintFiles.join(" ") || "<고친 파일>"}`);
} else if (fs.existsSync(errFile)) {
  fs.rmSync(errFile);
}

// ── 3. 결론 ─────────────────────────────────────────────────────────────────
const bad = problems || tsErrors || lintErrors;
console.log("");
if (bad) {
  console.log("❌ 고칠 것이 있습니다. 위 ❌ 줄부터 해결하세요.");
  if (problems) console.log("   생략·붙여넣기 문제는 AI에게 '생략 없이 파일 전체를 다시 달라'고 하거나, 붙여 넣기를 다시 하세요.");
} else {
  console.log(cautions ? "⚠️ 오류는 없습니다. ⚠️ 줄을 직접 확인하세요." : "✅ 문제를 찾지 못했습니다.");
  console.log("   이제 npm run dev 로 화면을 열어 완료 기준을 눈으로 확인하세요. 확인되면 커밋합니다.");
}
console.log("");
process.exit(bad ? 1 : 0);
