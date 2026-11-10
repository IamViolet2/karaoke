'use client';

// components/booth 폴더 경로에서 바로 불러옵니다.
import { KaraokeRoomSection } from '@/components/booth/KaraokeRoomSection';

export default function TestPage() {
  return (
    <main className="w-screen h-screen bg-black overflow-hidden">
      {/* 백엔드 연동 없이 UI 화면만 즉시 렌더링 */}
      <KaraokeRoomSection />
    </main>
  );
}