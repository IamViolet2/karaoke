"""
check.py — AI가 준 코드를 붙여 넣은 뒤 점검한다 (라즈베리파이 담당용)

    cd pi
    python scripts/ai/check.py

코드를 고치지는 않는다. pi 폴더에서 바뀐 파일을 살펴 다음을 알려 준다.
  1) 바뀐 파일과 늘어난/지워진 줄 수 — 생각보다 많이 지워졌으면 AI가 코드를 빠뜨렸을 수 있다
  2) 생략 흔적 — "# ...", "# 기존 코드 동일" 처럼 AI가 코드를 줄여 쓴 자리
  3) 잘못 붙여 넣은 것 — 답변의 ``` 나 "### 파일:" 머리말, 줄 번호, 나눠 받은 조각 표시
  4) 파이썬 문법·들여쓰기 오류, 정의되지 않은 이름(오타), RPi.GPIO 사용, 코드에 적힌 비밀 값
  5) 핀 배치(booth_pins.py) — 같은 핀을 두 부품이 쓰는지, BCM 번호가 맞는지
  6) 가짜 핀(mock)으로 main.py 의 부품을 실제로 만들어 보고 안전 상태·정리까지 해 본다
오류는 .ai/last-error.txt 로 저장해 context.py --type bugfix --error .ai/last-error.txt 로 바로 물어볼 수 있게 한다.
"""

from __future__ import annotations

import ast
import builtins
import io
import os
import re
import subprocess
import symtable
import sys
from pathlib import Path

if sys.platform == "win32":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

PI = Path(__file__).resolve().parent.parent.parent
PINS_FILE = "booth_pins.py"
SKIP = re.compile(r"^(\.ai/|scripts/ai/|venv/|\.venv/|__pycache__/)|\.pyc$|(^|/)\.env$")

OMISSION = [
    (re.compile(r"^\s*#\s*(\.{3}|…)"), "주석이 '...'로 시작합니다"),
    (re.compile(r"^\s*(\.{3}|…)\s*$"), "'...' 만 있는 줄입니다 (AI가 생략한 자리일 수 있습니다)"),
    (re.compile(r"(기존|이전|위와|아래와|나머지|이하|원래|앞과|위의)\s*(코드|내용|부분|로직|구현|함수|클래스|메서드)?\s*(와|과|은|는)?\s*(동일|같음|같습니다|그대로|생략|유지)"),
     "'기존과 동일·나머지 그대로' 같은 생략 표시입니다"),
    (re.compile(r"#.*(생략|중략)\s*(됨|함|합니다)?\s*\)?\s*$"), "'생략' 표시입니다"),
    (re.compile(r"#.*\b(rest of (the )?(code|file|class|function)|existing code|unchanged|same as (before|above)|omitted for brevity)\b", re.I),
     "영어 생략 표시입니다"),
]
PASTE_MISTAKE = [
    (re.compile(r"^\s*```"), "답변의 ``` 표시까지 붙여 넣었습니다"),
    (re.compile(r"^\s*###\s*파일\s*:"), "답변의 '### 파일:' 머리말까지 붙여 넣었습니다"),
    (re.compile(r"^\s*\d{1,4}\|\s"), "줄 번호(예: '  12| ')까지 붙여 넣었습니다"),
]
PART = re.compile(r"=====\s*(여기까지|파일 끝)\s*\((\d+)/(\d+)\)")

GPIOZERO_DEVICES = {
    "LED", "PWMLED", "RGBLED", "Buzzer", "TonalBuzzer", "Motor", "Servo", "AngularServo",
    "OutputDevice", "DigitalOutputDevice", "PWMOutputDevice", "Button", "LineSensor", "MotionSensor",
    "LightSensor", "DistanceSensor", "DigitalInputDevice", "SmoothedInputDevice", "InputDevice",
}
SECRET_NAME = re.compile(r"(KEY|TOKEN|SECRET|PASSWORD|PASSWD)", re.I)

problems = 0
cautions = 0
error_texts: list[str] = []


def bad(msg: str) -> str:
    global problems
    problems += 1
    return f"❌ {msg}"


