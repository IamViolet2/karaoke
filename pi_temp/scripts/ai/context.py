"""
context.py — 대화창 AI에 붙여 넣을 프롬프트를 만든다 (라즈베리파이 담당용)

대화창 AI는 우리 저장소를 볼 수 없다. 그래서 프로젝트 카드 · 규칙 원문 · 작업 카드 · 관련 파일 전체 ·
오류 같은 증거 · 답변 형식을 한 파일(pi/.ai/prompt.md)로 모아 준다. 학생은 그 파일을 열어 전부 복사해 붙여 넣는다.
설치할 것 없이 파이썬만 있으면 된다 (Windows PC, 라즈베리파이 모두).

  cd pi
  python scripts/ai/context.py --type feature --task "하고 싶은 것" --done "완료 기준" --files main.py
  python scripts/ai/context.py --type bugfix  --task "증상" --error .ai/last-error.txt --files main.py
  python scripts/ai/context.py --type wiring  --task "연결하고 싶은 부품" --files booth_pins.py
  python scripts/ai/context.py --type explain --task "알고 싶은 것" --files main.py

옵션: --type feature|bugfix|wiring|explain · --task 글 · --task-file 파일 · --done 글(여러 번) · --files 경로...
      --error 파일(오류 메시지) · --evidence 파일(터미널 출력·부품이 한 일) · --diff(지금까지 바꾼 내용)
      --no-pins(booth_pins.py 자동 포함 끄기) · --out 경로
"""

from __future__ import annotations

import io
import re
import subprocess
import sys
from pathlib import Path

if sys.platform == "win32":
    # Windows 터미널에서 한글·이모지가 깨지거나 오류가 나지 않게 한다
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

HERE = Path(__file__).resolve().parent
PI = HERE.parent.parent                 # pi/
REPO = PI.parent
RULES = ["karpathy-principles.md", "hardware-rules.md", "coding-standards.md", "security-rules.md"]
PINS_FILE = "booth_pins.py"
BIG_FILE_LINES = 400
WARN_CHARS = 60000
TYPES = ["feature", "bugfix", "wiring", "explain"]
LANG = {".py": "python", ".md": "md", ".txt": "text", ".sh": "bash", ".service": "ini", ".json": "json"}


def fail(msg: str) -> None:
    print(f"\n❌ {msg}\n", file=sys.stderr)
    sys.exit(1)


# ── 옵션 읽기 ──────────────────────────────────────────────────────────────
def parse_args(argv: list[str]) -> dict:
    o = {"type": "feature", "task": "", "done": [], "files": [], "error": None, "evidence": None,
         "diff": False, "pins": True, "out": ".ai/prompt.md"}
    i = 0
    while i < len(argv):
        a = argv[i]

        def nxt() -> str:
            nonlocal i
            if i + 1 >= len(argv):
                fail(f"{a} 뒤에 값이 없습니다.")
            i += 1
            return argv[i]

        if a == "--type":
            o["type"] = nxt()
        elif a == "--task":
            o["task"] = nxt()
        elif a == "--task-file":
            o["task"] = read_text(nxt())
        elif a == "--done":
            o["done"].append(nxt())
        elif a == "--error":
            o["error"] = nxt()
        elif a == "--evidence":
            o["evidence"] = nxt()
        elif a == "--diff":
            o["diff"] = True
        elif a == "--no-pins":
            o["pins"] = False
        elif a == "--out":
            o["out"] = nxt()
        elif a == "--files":
            while i + 1 < len(argv) and not argv[i + 1].startswith("--"):
                i += 1
                o["files"].append(argv[i])
        elif a in ("-h", "--help"):
            print(__doc__)
            sys.exit(0)
        else:
            fail(f"모르는 옵션입니다: {a}  (도움말: python scripts/ai/context.py --help)")
        i += 1

    if o["type"] not in TYPES:
        fail(f"--type 은 {' / '.join(TYPES)} 중 하나입니다.")
    if not o["task"].strip():
        fail('--task "하고 싶은 것(또는 증상·궁금한 점)" 을 적어 주세요.')
    if not o["files"]:
        fail("--files 로 관련 파일을 한 개 이상 골라 주세요. (매뉴얼의 '기능 → 파일 지도' 참고)")
    return o


