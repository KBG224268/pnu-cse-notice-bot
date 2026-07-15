"""최신 공지를 분석해 웹앱용 docs/notices.json을 처음 생성합니다."""

from __future__ import annotations

import argparse
import sys
import time

from main import (
    analyze_notice,
    load_notices,
    notice_to_web_record,
    save_web_notices,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--limit",
        type=int,
        default=15,
        help="처음 웹앱에 담을 최신 공지 개수 (기본 15)",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    limit = max(1, min(args.limit, 30))

    print(f"최신 공지 {limit}개를 웹앱 데이터로 만듭니다.")

    try:
        notices = load_notices(limit=limit)
    except Exception as exc:
        print(f"[공지 수집 오류] {exc}")
        sys.exit(1)

    records = []
    for index, notice in enumerate(notices, start=1):
        print(f"[{index}/{len(notices)}] {notice['title']}")
        analysis = analyze_notice(notice)
        records.append(notice_to_web_record(notice, analysis))
        # 학교 서버에 과도한 요청을 보내지 않도록 짧게 쉬어 갑니다.
        time.sleep(0.35)

    save_web_notices(records)
    print(f"완료: docs/notices.json에 {len(records)}개 저장")


if __name__ == "__main__":
    main()