def warn(msg: str) -> str:
    global cautions
    cautions += 1
    return f"⚠️ {msg}"


def git(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], cwd=PI, capture_output=True, text=True, encoding="utf-8", errors="replace")


# ── 파이썬 검사들 ─────────────────────────────────────────────────────────
def syntax_check(rel: str, src: str) -> tuple[ast.AST | None, list[str]]:
    try:
        tree = ast.parse(src, filename=rel)
        compile(src, rel, "exec")
        return tree, []
    except SyntaxError as e:
        kind = type(e).__name__
        if kind == "TabError":
            why = "탭과 스페이스가 섞였습니다. 그 줄의 들여쓰기를 스페이스 4칸으로 다시 맞추세요"
        elif kind == "IndentationError":
            why = "들여쓰기가 맞지 않습니다. 붙여 넣을 때 앞 칸이 밀렸거나, 조각을 이어 붙인 자리가 어긋났을 수 있습니다"
        else:
            why = "파이썬 문법 오류입니다"
        line = (e.text or "").rstrip("\n")
        error_texts.append(f"[문법 검사] pi/{rel}, {e.lineno}번째 줄\n{kind}: {e.msg}\n    {line.strip()}")
        return None, [bad(f"{e.lineno}번째 줄 — {why} ({kind}: {e.msg})")]


def undefined_names(rel: str, src: str, tree: ast.AST) -> list[str]:
    """오타나 빠뜨린 import 로 정의되지 않은 이름을 찾는다 (실행해야 나는 NameError 를 미리)."""
    if any(isinstance(n, ast.ImportFrom) and any(a.name == "*" for a in n.names) for n in ast.walk(tree)):
        return []
    top = symtable.symtable(src, rel, "exec")
    defined = set(dir(builtins)) | {"__file__", "__name__", "__doc__", "__builtins__", "__spec__",
                                    "__loader__", "__package__", "__path__", "__annotations__"}

    def is_defined_here(s: symtable.Symbol) -> bool:
        return s.is_assigned() or s.is_imported() or s.is_namespace()

    for s in top.get_symbols():
        if is_defined_here(s):
            defined.add(s.get_name())

    def collect_globals(t: symtable.SymbolTable) -> None:
        for s in t.get_symbols():
            if s.is_declared_global() and s.is_assigned():
                defined.add(s.get_name())
        for c in t.get_children():
            collect_globals(c)

    collect_globals(top)
    missing: set[str] = set()

    def walk(t: symtable.SymbolTable, is_top: bool) -> None:
        for s in t.get_symbols():
            name = s.get_name()
            if not s.is_referenced() or name in defined:
                continue
            if is_top and not is_defined_here(s):
                missing.add(name)
            elif not is_top and s.is_global():
                missing.add(name)
        for c in t.get_children():
            walk(c, False)

    walk(top, True)
    found = sorted((min((n.lineno for n in ast.walk(tree) if isinstance(n, ast.Name) and n.id == name), default=0), name)
                   for name in missing)
    notes = []
    for line, name in found[:6]:
        notes.append(bad(f"{line}번째 줄 — '{name}' 이라는 이름이 어디에도 없습니다 (오타이거나 import·정의를 빠뜨림). 실행하면 NameError"))
    if len(found) > 6:
        notes.append(bad(f"… 이런 이름이 {len(found) - 6}개 더 있습니다. 나눠 받은 조각이 빠졌거나 파일 앞부분이 없는 것 아닌지 보세요"))
    for line, name in found:
        error_texts.append(f"[이름 검사] pi/{rel}, {line}번째 줄\nNameError(예상): name '{name}' is not defined")
    return notes


def call_name(node: ast.Call) -> str:
    f = node.func
    if isinstance(f, ast.Name):
        return f.id
    if isinstance(f, ast.Attribute):
        return f.attr
    return ""


