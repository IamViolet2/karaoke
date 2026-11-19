"""
01_ping_backend.py
--------------------------------------------------------------------------------
[라즈베리파이 5 담당자를 위한 1단계 실습: 노래방 카운터(백엔드) 첫 인사 건네기]

* 목적: 라즈베리파이와 백엔드 컴퓨터 사이에 네트워크 통신선이 정상적으로 연결되었는지 확인합니다.
* 실행 방법:
    cd pi
    python 01_ping_backend.py
--------------------------------------------------------------------------------
"""

import os
import sys
import requests
from dotenv import load_dotenv

if sys.platform == "win32":
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

# 1. pi/.env 파일에서 백엔드 주소를 읽어옵니다.
load_dotenv()
BACKEND_URL = os.getenv("BACKEND_URL", "http://127.0.0.1:8000")

print("=" * 65)
print("🍓 [라즈베리파이 5] 노래방 카운터(백엔드)로 인사를 건넵니다...")
print(f"📍 연결 시도 주소: {BACKEND_URL}/api/devices")
print("=" * 65)

try:
    # 백엔드에 GET 요청으로 현재 등록된 디바이스 목록을 물어봅니다.
    response = requests.get(f"{BACKEND_URL}/api/devices", timeout=3)
    
    if response.status_code == 200:
        data = response.json().get("data", [])
        print("\n🎉 [성공 200 OK] 백엔드 카운터와 통신선이 완벽하게 연결되었습니다!")
        print(f"📦 카운터 장부에 등록된 노래방 부품 개수: {len(data)}개")
        print("\n[현재 등록된 노래방 부품 목록]")
        for dev in data:
            print(f"  - ID: {dev.get('id'):<15} | 이름: {dev.get('name'):<20} | 종류: {dev.get('kind')}")
        print("\n👉 축하합니다! 통신 기초가 확인되었으니 2단계(02_karaoke_daemon_mock.py)로 넘어가세요!\n")
    else:
        print(f"\n⚠️ [응답 코드 이상] 백엔드가 응답했지만 코드가 다릅니다: {response.status_code}")
        print("응답 본문:", response.text)

except requests.exceptions.ConnectionError:
    print("\n❌ [연결 실패: Connection Error]")
    print("백엔드 카운터 컴퓨터에 연결할 수 없습니다!")
    print("\n💡 [초보자를 위한 3초 해결 팁]")
    print(" 1. 백엔드 담당 친구가 uvicorn 서버를 실행했는지 확인하세요.")
    print(f" 2. pi/.env 의 BACKEND_URL({BACKEND_URL})에 친구 컴퓨터 IP가 맞는지 확인하세요.")
    print(" 3. 두 컴퓨터가 동일한 학교 Wi-Fi(공유기)에 연결되어 있는지 확인하세요.\n")

except requests.exceptions.Timeout:
    print("\n⏳ [연결 시간 초과: Timeout Error]")
    print("응답이 3초 이상 오지 않습니다. 방화벽이나 IP 주소를 다시 확인해 주세요.\n")

except Exception as e:
    print(f"\n⚠️ 기타 오류 발생: {e}\n")
