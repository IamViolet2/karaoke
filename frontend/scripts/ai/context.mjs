// context.mjs — 대화창 AI에 붙여 넣을 프롬프트를 만든다 (npm run ai:context)
//
// 대화창 AI는 우리 저장소를 볼 수 없다. 그래서 프로젝트 카드 · 규칙 원문 · 작업 카드 · 관련 파일 전체 ·
// 오류 같은 증거 · 답변 형식을 한 파일(.ai/prompt.md)로 모아 준다. 학생은 그 파일을 열어 전부 복사해 붙여 넣는다.
//
//   npm run ai:context -- --type feature --task "하고 싶은 것" --done "완료 기준" --files components/booth/X.tsx
//   npm run ai:context -- --type bugfix  --task "증상" --error .ai/last-error.txt --files hooks/useBoothData.ts
//   npm run ai:context -- --type explain --task "알고 싶은 것" --files hooks/useBoothSession.ts
//
// 옵션: --type feature|bugfix|ui|explain · --task 글 · --task-file 파일 · --done 글(여러 번) · --files 경로...
//       --error 파일(오류 메시지) · --evidence 파일(화면·콘솔·네트워크에서 본 것) · --diff(지금까지 바꾼 내용)
//       --no-types · --out 경로
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FRONT = path.resolve(HERE, "..", "..");        // frontend/
const REPO = path.resolve(FRONT, "..");
const RULES = ["karpathy-principles.md", "ui-ux-rules.md", "coding-standards.md", "security-rules.md"];
const BIG_FILE_LINES = 400;
const WARN_CHARS = 60000;
const TYPES = ["feature", "bugfix", "ui", "explain"];

// ── 옵션 읽기 ──────────────────────────────────────────────────────────────
function parseArgs(argv) {
  // 'npm run ai:context' 뒤에 '--'를 빠뜨리면(또는 PowerShell이 '--'를 지우면) npm이 옵션을 가져가 버린다.
  // 그때 npm은 npm_config_type 같은 환경 변수만 남기므로, 그것을 보고 원인을 바로 알려 준다.
  if (["type", "task", "files", "done", "error", "evidence"].some((k) => process.env[`npm_config_${k}`])) {
    fail("npm이 옵션(--type, --task, --files …)을 가져가 버렸습니다.\n" +
      "   'npm run ai:context' 바로 뒤에 '--'를 꼭 쓰세요:  npm run ai:context -- --type feature --task \"…\" --files …\n" +
      "   PowerShell에서 '--'를 썼는데도 이 메시지가 나오면 npm 없이 직접 실행하세요:\n" +
      "   node scripts/ai/context.mjs --type feature --task \"…\" --files …");
  }
  const o = { type: "feature", task: "", done: [], files: [], diff: false, types: true, out: ".ai/prompt.md" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) fail(`${a} 뒤에 값이 없습니다.`);
      return argv[++i];
    };
    if (a === "--type") o.type = next();
    else if (a === "--task") o.task = next();
    else if (a === "--task-file") o.task = readText(next());
    else if (a === "--done") o.done.push(next());
    else if (a === "--error") o.error = next();
    else if (a === "--evidence") o.evidence = next();
    else if (a === "--diff") o.diff = true;
    else if (a === "--no-types") o.types = false;
    else if (a === "--out") o.out = next();
    else if (a === "--files") {
      while (i + 1 < argv.length && !argv[i + 1].startsWith("--")) o.files.push(argv[++i]);
    } else if (a === "-h" || a === "--help") {
      const src = fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n");
      console.log(src.slice(0, src.findIndex((l) => l.startsWith("import"))).join("\n"));
      process.exit(0);
    } else fail(`모르는 옵션입니다: ${a}  (도움말: npm run ai:context -- --help)`);
  }
  if (!TYPES.includes(o.type)) fail(`--type 은 ${TYPES.join(" / ")} 중 하나입니다.`);
  if (!o.task.trim()) fail('--task "하고 싶은 것(또는 증상·궁금한 점)" 을 적어 주세요.');
  if (!o.files.length) fail("--files 로 관련 파일을 한 개 이상 골라 주세요. (매뉴얼의 '기능 → 파일 지도' 참고)");
  return o;
}

function fail(msg) {
  console.error(`\n❌ ${msg}\n`);
  process.exit(1);
}

function readText(p) {
  const abs = path.resolve(process.cwd(), p);
  if (!fs.existsSync(abs)) fail(`파일이 없습니다: ${p}`);
  return fs.readFileSync(abs, "utf8");
}