def pi_rules(rel: str, tree: ast.AST) -> list[str]:
    notes = []
    for n in ast.walk(tree):
        # RPi.GPIO 는 라즈베리파이 5에서 동작하지 않는다
        if isinstance(n, ast.Import) and any(a.name.split(".")[0] == "RPi" for a in n.names):
            notes.append(bad(f"{n.lineno}번째 줄 — RPi.GPIO 는 라즈베리파이 5에서 동작하지 않습니다. gpiozero 로 바꿔 달라고 하세요"))
        if isinstance(n, ast.ImportFrom) and (n.module or "").split(".")[0] == "RPi":
            notes.append(bad(f"{n.lineno}번째 줄 — RPi.GPIO 는 라즈베리파이 5에서 동작하지 않습니다. gpiozero 로 바꿔 달라고 하세요"))
        # 핀 번호는 booth_pins.py 에만
        if rel != PINS_FILE and isinstance(n, ast.Call) and call_name(n) in GPIOZERO_DEVICES:
            pin_arg = n.args[0] if n.args else next((k.value for k in n.keywords if k.arg == "pin"), None)
            if isinstance(pin_arg, ast.Constant) and isinstance(pin_arg.value, int) and not isinstance(pin_arg.value, bool):
                notes.append(warn(f"{n.lineno}번째 줄 — 핀 번호 {pin_arg.value} 을(를) 코드에 바로 적었습니다. booth_pins.py 에 상수로 두고 pins.이름 으로 쓰세요"))
        # 비밀 값을 코드에 적지 않는다
        if isinstance(n, ast.Assign) and isinstance(n.value, ast.Constant) and isinstance(n.value.value, str) and len(n.value.value) >= 8:
            for t in n.targets:
                if isinstance(t, ast.Name) and SECRET_NAME.search(t.id):
                    notes.append(bad(f"{n.lineno}번째 줄 — {t.id} 에 비밀 값을 바로 적었습니다. pi/.env 에 두고 os.getenv(\"{t.id}\") 로 읽으세요"))
        if isinstance(n, ast.Dict):
            for k, v in zip(n.keys, n.values):
                if (isinstance(k, ast.Constant) and isinstance(k.value, str) and k.value.lower() == "x-device-api-key"
                        and isinstance(v, ast.Constant) and isinstance(v.value, str) and v.value):
                    notes.append(bad(f"{n.lineno}번째 줄 — 장치 키를 코드에 바로 적었습니다. DEVICE_API_KEY 를 .env 에서 읽어 쓰세요"))
        if (isinstance(n, ast.Call) and call_name(n) == "getenv" and len(n.args) >= 2
                and isinstance(n.args[0], ast.Constant) and isinstance(n.args[0].value, str) and SECRET_NAME.search(n.args[0].value)
                and isinstance(n.args[1], ast.Constant) and isinstance(n.args[1].value, str) and len(n.args[1].value) >= 8):
            notes.append(warn(f"{n.lineno}번째 줄 — {n.args[0].value} 의 기본값으로 비밀 값처럼 보이는 글자를 적었습니다. 기본값은 \"\" 로 두고 .env 에서만 넣으세요"))
        # 실기기 데몬이 가짜 핀으로 고정되면 진짜 부품이 움직이지 않는다
        if rel == "main.py" and isinstance(n, ast.Constant) and n.value == "mock":
            notes.append(warn(f"{n.lineno}번째 줄 — main.py 안에 'mock' 이 있습니다. 가짜 핀으로 고정하면 실기기에서 부품이 움직이지 않습니다. "
                              "가짜 핀은 실행할 때 GPIOZERO_PIN_FACTORY=mock 으로만 켜세요"))
    return notes


# ── 핀 배치 검사 ──────────────────────────────────────────────────────────
SPECIAL = {2: "I2C", 3: "I2C", 7: "SPI", 8: "SPI", 9: "SPI", 10: "SPI", 11: "SPI", 14: "UART", 15: "UART"}


