import io
import json
import unittest
import shutil
import tempfile
import subprocess
from pathlib import Path
from unittest.mock import patch

from render_document_visuals import visual_pages, slide_visual_indexes


class VisualDocumentTest(unittest.TestCase):
    def test_pdf_with_vector_flowchart(self):
        import fitz
        document = fitz.open()
        page = document.new_page(width=400, height=300)
        for x in (20, 125, 230):
            page.draw_rect(fitz.Rect(x, 70, x + 85, 125), color=(0, 0, 0))
        page.draw_line((105, 96), (125, 96), color=(0, 0, 0))
        page.draw_line((210, 96), (230, 96), color=(0, 0, 0))
        data = document.tobytes()
        visual = visual_pages(data, ".pdf", 30)
        self.assertEqual(len(visual), 1)
        self.assertEqual(visual[0]["locator"], "Page 1")
        self.assertTrue(len(visual[0]["image"]) > 100)
        self.assertEqual(visual_pages(data, ".pdf", 30)[0]["locator"], "Page 1")
        with self.assertRaisesRegex(ValueError, "Split it into smaller"):
            visual_pages(data, ".pdf", 0)

    def test_pdf_text_only_does_not_trigger_vision(self):
        import fitz
        document = fitz.open()
        page = document.new_page(width=300, height=300)
        page.insert_text((40, 40), "Lecture on variables and loops", fontsize=14)
        self.assertEqual(visual_pages(document.tobytes(), ".pdf", 30), [])

    def test_pptx_detects_flowchart_shapes(self):
        from pptx import Presentation
        from pptx.enum.shapes import MSO_SHAPE
        from pptx.util import Inches
        deck = Presentation()
        slide = deck.slides.add_slide(deck.slide_layouts[6])
        slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Inches(1), Inches(1), Inches(2), Inches(1))
        slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Inches(4), Inches(1), Inches(2), Inches(1))
        deck.slides.add_slide(deck.slide_layouts[6])
        output = io.BytesIO()
        deck.save(output)
        self.assertEqual(slide_visual_indexes(output.getvalue(), ".pptx"), [0])

    @unittest.skipUnless(shutil.which("soffice") or shutil.which("libreoffice"), "LibreOffice unavailable")
    def test_rendered_pptx_and_legacy_ppt_preserve_slide_locator(self):
        from pptx import Presentation
        from pptx.enum.shapes import MSO_SHAPE
        from pptx.util import Inches
        from extract_document import extract
        deck = Presentation()
        slide = deck.slides.add_slide(deck.slide_layouts[6])
        rectangle = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Inches(1), Inches(1), Inches(2), Inches(1))
        rectangle.text = "Start"
        next_rect = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Inches(4), Inches(1), Inches(2), Inches(1))
        next_rect.text = "End"
        with tempfile.TemporaryDirectory() as tmp:
            src = Path(tmp) / "flow.pptx"
            deck.save(str(src))
            visuals = visual_pages(src.read_bytes(), ".pptx", 30)
            self.assertEqual(len(visuals), 1)
            self.assertEqual(visuals[0]["locator"], "Slide 1")
            binary = "soffice" if shutil.which("soffice") else "libreoffice"
            proc = subprocess.run([binary, "-env:UserInstallation=" + (Path(tmp)/"profile-convert").as_uri(),
                                   "--headless", "--convert-to", "ppt:MS PowerPoint 97",
                                   "--outdir", tmp, str(src)], stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, timeout=25)
            legacy = Path(tmp) / "flow.ppt"
            self.assertEqual(proc.returncode, 0, proc.stderr.decode(errors="replace"))
            self.assertTrue(legacy.exists())
            converted_text = extract(legacy.read_bytes(), ".ppt", include_empty=True)
            self.assertEqual(converted_text["units"][0]["locator"], "Slide 1")
            self.assertIn("Start", converted_text["units"][0]["text"])
            converted_visual = visual_pages(legacy.read_bytes(), ".ppt", 30)
            self.assertEqual(converted_visual[0]["locator"], "Slide 1")

    def test_legacy_ppt_rejects_non_ole(self):
        with self.assertRaisesRegex(ValueError, "not a legacy PowerPoint"):
            visual_pages(b"invalid ppt", ".ppt", 30)


if __name__ == "__main__":
    unittest.main(verbosity=2)