// ── 파일 경로: frontend/ 기준으로 맞추고, 비밀 파일은 거절한다 ─────────────
function normalize(p) {
  let rel = p.replace(/\\/g, "/").replace(/^\.\//, "");
  if (rel.startsWith("frontend/")) rel = rel.slice("frontend/".length);
  const abs = path.resolve(FRONT, rel);
  if (/(^|\/)\.env(?!\.example$)/.test(rel)) fail(`${p} 는 비밀 값이 들어 있는 .env 파일이라 넣을 수 없습니다. 키 이름만 필요하면 .env.example 을 넣으세요.`);
  if (!abs.startsWith(FRONT + path.sep)) fail(`${p} 는 frontend 폴더 밖의 파일입니다. 프론트 담당은 frontend 안의 파일만 넣습니다.`);
  if (!fs.existsSync(abs)) fail(`파일이 없습니다: frontend/${rel}  (경로와 대소문자를 확인하세요)`);
  if (fs.statSync(abs).isDirectory()) fail(`frontend/${rel} 는 폴더입니다. 파일을 골라 주세요.`);
  return rel;
}

// 키·토큰처럼 보이는 글자를 가린다 (대화창에 비밀 값이 들어가지 않게)
const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{20,}/g,
  /AIza[0-9A-Za-z_-]{35}/g,
  /eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\b[0-9a-f]{40,}\b/gi,
  /((?:api[_-]?key|secret|password|passwd|access[_-]?token)\s*[:=]\s*["'])([^"'\s]{12,})(["'])/gi,
];
function maskSecrets(text, where, warnings) {
  let out = text;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (...m) => {
      warnings.add(`${where}: 비밀 값처럼 보이는 글자를 [가림] 으로 바꿨습니다. 진짜 비밀 값이라면 코드에서 빼고 .env 로 옮기세요.`);
      return m.length > 5 && m[1] && m[3] ? `${m[1]}[가림]${m[3]}` : "[가림]";
    });
  }
  return out;
}