def pin_map_check() -> list[str]:
    f = PI / PINS_FILE
    if not f.exists():
        return []
    try:
        tree = ast.parse(f.read_text(encoding="utf-8"))
    except SyntaxError:
        return []  # 문법 오류는 위에서 이미 알렸다
    uses: dict[int, list[str]] = {}
    for n in tree.body:
        if not (isinstance(n, ast.Assign) and len(n.targets) == 1 and isinstance(n.targets[0], ast.Name)):
            continue
        name = n.targets[0].id
        vals: list[int] = []
        if name.endswith("_PIN") and isinstance(n.value, ast.Constant) and isinstance(n.value.value, int):
            vals = [n.value.value]
        elif name.endswith("_PINS") and isinstance(n.value, (ast.List, ast.Tuple)):
            vals = [e.value for e in n.value.elts if isinstance(e, ast.Constant) and isinstance(e.value, int)]
        for v in vals:
            uses.setdefault(v, []).append(name)
    notes = []
    for pin, names in sorted(uses.items()):
        if len(names) > 1:
            notes.append(bad(f"GPIO{pin} 을(를) {', '.join(names)} 가 함께 씁니다. 실행하면 GPIOPinInUse 오류가 납니다 — 비어 있는 핀으로 바꾸세요"))
            error_texts.append(f"[핀 검사] pi/{PINS_FILE}\nGPIO{pin} 중복: {', '.join(names)}")
        if not 0 <= pin <= 27:
            notes.append(bad(f"{names[0]} = {pin} — BCM 번호는 0~27 입니다. 물리 핀 번호(1~40)를 적은 것은 아닌지 확인하세요"))
        elif pin in (0, 1):
            notes.append(bad(f"{names[0]} = {pin} — GPIO0·1 은 HAT 정보용이라 쓰지 않습니다"))
        elif pin in SPECIAL:
            notes.append(warn(f"{names[0]} = {pin} — GPIO{pin} 은 {SPECIAL[pin]} 통신과 같이 쓰는 핀입니다. {SPECIAL[pin]} 를 쓸 계획이 없을 때만 쓰세요"))
    if not notes:
        notes.append(f"✅ 핀 {sum(len(v) for v in uses.values())}개, 겹침 없음")
    return notes


# ── 가짜 핀(mock)으로 main.py 부품 만들어 보기 ───────────────────────────
MOCK_PROBE = r"""
import os, sys
sys.path.insert(0, os.getcwd())
try:
    import gpiozero  # noqa: F401
except ImportError:
    print("@@NO_MODULE gpiozero"); sys.exit(4)
try:
    import main
except ModuleNotFoundError as e:
    print("@@NO_MODULE " + str(e.name)); sys.exit(4)
if not hasattr(main, "BoothHardware"):
    print("@@NO_CLASS"); sys.exit(5)
hw = main.BoothHardware()
hw.safe_state()
if hasattr(main, "actuator_ids"):
    print("@@IDS " + ",".join(main.actuator_ids()))
hw.close()
print("@@OK")
"""
ENV_MODULES = {"gpiozero", "requests", "dotenv", "lgpio"}


def short_paths(text: str) -> str:
    """오류 글의 긴 경로를 줄인다 — 짧아지고, 컴퓨터 사용자 이름도 대화창에 들어가지 않는다."""
    text = text.replace(str(PI) + os.sep, "pi/").replace(str(PI), "pi")
    text = re.sub(r'File "[^"]*?site-packages[\\/]', 'File "…/site-packages/', text)
    text = re.sub(r"[A-Za-z]:\\Users\\[^\\\s]+", "~", text)
    return re.sub(r"/home/[^/\s]+", "~", text)


