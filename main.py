"""부산대학교 정보컴퓨터공학부 새 공지 감지 + 1학년 맞춤 분석 + Discord 알림."""

from __future__ import annotations

import json
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import feedparser
import requests
from bs4 import BeautifulSoup, Tag
from dotenv import load_dotenv


BASE_DIR = Path(__file__).resolve().parent
SEEN_FILE = BASE_DIR / "seen_notices.json"
ENV_FILE = BASE_DIR / ".env"
RSS_URL = "https://cse.pusan.ac.kr/bbs/cse/2055/rssList.do?row=50"
USER_AGENT = "PNU-CSE-Notice-Prototype/0.4 (personal study project)"

BODY_SELECTORS = [
    "._articleContent",
    ".artclViewCont",
    ".artclView .view-con",
    ".artclView .view_con",
    ".artclView .fr-view",
    ".board-view .view-content",
    ".bbs-view .view-content",
    ".view-content",
    "article",
]

DIRECT_KEYWORDS = [
    "1학년",
    "신입생",
    "새내기",
    "신입학",
    "기초학력",
    "신입생 오리엔테이션",
]

ACADEMIC_URGENT_KEYWORDS = [
    "수강신청",
    "수강정정",
    "수강취소",
    "증원",
    "폐강",
    "분반",
    "강의실 변경",
    "휴강",
    "보강",
    "시험",
    "성적",
    "장학",
]

GENERAL_STUDENT_KEYWORDS = [
    "학부생",
    "학부 재학생",
    "재학생",
    "학생 전체",
    "학과활동",
    "경진대회",
    "특강",
    "설명회",
    "행사",
    "설문",
    "모집",
]

EXPLICIT_EXCLUSION_PATTERNS = [
    r"1\s*학년\s*제외",
    r"(?:3|4)\s*학년\s*(?:대상|재학생|학생|만|이상)",
    r"대학원생\s*(?:대상|만|에\s*한함)",
    r"대학원\s*재학생\s*(?:대상|만|에\s*한함)",
    r"졸업예정자\s*(?:대상|만|에\s*한함)",
    r"학부연구생\s*(?:대상|만|에\s*한함)",
]

TARGET_WORDS = [
    "대상",
    "지원자격",
    "신청자격",
    "참가자격",
    "학부생",
    "재학생",
    "1학년",
    "신입생",
]

ACTION_WORDS = [
    "신청",
    "제출",
    "접수",
    "등록",
    "참여",
    "응시",
    "수강",
    "작성",
    "설문",
    "확인",
]

DEADLINE_WORDS = ["마감", "기한", "기간", "까지", "일시", "접수", "신청"]
DATE_PATTERN = re.compile(
    r"(?:20\d{2}\s*[.년/-]\s*)?"
    r"\d{1,2}\s*(?:[.월/-])\s*\d{1,2}\s*(?:일|\.)?"
    r"(?:\s*\([^)]{1,4}\))?"
)


@dataclass
class Analysis:
    relevance: str
    reason: str
    target: str
    action: str
    deadline: str
    summary: str
    body_text: str
    body_loaded: bool


def text(entry: Any, key: str, default: str = "") -> str:
    return str(entry.get(key, default)).strip()


def truncate(value: str, limit: int) -> str:
    value = value.strip()
    if len(value) <= limit:
        return value
    return value[: max(0, limit - 1)].rstrip() + "…"


def normalize_line(value: str) -> str:
    value = value.replace("\xa0", " ").replace("\u200b", "")
    return re.sub(r"\s+", " ", value).strip()


def clean_lines(raw_text: str) -> list[str]:
    lines: list[str] = []
    seen: set[str] = set()

    for raw_line in raw_text.splitlines():
        line = normalize_line(raw_line)
        if not line or line in seen:
            continue
        if line in {"목록", "이전글", "다음글", "URL 복사", "첨부파일"}:
            continue
        seen.add(line)
        lines.append(line)

    return lines


