from __future__ import annotations

import sys
from pathlib import Path

from docx import Document


OLD_RANGE = "Jun.2026 - Aug.2026"
NEW_RANGE = "May.2026 - Aug.2026"


def main() -> None:
    source = Path(sys.argv[1])
    destination = Path(sys.argv[2])
    document = Document(source)

    matching_paragraphs = [
        paragraph
        for paragraph in document.paragraphs
        if "TikTok" in paragraph.text and OLD_RANGE in paragraph.text
    ]
    if len(matching_paragraphs) != 1:
        raise RuntimeError(
            f"Expected exactly one TikTok paragraph containing {OLD_RANGE!r}; "
            f"found {len(matching_paragraphs)}"
        )

    paragraph = matching_paragraphs[0]
    jun_runs = [run for run in paragraph.runs if run.text == "Jun"]
    if len(jun_runs) != 1:
        raise RuntimeError(f"Expected exactly one 'Jun' run; found {len(jun_runs)}")

    jun_runs[0].text = "May"
    if OLD_RANGE in paragraph.text or NEW_RANGE not in paragraph.text:
        raise RuntimeError("The requested date replacement did not apply cleanly")

    destination.parent.mkdir(parents=True, exist_ok=True)
    document.save(destination)


if __name__ == "__main__":
    main()