def mock_startup() -> list[str]:
    env = dict(os.environ, GPIOZERO_PIN_FACTORY="mock", PYTHONIOENCODING="utf-8", PYTHONDONTWRITEBYTECODE="1")
    try:
        r = subprocess.run([sys.executable, "-c", MOCK_PROBE], cwd=PI, env=env, capture_output=True,
                           text=True, encoding="utf-8", errors="replace", timeout=60)
    except subprocess.TimeoutExpired:
        error_texts.append("[가짜 핀 시동 검사] 60초 안에 끝나지 않았습니다. BoothHardware() 를 만들 때 멈추는 코드가 있습니다.")
        return [bad("가짜 핀 시동 검사: 60초 안에 끝나지 않았습니다. 부품을 만드는 코드(__init__)에 기다리는 줄이 있는지 보세요")]
    out = short_paths(r.stdout + r.stderr)
    m = re.search(r"@@NO_MODULE (\S+)", out)
    if m:
        mod = m.group(1)
        if mod in ENV_MODULES:
            return [warn(f"가짜 핀 시동 검사를 건너뜀 — 이 컴퓨터에 {mod} 가 없습니다. "
                         "PC라면 pip install gpiozero requests python-dotenv, 파이라면 가상환경(venv)을 켜고 다시 실행하세요")]
        error_texts.append(f"[가짜 핀 시동 검사] import main 실패\nModuleNotFoundError: No module named '{mod}'")
        return [bad(f"가짜 핀 시동 검사: '{mod}' 모듈이 없습니다. requirements.txt 에 없는 패키지를 AI가 쓴 것인지 확인하세요")]
    if "@@NO_CLASS" in out:
        return [warn("가짜 핀 시동 검사를 건너뜀 — main.py 에 BoothHardware 클래스가 없습니다")]
    if "@@OK" in out:
        ids = re.search(r"@@IDS (.*)", out)
        tail = f" · 폴링할 액추에이터: {ids.group(1)}" if ids else ""
        return [f"✅ 가짜 핀 시동 검사: 부품 만들기 → 안전 상태 → 정리 통과{tail}"]
    lines = [l for l in out.strip().splitlines() if not l.startswith("@@") and "PinFactoryFallback" not in l]
    error_texts.append("[가짜 핀 시동 검사] GPIOZERO_PIN_FACTORY=mock 으로 main.BoothHardware() 를 만들다 난 오류\n" + "\n".join(lines))
    last = lines[-1] if lines else "(출력 없음)"
    return [bad(f"가짜 핀 시동 검사: {last}")]