def load_notices(limit: int = 50) -> list[dict[str, str]]:
    feed = feedparser.parse(
        RSS_URL,
        request_headers={"User-Agent": USER_AGENT},
    )

    if getattr(feed, "bozo", False) and not feed.entries:
        error = getattr(feed, "bozo_exception", "알 수 없는 오류")
        raise RuntimeError(f"공지 RSS를 읽지 못했습니다: {error}")

    notices: list[dict[str, str]] = []
    for entry in feed.entries[:limit]:
        title = text(entry, "title", "제목 없음")
        link = text(entry, "link", RSS_URL)
        notices.append(
            {
                "id": link,
                "title": title,
                "link": link,
                "date": text(
                    entry,
                    "published",
                    text(entry, "updated", "날짜 없음"),
                ),
            }
        )
    return notices


def load_seen_ids() -> set[str]:
    if not SEEN_FILE.exists():
        return set()
    try:
        data = json.loads(SEEN_FILE.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        print("[경고] 저장 파일을 읽지 못해 새로 시작합니다.")
        return set()
    return {str(item) for item in data} if isinstance(data, list) else set()


def save_seen_ids(seen_ids: set[str]) -> None:
    SEEN_FILE.write_text(
        json.dumps(sorted(seen_ids), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def load_webhook_url() -> str:
    load_dotenv(ENV_FILE)
    webhook_url = os.getenv("DISCORD_WEBHOOK_URL", "").strip()
    if not webhook_url:
        raise RuntimeError(".env 파일에 DISCORD_WEBHOOK_URL이 없습니다.")
    if "/api/webhooks/" not in webhook_url:
        raise RuntimeError("웹훅 주소 형식이 올바르지 않습니다.")
    return webhook_url


def should_send_low_relevance() -> bool:
    load_dotenv(ENV_FILE)
    return os.getenv("SEND_LOW_RELEVANCE", "false").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


def element_text(element: Tag) -> str:
    return "\n".join(clean_lines(element.get_text("\n", strip=True)))


def choose_article_element(soup: BeautifulSoup) -> Tag | None:
    candidates: list[tuple[int, Tag]] = []

    for selector in BODY_SELECTORS:
        for element in soup.select(selector):
            candidate_text = element_text(element)
            if len(candidate_text) >= 40:
                candidates.append((len(candidate_text), element))

    if candidates:
        return max(candidates, key=lambda item: item[0])[1]

    attribute_pattern = re.compile(
        r"(?:article|artcl|board|bbs|view).*(?:cont|body|text)|"
        r"(?:cont|body|text).*(?:article|artcl|board|bbs|view)",
        re.IGNORECASE,
    )

    for element in soup.find_all(["div", "section", "article", "td"]):
        if not isinstance(element, Tag):
            continue
        attrs = " ".join(
            [
                str(element.get("id", "")),
                " ".join(element.get("class", [])),
            ]
        )
        if not attribute_pattern.search(attrs):
            continue
        candidate_text = element_text(element)
        if len(candidate_text) < 80:
            continue
        link_penalty = len(element.find_all("a")) * 25
        candidates.append((len(candidate_text) - link_penalty, element))

    if candidates:
        return max(candidates, key=lambda item: item[0])[1]

    return soup.find("main") or soup.find("body")


def fetch_article_body(url: str) -> str:
    response = requests.get(
        url,
        headers={"User-Agent": USER_AGENT},
        timeout=20,
    )
    response.raise_for_status()

    if not response.encoding or response.encoding.lower() in {
        "iso-8859-1",
        "latin-1",
    }:
        response.encoding = response.apparent_encoding or "utf-8"

    soup = BeautifulSoup(response.text, "html.parser")
    for unwanted in soup.find_all(
        ["script", "style", "noscript", "svg", "nav", "header", "footer", "form"]
    ):
        unwanted.decompose()

    article = choose_article_element(soup)
    if article is None:
        raise RuntimeError("공지 본문 영역을 찾지 못했습니다.")

    article_text = element_text(article)
    if len(article_text) < 20:
        raise RuntimeError("공지 본문이 너무 짧거나 비어 있습니다.")

    return truncate(article_text, 12000)


def find_best_line(
    lines: list[str],
    words: list[str],
    *,
    require_date: bool = False,
    prefer_action: bool = False,
) -> str:
    best_line = ""
    best_score = -1

    for line in lines:
        if len(line) < 4:
            continue
        keyword_hits = sum(1 for word in words if word in line)
        if keyword_hits == 0:
            continue
        has_date = bool(DATE_PATTERN.search(line))
        if require_date and not has_date:
            continue
        date_bonus = 3 if require_date and has_date else 0
        action_bonus = 0
        if prefer_action:
            action_bonus += sum(2 for word in ["제출", "작성", "등록", "응시", "참여", "접속", "클릭"] if word in line)
            if re.search(r"(?:하세요|해야|바랍니다|필수|완료)", line):
                action_bonus += 2
            if "기간" in line or "일시" in line:
                action_bonus -= 2
        length_penalty = max(0, len(line) - 180) // 40
        score = keyword_hits * 3 + date_bonus + action_bonus - length_penalty
        if score > best_score:
            best_line = line
            best_score = score

    return truncate(best_line, 240) if best_line else ""


def build_summary(lines: list[str], action: str, deadline: str) -> str:
    pieces: list[str] = []
    if action:
        pieces.append(action)
    if deadline and deadline != action:
        pieces.append(deadline)
    if pieces:
        return truncate(" / ".join(pieces), 360)

    for line in lines:
        if len(line) >= 12 and not line.startswith(("분류 ", "작성일 ", "작성자 ", "조회수 ")):
            return truncate(line, 360)

    return "본문에서 핵심 문장을 자동으로 찾지 못했습니다. 원문을 확인하세요."


def classify_relevance(title: str, body_text: str, body_loaded: bool) -> tuple[str, str]:
    combined = normalize_line(f"{title} {body_text}")

    direct_hits = [word for word in DIRECT_KEYWORDS if word in combined]
    urgent_hits = [word for word in ACADEMIC_URGENT_KEYWORDS if word in combined]
    general_hits = [word for word in GENERAL_STUDENT_KEYWORDS if word in combined]
    exclusions = [
        pattern
        for pattern in EXPLICIT_EXCLUSION_PATTERNS
        if re.search(pattern, combined)
    ]

    if exclusions and not direct_hits:
        return "낮음", "1학년이 아닌 특정 대상만 명시된 공지"

    if direct_hits:
        return "높음", f"1학년 직접 관련 표현: {', '.join(direct_hits[:3])}"

    if urgent_hits:
        return "높음", f"학사·수업 핵심 표현: {', '.join(urgent_hits[:3])}"

    if general_hits:
        return "보통", f"학부생 공통 가능성: {', '.join(general_hits[:3])}"

    if not body_loaded:
        return "보통", "본문을 읽지 못해 제목 기준으로 안전하게 알림"

    return "보통", "1학년 제외가 명시되지 않아 안전하게 알림"


def analyze_notice(notice: dict[str, str]) -> Analysis:
    body_text = ""
    body_loaded = False

    try:
        body_text = fetch_article_body(notice["link"])
        body_loaded = True
    except requests.RequestException as exc:
        print(f"  [본문 수집 경고] 네트워크 오류: {exc}")
    except Exception as exc:
        print(f"  [본문 분석 경고] {exc}")

    lines = clean_lines(body_text)
    relevance, reason = classify_relevance(
        notice["title"],
        body_text,
        body_loaded,
    )

    target = find_best_line(lines, TARGET_WORDS)
    action = find_best_line(lines, ACTION_WORDS, prefer_action=True)
    deadline = find_best_line(lines, DEADLINE_WORDS, require_date=True)
    summary = build_summary(lines, action, deadline)

    return Analysis(
        relevance=relevance,
        reason=reason,
        target=target or "본문에서 명확히 찾지 못함",
        action=action or "원문 확인 필요",
        deadline=deadline or "본문에서 명확히 찾지 못함",
        summary=summary,
        body_text=body_text,
        body_loaded=body_loaded,
    )


def send_discord_notice(
    webhook_url: str,
    notice: dict[str, str],
    analysis: Analysis,
    *,
    preview: bool = False,
) -> None:
    colors = {"높음": 0xE74C3C, "보통": 0xF1C40F, "낮음": 0x95A5A6}
    heading = "🧪 미리보기" if preview else "📢 새 공지"

    embed = {
        "title": truncate(notice["title"], 256),
        "url": notice["link"],
        "description": truncate(analysis.summary, 1000),
        "color": colors.get(analysis.relevance, 0x3498DB),
        "fields": [
            {
                "name": "🎯 1학년 관련도",
                "value": truncate(f"{analysis.relevance} · {analysis.reason}", 1024),
                "inline": False,
            },
            {
                "name": "👤 대상",
                "value": truncate(analysis.target, 1024),
                "inline": False,
            },
            {
                "name": "✅ 해야 할 일",
                "value": truncate(analysis.action, 1024),
                "inline": False,
            },
            {
                "name": "⏰ 마감·일정",
                "value": truncate(analysis.deadline, 1024),
                "inline": False,
            },
        ],
        "footer": {
            "text": f"게시일: {truncate(notice['date'], 80)} · 규칙 기반 분석이므로 원문도 확인하세요."
        },
    }

    response = requests.post(
        webhook_url,
        json={
            # 혼자 쓰는 서버에서 휴대폰 푸시가 더 확실히 울리도록
            # @everyone 멘션을 포함합니다.
            "content": f"@everyone {heading} · 정보컴퓨터공학부",
            "username": "PNU CSE 공지봇",
            "allowed_mentions": {"parse": ["everyone"]},
            "embeds": [embed],
        },
        timeout=15,
    )

    if response.status_code not in (200, 204):
        raise RuntimeError(
            f"Discord 전송 실패: HTTP {response.status_code} "
            f"{response.text[:200]}"
        )


def print_analysis(analysis: Analysis) -> None:
    print(f"  관련도: {analysis.relevance}")
    print(f"  판단 이유: {analysis.reason}")
    print(f"  대상: {analysis.target}")
    print(f"  해야 할 일: {analysis.action}")
    print(f"  마감·일정: {analysis.deadline}")


def main() -> None:
    print("=" * 64)
    print("부산대학교 정보컴퓨터공학부 1학년 맞춤 공지 확인")
    print("=" * 64)

    try:
        notices = load_notices(limit=50)
    except Exception as exc:
        print(f"\n[공지 수집 오류]\n{exc}")
        sys.exit(1)

    if not notices:
        print("\n가져온 공지가 없습니다.")
        return

    seen_ids = load_seen_ids()
    current_ids = {notice["id"] for notice in notices}

    if not SEEN_FILE.exists():
        save_seen_ids(current_ids)
        print("\n첫 실행입니다.")
        print(f"현재 공지 {len(notices)}개를 기준점으로 저장했습니다.")
        print("다음 실행부터 새 공지를 분석해 Discord로 보냅니다.")
        return

    new_notices = [notice for notice in notices if notice["id"] not in seen_ids]
    if not new_notices:
        print("\n새로운 공지가 없습니다.")
        return

    new_notices.reverse()
    print(f"\n새 공지 {len(new_notices)}개를 분석합니다!")

    send_low = should_send_low_relevance()
    processed_ids: set[str] = set()
    sent_count = 0
    webhook_url: str | None = None

    for notice in new_notices:
        print(f"\n- {notice['title']}")
        analysis = analyze_notice(notice)
        print_analysis(analysis)

        if analysis.relevance == "낮음" and not send_low:
            print("  Discord 전송 생략: 1학년 관련도가 낮음")
            processed_ids.add(notice["id"])
            continue

        try:
            if webhook_url is None:
                webhook_url = load_webhook_url()
            send_discord_notice(webhook_url, notice, analysis)
        except Exception as exc:
            print(f"  Discord 전송 실패: {exc}")
            continue

        processed_ids.add(notice["id"])
        sent_count += 1
        print("  Discord 전송 성공!")

    save_seen_ids(seen_ids | processed_ids)
    print(
        f"\n처리 완료: {len(processed_ids)}/{len(new_notices)}개, "
        f"Discord 전송 {sent_count}개"
    )


if __name__ == "__main__":
    main()
