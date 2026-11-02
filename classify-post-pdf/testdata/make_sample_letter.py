# /// script
# requires-python = ">=3.11"
# dependencies = ["reportlab==5.0.1"]
# ///
"""Write testdata/sample-letter.pdf: a two-page letter from an invented sender.

Every name, address and number in it is made up. Run from this directory:
  uv run --script make_sample_letter.py
"""

from pathlib import Path

from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.pdfgen import canvas

OUT = Path(__file__).with_name("sample-letter.pdf")


def letter(c):
    width, height = A4
    top = height - 20 * mm

    c.setFont("Helvetica-Bold", 18)
    c.drawString(20 * mm, top, "Fenwick Valley Water")
    c.setFont("Helvetica", 9)
    c.drawString(20 * mm, top - 6 * mm, "PO Box 4417, Marshbridge, MB9 2QX")
    c.drawString(20 * mm, top - 10 * mm, "fenwickvalleywater.example")

    c.setFont("Helvetica", 11)
    lines = ["Ms Ada Example", "12 Heron Lane", "Little Sedgeworth", "MB4 7LP"]
    for i, line in enumerate(lines):
        c.drawString(20 * mm, top - 30 * mm - i * 5 * mm, line)

    right = width - 20 * mm
    c.drawRightString(right, top - 30 * mm, "Date: 14 October 2026")
    c.drawRightString(right, top - 35 * mm, "Account number: 7731 0042 19")
    c.drawRightString(right, top - 40 * mm, "Statement reference: FVW-ST-58213")

    c.setFont("Helvetica-Bold", 14)
    c.drawString(20 * mm, top - 60 * mm, "Your water statement")
    c.setFont("Helvetica", 11)
    body = [
        "Period: 1 April 2026 to 30 September 2026",
        "Amount due: GBP 184.62, by 4 November 2026",
        "This statement shows the charges for the period and your payments.",
    ]
    for i, line in enumerate(body):
        c.drawString(20 * mm, top - 70 * mm - i * 6 * mm, line)
    c.showPage()

    c.setFont("Helvetica", 11)
    c.drawString(20 * mm, top, "Page 2: how to pay. This page is made up too.")
    c.showPage()


def main():
    c = canvas.Canvas(str(OUT), pagesize=A4, invariant=1)
    c.setTitle("Sample letter (synthetic)")
    letter(c)
    c.save()
    print(OUT)


if __name__ == "__main__":
    main()