def main() -> None:
    st = git("status", "--porcelain", "-uall", "--", ".")
    if st.returncode != 0:
        print("\n❌ git 저장소의 pi 폴더에서 실행해 주세요 (cd pi → python scripts/ai/check.py).\n")
        sys.exit(1)
    prefix = git("rev-parse", "--show-prefix").stdout.strip()  # 보통 "pi/"
    changed = []
    for line in [l for l in st.stdout.split("\n") if l]:
        code = line[:2]
        f = line[3:].strip('"')
        if " -> " in f:
            f = f.split(" -> ")[1]
        if prefix and f.startswith(prefix):
            f = f[len(prefix):]
        if SKIP.search(f) or "D" in code:
            continue
        changed.append((f, code == "??" or "A" in code))

    print("\n🔎 AI 코드 붙여넣기 점검 (라즈베리파이)\n")
    if not changed:
        print("바뀐 파일이 없습니다. 붙여 넣은 뒤 파일을 저장(Ctrl+S)했는지 확인하세요.\n")
        sys.exit(0)

    py_changed = []
    report = []
    for rel, is_new in changed:
        p = PI / rel
        if not p.is_file():
            report.append(f"• pi/{rel}")
            continue
        text = p.read_text(encoding="utf-8", errors="replace")
        lines = text.splitlines()
        added, removed, before = len(lines), 0, 0
        if not is_new:
            ns = git("diff", "--numstat", "HEAD", "--", rel).stdout.split()
            added = int(ns[0]) if ns and ns[0].isdigit() else 0
            removed = int(ns[1]) if len(ns) > 1 and ns[1].isdigit() else 0
            old = git("show", f"HEAD:{prefix}{rel}")
            before = len(old.stdout.splitlines()) if old.returncode == 0 else 0
        notes = []
        for i, l in enumerate(lines, 1):
            for pat, why in OMISSION:
                if pat.search(l):
                    notes.append(bad(f"{i}번째 줄 — {why}: {l.strip()[:70]}"))
                    break
            for pat, why in PASTE_MISTAKE:
                if pat.search(l):
                    notes.append(bad(f"{i}번째 줄 — {why}"))
                    break
        # 나눠 받은 큰 파일: 조각 표시가 1, 2, …, n 순서로 모두 있는지
        parts = [(PART.search(l), i) for i, l in enumerate(lines, 1)]
        parts = [(m, i) for m, i in parts if m]
        if parts:
            total = int(parts[0][0].group(3))
            nums = [int(m.group(2)) for m, _ in parts]
            ok = len(nums) == total and nums == list(range(1, total + 1)) and "파일 끝" in parts[-1][0].group(1)
            if ok:
                notes.append(warn(f"나눠 받은 조각 {total}개가 순서대로 다 붙었습니다. 확인이 끝나면 조각 표시 줄"
                                  f"({', '.join(str(i) for _, i in parts)}번째 줄)을 지우세요."))
            else:
                notes.append(bad(f"나눠 받은 조각이 빠졌거나 순서가 틀립니다 (붙은 조각: {', '.join(map(str, nums))} / 전체 {total}개)."))
        if not is_new and removed >= 15 and removed > before * 0.25:
            notes.append(warn(f"{removed}줄이 지워졌습니다(원래 {before}줄). 계획에 없던 삭제라면 AI가 코드를 빠뜨린 것입니다 — VS Code 소스 제어에서 빨간 줄을 확인하세요."))
        if not is_new and removed > added * 3 and removed >= 10:
            notes.append(warn("늘어난 줄보다 지워진 줄이 훨씬 많습니다. 파일 일부만 붙여 넣지 않았는지 확인하세요."))
        if rel.endswith(".py"):
            py_changed.append(rel)
            if any(l.startswith("\t") for l in lines):
                notes.append(warn("탭으로 들여쓴 줄이 있습니다. 이 프로젝트는 스페이스 4칸을 씁니다 (VS Code 오른쪽 아래 '들여쓰기'에서 바꿀 수 있습니다)."))
            tree, syn = syntax_check(rel, text)
            notes += syn
            if tree is not None:
                notes += undefined_names(rel, text, tree)
                notes += pi_rules(rel, tree)
        report.append(f"• pi/{rel} " + (f"(새 파일, {len(lines)}줄)" if is_new else f"(+{added} −{removed})"))
        report += [f"    {n}" for n in notes]
    print("\n".join(report))

    print("\n📌 핀 배치 (booth_pins.py)")
    for n in pin_map_check():
        print(f"    {n}")

    if py_changed and (PI / "main.py").exists():
        print("\n⏳ 가짜 핀(mock)으로 main.py 의 부품을 만들어 보는 중…")
        main_ok = True
        try:
            compile((PI / "main.py").read_text(encoding="utf-8"), "main.py", "exec")
        except SyntaxError:
            main_ok = False
        for n in (mock_startup() if main_ok else [warn("main.py 에 문법 오류가 있어 가짜 핀 시동 검사를 건너뜁니다")]):
            print(f"    {n}")

    err_file = PI / ".ai" / "last-error.txt"
    if error_texts:
        err_file.parent.mkdir(parents=True, exist_ok=True)
        err_file.write_text("\n\n".join(error_texts) + "\n", encoding="utf-8")
        print("\n오류 내용은 pi/.ai/last-error.txt 에 저장했습니다. AI에게 물어보려면:")
        files = " ".join(py_changed) or "<고친 파일>"
        print(f'   python scripts/ai/context.py --type bugfix --task "붙여 넣은 뒤 이런 오류가 납니다" --error .ai/last-error.txt --files {files}')
    elif err_file.exists():
        err_file.unlink()

    print("")
    if problems:
        print("❌ 고칠 것이 있습니다. 위 ❌ 줄부터 해결하세요.")
        print("   생략·붙여넣기 문제는 AI에게 '생략 없이 파일 전체를 다시 달라'고 하거나, 붙여 넣기를 다시 하세요.")
    else:
        print("⚠️ 오류는 없습니다. ⚠️ 줄을 직접 확인하세요." if cautions else "✅ 문제를 찾지 못했습니다.")
        print("   이제 가짜 핀으로 실행해 터미널 출력과 관리자 화면을 눈으로 확인하세요. 실기기는 그다음, 선생님과 함께.")
    print("")
    sys.exit(1 if problems else 0)


if __name__ == "__main__":
    main()