function fenceFor(text) {
  const runs = text.match(/`{3,}/g) || [];
  const n = Math.max(3, ...runs.map((r) => r.length + 1));
  return "`".repeat(n);
}

const LANG = { ".tsx": "tsx", ".ts": "ts", ".mjs": "js", ".js": "js", ".css": "css", ".json": "json", ".md": "md" };

function fileBlock(rel, numbered, warnings) {
  const raw = fs.readFileSync(path.join(FRONT, rel), "utf8");
  const text = maskSecrets(raw.replace(/\r\n/g, "\n"), `frontend/${rel}`, warnings);
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  const big = lines.length > BIG_FILE_LINES;
  const body = numbered ? lines.map((l, i) => `${String(i + 1).padStart(4)}| ${l}`).join("\n") : lines.join("\n");
  const fence = fenceFor(body);
  const head = `### frontend/${rel} (${lines.length}줄${big ? " · 큰 파일 — 답변 형식 4번을 따를 것" : ""})`;
  return { rel, lines: lines.length, big, md: `${head}\n${fence}${LANG[path.extname(rel)] || ""}\n${body}\n${fence}\n` };
}

function gitDiff() {
  const r = spawnSync("git", ["diff", "--no-color", "HEAD", "--", "."], { cwd: FRONT, encoding: "utf8" });
  if (r.status !== 0) return "(git diff 를 읽지 못했습니다)";
  return r.stdout.trim() || "(아직 바꾼 내용이 없습니다)";
}

// ── 만들기 ─────────────────────────────────────────────────────────────────
const o = parseArgs(process.argv.slice(2));
const warnings = new Set();
let files = [...new Set(o.files.map(normalize))];
if (o.types && files.some((f) => /\.(ts|tsx)$/.test(f)) && !files.includes("types/index.ts")) files.push("types/index.ts");

const blocks = files.map((f) => fileBlock(f, o.type === "explain", warnings));
const card = fs.readFileSync(path.join(HERE, "context-card.md"), "utf8");
const rules = RULES.map((r) => {
  const p = path.join(REPO, ".agents", "rules", r);
  // 규칙 파일의 제목을 한 단계 내려 '프로젝트 규칙' 아래에 들어가게 한다
  const body = fs.existsSync(p) ? fs.readFileSync(p, "utf8").trim().replace(/^(#+) /gm, "#$1 ") : "";
  return body ? `<!-- .agents/rules/${r} -->\n${body}` : "";
}).filter(Boolean).join("\n\n");
const template = fs.readFileSync(path.join(HERE, "templates", `${o.type}.md`), "utf8");
const done = o.done.length ? o.done.map((d) => `- ${d}`).join("\n") : "- (적지 않음 — 계획을 말할 때 완료 기준도 제안해 줘)";
const list = blocks.map((b) => `- \`frontend/${b.rel}\` (${b.lines}줄${b.big ? ", 큰 파일" : ""})`).join("\n");
const task = template.replace("{{TASK}}", o.task.trim()).replace("{{DONE}}", done).replace("{{FILES_LIST}}", list);

const parts = [
  "아래는 우리 프로젝트의 정보, 규칙, 이번 작업, 관련 파일입니다. 끝까지 읽은 뒤 맨 아래 '답변 형식'대로 답해 주세요.",
  card.trim(),
  `# 프로젝트 규칙 (원문)\n\n${rules}`,
  task.trim(),
  `# 관련 파일 (현재 내용 전체)\n\n${blocks.map((b) => b.md).join("\n")}`,
];
if (o.error) {
  const err = maskSecrets(readText(o.error).replace(/\x1b\[[0-9;]*m/g, "").trim(), o.error, warnings);
  const fence = fenceFor(err);
  parts.push(`# 증거 — 오류 메시지 그대로\n\n${fence}\n${err}\n${fence}`);
}
if (o.evidence) {
  const ev = maskSecrets(readText(o.evidence).trim(), o.evidence, warnings);
  const fence = fenceFor(ev);
  parts.push(`# 증거 — 내가 화면·콘솔·네트워크에서 본 것 그대로\n\n${fence}\n${ev}\n${fence}`);
}
if (o.diff) {
  const d = maskSecrets(gitDiff(), "git diff", warnings);
  const fence = fenceFor(d);
  parts.push(`# 증거 — 지금까지 바꾼 내용 (git diff)\n\n${fence}diff\n${d}\n${fence}`);
}
if (o.type !== "explain") parts.push(fs.readFileSync(path.join(HERE, "templates", "answer-format.md"), "utf8").trim());
else parts.push("# 답변 형식\n\n위 '설명 방식'대로 한국어로 설명해 주세요. 코드를 고친 파일은 주지 않습니다.");

const prompt = parts.join("\n\n---\n\n") + "\n";
const outAbs = path.resolve(FRONT, o.out);
fs.mkdirSync(path.dirname(outAbs), { recursive: true });
fs.writeFileSync(outAbs, prompt, "utf8");

// ── 알려 주기 ──────────────────────────────────────────────────────────────
const chars = prompt.length;
console.log(`\n✅ 프롬프트를 만들었습니다: frontend/${path.relative(FRONT, outAbs).replace(/\\/g, "/")}`);
console.log(`   유형: ${o.type} · 글자 수 ${chars.toLocaleString()} (토큰 약 ${Math.round(chars / 2.5).toLocaleString()}개, 어림)`);
console.log("   넣은 파일:");
for (const b of blocks) console.log(`     - frontend/${b.rel}  ${b.lines}줄${b.big ? "  ⚠️ 큰 파일" : ""}`);
if (o.error) console.log(`   증거: ${o.error}`);
if (o.evidence) console.log(`   증거: ${o.evidence}`);
if (o.diff) console.log("   증거: 지금까지 바꾼 내용(git diff)");
if (chars > WARN_CHARS) {
  console.log(`\n⚠️ 글이 깁니다(${chars.toLocaleString()}자). 대화창이 잘라 먹을 수 있습니다.`);
  console.log("   꼭 필요한 파일만 남기거나, 큰 파일 대신 그 파일을 쓰는 작은 파일을 넣어 보세요.");
}
for (const w of warnings) console.log(`\n⚠️ ${w}`);
console.log("\n다음 차례:");
console.log("  1) VS Code에서 위 파일을 열고 Ctrl+A → Ctrl+C");
console.log(o.type === "explain"
  ? "  2) 대화창에 붙여 넣고 보내기 → AI가 요약과 설명을 줍니다"
  : "  2) 대화창에 붙여 넣고 보내기 → AI가 먼저 '계획'을 말합니다");
console.log(o.type === "explain"
  ? "  3) 설명을 읽고, 설명대로인지 화면이나 코드에서 직접 확인해 보세요\n"
  : "  3) 계획이 맞으면 '진행' → 파일 전체를 받아 VS Code에 붙여 넣기 → npm run ai:check\n");
