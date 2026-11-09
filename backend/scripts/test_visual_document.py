import io
import json
import unittest
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

    def test_legacy_ppt_rejects_non_ole(self):
        with self.assertRaisesRegex(ValueError, "not a legacy PowerPoint"):
            visual_pages(b"invalid ppt", ".ppt", 30)


if __name__ == "__main__":
    unittest.main(verbosity=2)