def read_text(p: str) -> str:
    # 지금 폴더 기준으로 먼저 찾고, 없으면 pi 폴더 기준으로 찾는다
    for base in (Path.cwd(), PI):
        f = (base / p).resolve()
        if f.is_file():
            return f.read_text(encoding="utf-8", errors="replace")
    fail(f"파일이 없습니다: {p}")
    return ""


# ── 파일 경로: pi/ 기준으로 맞추고, 비밀 파일은 거절한다 ───────────────────
def normalize(p: str) -> str:
    rel = p.replace("\\", "/")
    if rel.startswith("./"):
        rel = rel[2:]
    if rel.startswith("pi/"):
        rel = rel[3:]
    f = (PI / rel).resolve()
    if re.search(r"(^|/)\.env(?!\.example$)", rel):
        fail(f"{p} 는 비밀 값이 들어 있는 .env 파일이라 넣을 수 없습니다. 키 이름만 필요하면 .env.example 을 넣으세요.")
    try:
        rel = f.relative_to(PI).as_posix()
    except ValueError:
        fail(f"{p} 는 pi 폴더 밖의 파일입니다. 파이 담당은 pi 안의 파일만 넣습니다.")
    if re.match(r"(venv|\.venv|__pycache__)/", rel):
        fail(f"{p} 는 가상환경·캐시 파일입니다. 우리가 쓴 코드만 넣습니다.")
    if not f.exists():
        fail(f"파일이 없습니다: pi/{rel}  (경로와 대소문자를 확인하세요. pi 폴더에서 실행했나요?)")
    if f.is_dir():
        fail(f"pi/{rel} 는 폴더입니다. 파일을 골라 주세요.")
    return rel


# 키·토큰처럼 보이는 글자를 가린다 (대화창에 비밀 값이 들어가지 않게)
SECRET_PATTERNS = [
    re.compile(r"sk-[A-Za-z0-9_-]{20,}"),
    re.compile(r"AIza[0-9A-Za-z_-]{35}"),
    re.compile(r"eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}"),
    re.compile(r"\b[0-9a-f]{40,}\b", re.I),
    # 코드 안: api_key = "…", "X-Device-Api-Key": "…"
    re.compile(r"""((?:api[_-]?key|secret|password|passwd|access[_-]?token|x-device-api-key)["']?\s*[:=]\s*["'])([^"'\s]{8,})(["'])""", re.I),
    # .env 모양: DEVICE_API_KEY=값 (예시 값 your_… 는 두고)
    re.compile(r"^(\s*[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*\s*=\s*)(?!your_)([A-Za-z0-9_.\-]{8,})()\s*$", re.M),

]
# 터미널 출력(증거)에만: main.py 가 시작할 때 찍는 '출입증(API키) : booth-********' 의 앞 글자까지 가린다
LOG_PATTERNS = [re.compile(r"(출입증\(API키\)\s*:\s*)([^\s{]+)()")]


def mask_secrets(text: str, where: str, warnings: list[str], log: bool = False) -> str:
    if log:
        # 오류 글 속 경로에서 컴퓨터 사용자 이름을 지운다 (C:\Users\이름 → ~, /home/이름 → ~)
        text = re.sub(r"[A-Za-z]:\\Users\\[^\\\s]+", "~", text)
        text = re.sub(r"/home/[^/\s]+", "~", text)
    for pat in SECRET_PATTERNS + (LOG_PATTERNS if log else []):
        def repl(m: re.Match) -> str:
            msg = f"{where}: 비밀 값처럼 보이는 글자를 [가림] 으로 바꿨습니다. 진짜 비밀 값이라면 코드에서 빼고 .env 로 옮기세요."
            if msg not in warnings:
                warnings.append(msg)
            if m.re.groups >= 3:
                return f"{m.group(1)}[가림]{m.group(3)}"
            return "[가림]"
        text = pat.sub(repl, text)
    return text


