"""최근 공지를 즉시 분석해 보는 미리보기 도구.

사용:
    python preview_latest.py
    python preview_latest.py --discord
"""

from __future__ import annotations

import argparse
import sys

from main import (
    analyze_notice,
    load_notices,
    load_webhook_url,
    print_analysis,
    send_discord_notice,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="최근 정보컴퓨터공학부 공지를 1학년 기준으로 분석합니다."
    )
    parser.add_argument(
        "--count",
        type=int,
        default=3,
        help="터미널에서 확인할 최신 공지 개수(기본 3개)",
    )
    parser.add_argument(
        "--discord",
        action="store_true",
        help="가장 최신 공지 1개를 Discord에 미리보기로 전송",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    count = max(1, min(args.count, 10))

    try:
        notices = load_notices(limit=count)
    except Exception as exc:
        print(f"[공지 수집 오류] {exc}")
        sys.exit(1)

    if not notices:
        print("가져온 공지가 없습니다.")
        return

    analyses = []
    print(f"최신 공지 {len(notices)}개를 분석합니다.\n")

    for number, notice in enumerate(notices, start=1):
        print("=" * 64)
        print(f"{number}. {notice['title']}")
        print(notice["link"])
        analysis = analyze_notice(notice)
        print_analysis(analysis)
        analyses.append((notice, analysis))

    if not args.discord:
        print("\nDiscord 미리보기를 보내려면 다음처럼 실행하세요:")
        print("python preview_latest.py --discord")
        return

    notice, analysis = analyses[0]
    try:
        webhook_url = load_webhook_url()
        send_discord_notice(
            webhook_url,
            notice,
            analysis,
            preview=True,
        )
    except Exception as exc:
        print(f"\n[Discord 전송 오류] {exc}")
        sys.exit(1)

    print("\n가장 최신 공지의 Discord 미리보기를 보냈습니다!")
    print("seen_notices.json은 변경하지 않았습니다.")


if __name__ == "__main__":
    main()
