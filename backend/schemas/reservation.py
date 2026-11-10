
from typing import Optional

from pydantic import BaseModel, Field


class ReservationCreateRequest(BaseModel):
    """예약 신청 요청 스키마"""

    grade: int = Field(
        ...,
        ge=1,
        le=3,
        description="학년 (1~3)",
    )

    # DB 컬럼이 VARCHAR(50)이므로 길이를 제한한다.
    department: str = Field(
        ...,
        min_length=2,
        max_length=50,
        description="학과명",
    )

    student_name: str = Field(
        ...,
        min_length=2,
        max_length=50,
        description="신청자 이름",
    )

    user_count: int = Field(
        ...,
        ge=1,
        le=10,
        description="이용 인원 (최대 10명)",
    )

    reservation_date: str = Field(
        ...,
        pattern=r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$",
        description="예약 일자 (YYYY-MM-DD)",
    )

    time_slot: str = Field(
        ...,
        description="타임슬롯 ('lunch' 또는 'dinner')",
    )


class KeypadVerifyRequest(BaseModel):
    """4x4 키패드 비밀번호 검증 요청"""

    pin: str = Field(
        ...,
        pattern=r"^[0-9]{4}$",
        description="4자리 비밀번호 (숫자)",
    )


class ScoreRecordRequest(BaseModel):
    """채점 결과 저장 요청"""

    nickname: str = Field(
        "익명",
        max_length=20,
        description="부스에서 입력한 별명",
    )

    title: str = Field(
        ...,
        min_length=1,
        max_length=100,
        description="곡 제목",
    )

    singer: str = Field(
        ...,
        min_length=1,
        max_length=100,
        description="가수 이름",
    )

    score: int = Field(
        ...,
        ge=0,
        le=100,
        description="총점",
    )

    rank_label: Optional[str] = Field(
        None,
        max_length=20,
        description="등급 표시",
    )

    pitch: Optional[int] = Field(
        None,
        ge=0,
        le=100,
    )

    timing: Optional[int] = Field(
        None,
        ge=0,
        le=100,
    )

    volume: Optional[int] = Field(
        None,
        ge=0,
        le=100,
    )

    expression: Optional[int] = Field(
        None,
        ge=0,
        le=100,
    )


class SongRecordRequest(BaseModel):
    """노래 이력 등록 요청"""

    title: str = Field(
        ...,
        min_length=1,
        max_length=100,
        description="곡 제목",
    )

    singer: str = Field(
        ...,
        min_length=1,
        max_length=100,
        description="가수 이름",
    )


class SongVideoRequest(BaseModel):
    """곡에 노래방 영상을 등록하는 요청"""

    video_id: str = Field(
        ...,
        pattern=r"^[A-Za-z0-9_-]{11}$",
        description="유튜브 영상 ID (11자). 링크가 아니라 ID만 보낸다.",
    )