def fence_for(text: str) -> str:
    runs = re.findall(r"`{3,}", text)
    return "`" * max([3] + [len(r) + 1 for r in runs])


def file_block(rel: str, numbered: bool, warnings: list[str]) -> dict:
    raw = (PI / rel).read_text(encoding="utf-8", errors="replace").replace("\r\n", "\n")
    text = mask_secrets(raw, f"pi/{rel}", warnings)
    lines = text[:-1].split("\n") if text.endswith("\n") else text.split("\n")
    big = len(lines) > BIG_FILE_LINES
    body = "\n".join(f"{i + 1:4d}| {l}" for i, l in enumerate(lines)) if numbered else "\n".join(lines)
    fence = fence_for(body)
    head = f"### pi/{rel} ({len(lines)}줄{' · 큰 파일 — 답변 형식 4번을 따를 것' if big else ''})"
    lang = LANG.get(Path(rel).suffix, "")
    return {"rel": rel, "lines": len(lines), "big": big, "md": f"{head}\n{fence}{lang}\n{body}\n{fence}\n"}


def git_diff() -> str:
    try:
        r = subprocess.run(["git", "diff", "--no-color", "HEAD", "--", "."], cwd=PI,
                           capture_output=True, text=True, encoding="utf-8", errors="replace")
    except FileNotFoundError:
        return "(git 이 없어 바꾼 내용을 읽지 못했습니다)"
    if r.returncode != 0:
        return "(git diff 를 읽지 못했습니다)"
    return r.stdout.strip() or "(아직 바꾼 내용이 없습니다)"


def main() -> None:
    o = parse_args(sys.argv[1:])
    warnings: list[str] = []
    files: list[str] = []
    for f in o["files"]:
        rel = normalize(f)
        if rel not in files:
            files.append(rel)
    # 파이썬 파일을 넣으면 핀 배치(booth_pins.py)를 함께 넣는다 — 핀이 겹치지 않게 하려면 AI도 알아야 한다
    if o["pins"] and any(f.endswith(".py") for f in files) and PINS_FILE not in files and (PI / PINS_FILE).exists():
        files.append(PINS_FILE)
    if o["type"] == "wiring" and PINS_FILE not in files and (PI / PINS_FILE).exists():
        files.append(PINS_FILE)

    blocks = [file_block(f, o["type"] == "explain", warnings) for f in files]
    card = (HERE / "context-card.md").read_text(encoding="utf-8")
    rule_parts = []
    for r in RULES:
        p = REPO / ".agents" / "rules" / r
        if p.exists():
            # 규칙 파일의 제목을 한 단계 내려 '프로젝트 규칙' 아래에 들어가게 한다
            body = re.sub(r"^(#+) ", r"#\1 ", p.read_text(encoding="utf-8").strip(), flags=re.M)
            rule_parts.append(f"<!-- .agents/rules/{r} -->\n{body}")
    template = (HERE / "templates" / f"{o['type']}.md").read_text(encoding="utf-8")
    if o["done"]:
        done = "\n".join(f"- {d}" for d in o["done"])
    else:
        done = "- (적지 않음 — 계획을 말할 때 완료 기준도 제안해 줘)"
    listing = "\n".join(f"- `pi/{b['rel']}` ({b['lines']}줄{', 큰 파일' if b['big'] else ''})" for b in blocks)
    task = template.replace("{{TASK}}", o["task"].strip()).replace("{{DONE}}", done).replace("{{FILES_LIST}}", listing)

    parts = [
        "아래는 우리 프로젝트의 정보, 규칙, 이번 작업, 관련 파일입니다. 끝까지 읽은 뒤 맨 아래 '답변 형식'대로 답해 주세요.",
        card.strip(),
        "# 프로젝트 규칙 (원문)\n\n" + "\n\n".join(rule_parts),
        task.strip(),
        "# 관련 파일 (현재 내용 전체)\n\n" + "\n".join(b["md"] for b in blocks),
    ]
    if o["error"]:
        err = re.sub(r"\x1b\[[0-9;]*m", "", read_text(o["error"])).strip()
        err = mask_secrets(err, o["error"], warnings, log=True)
        fence = fence_for(err)
        parts.append(f"# 증거 — 오류 메시지 그대로\n\n{fence}\n{err}\n{fence}")
    if o["evidence"]:
        ev = mask_secrets(read_text(o["evidence"]).strip(), o["evidence"], warnings, log=True)
        fence = fence_for(ev)
        parts.append(f"# 증거 — 내가 터미널·화면·부품에서 본 것 그대로\n\n{fence}\n{ev}\n{fence}")
    if o["diff"]:
        d = mask_secrets(git_diff(), "git diff", warnings)
        fence = fence_for(d)
        parts.append(f"# 증거 — 지금까지 바꾼 내용 (git diff)\n\n{fence}diff\n{d}\n{fence}")
    if o["type"] == "explain":
        parts.append("# 답변 형식\n\n위 '설명 방식'대로 한국어로 설명해 주세요. 코드를 고친 파일은 주지 않습니다.")
    elif o["type"] == "wiring":
        parts.append("# 답변 형식\n\n위 '답하는 방식'대로 한국어로 답해 주세요. 배선표는 표로 주세요. 코드 파일은 주지 않습니다.")
    else:
        parts.append((HERE / "templates" / "answer-format.md").read_text(encoding="utf-8").strip())

    prompt = "\n\n---\n\n".join(parts) + "\n"
    out = (PI / o["out"]).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(prompt, encoding="utf-8")

    # ── 알려 주기 ──────────────────────────────────────────────────────────
    chars = len(prompt)
    try:
        shown = "pi/" + out.relative_to(PI).as_posix()
    except ValueError:
        shown = str(out)
    print(f"\n✅ 프롬프트를 만들었습니다: {shown}")
    print(f"   유형: {o['type']} · 글자 수 {chars:,} (토큰 약 {round(chars / 2.5):,}개, 어림)")
    print("   넣은 파일:")
    for b in blocks:
        print(f"     - pi/{b['rel']}  {b['lines']}줄{'  ⚠️ 큰 파일' if b['big'] else ''}")
    if o["error"]:
        print(f"   증거: {o['error']}")
    if o["evidence"]:
        print(f"   증거: {o['evidence']}")
    if o["diff"]:
        print("   증거: 지금까지 바꾼 내용(git diff)")
    if chars > WARN_CHARS:
        print(f"\n⚠️ 글이 깁니다({chars:,}자). 대화창이 잘라 먹을 수 있습니다.")
        print("   꼭 필요한 파일만 남기세요. 설명이 필요하면 파일 하나씩 물어보세요.")
    for w in warnings:
        print(f"\n⚠️ {w}")
    print("\n다음 차례:")
    print("  1) VS Code에서 위 파일을 열고 Ctrl+A → Ctrl+C")
    if o["type"] == "explain":
        print("  2) 대화창에 붙여 넣고 보내기 → AI가 요약과 설명을 줍니다")
        print("  3) 설명을 읽고, 설명대로인지 코드나 실행 결과에서 직접 확인해 보세요\n")
    elif o["type"] == "wiring":
        print("  2) 대화창에 붙여 넣고 보내기 → AI가 배선표와 주의할 점을 줍니다")
        print("  3) 핀이 겹치지 않는지 booth_pins.py와 비교하고, 선생님께 배선표를 확인받은 뒤 전원을 뽑고 연결하세요\n")
    else:
        print("  2) 대화창에 붙여 넣고 보내기 → AI가 먼저 '계획'을 말합니다")
        print("  3) 계획이 맞으면 '진행' → 파일 전체를 받아 VS Code에 붙여 넣기 → python scripts/ai/check.py\n")


if __name__ == "__main__":
    main()
