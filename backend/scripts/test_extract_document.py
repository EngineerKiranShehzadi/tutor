#!/usr/bin/env python3
"""Offline regression tests for multi-format document extraction."""
import io
import sys
import unittest
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from extract_document import extract, zip_guard


class TestDocumentExtractor(unittest.TestCase):
    def test_plain_text(self):
        result = extract(b"Variables = values\nPython is readable", ".txt")
        self.assertEqual(result["units"][0]["locator"], "Document")
        self.assertIn("Variables = values", result["units"][0]["text"])

    def test_html_strips_scripts_and_navigation(self):
        html = b"""<html><nav>NOT IN LESSON</nav><main><h1>Loops</h1>
        <p>For loops repeat a block.</p><script>secret()</script>
        <table><tr><th>Keyword</th><th>Meaning</th></tr>
        <tr><td>for</td><td>iteration</td></tr></table></main></html>"""
        result = extract(html, ".html")
        text = result["units"][0]["text"]
        self.assertIn("Loops", text)
        self.assertIn("For loops repeat", text)
        self.assertIn("for | iteration", text)
        self.assertNotIn("secret()", text)
        self.assertNotIn("NOT IN LESSON", text)

    def test_html_utf8(self):
        result = extract("Urdu: پروگرامنگ".encode("utf-8"), ".html")
        self.assertIn("پروگرامنگ", result["units"][0]["text"])

    def test_docx_extracts_paragraphs_and_tables(self):
        from docx import Document
        document = Document()
        document.add_heading("Data Types", 1)
        document.add_paragraph("A list is a mutable sequence.")
        table = document.add_table(rows=1, cols=2)
        table.cell(0, 0).text = "list"
        table.cell(0, 1).text = "mutable"
        stream = io.BytesIO()
        document.save(stream)
        result = extract(stream.getvalue(), ".docx")
        text = result["units"][0]["text"]
        self.assertIn("Data Types", text)
        self.assertIn("A list is a mutable sequence.", text)
        self.assertIn("list | mutable", text)

    def test_pptx_slide_provenance(self):
        from pptx import Presentation
        from pptx.util import Inches
        prs = Presentation()
        slide = prs.slides.add_slide(prs.slide_layouts[5])
        textbox = slide.shapes.add_textbox(Inches(1), Inches(1), Inches(5), Inches(1))
        textbox.text = "Functions let us reuse instructions."
        stream = io.BytesIO()
        prs.save(stream)
        result = extract(stream.getvalue(), ".pptx")
        self.assertEqual(result["units"][0]["locator"], "Slide 1")
        self.assertIn("Functions let us reuse", result["units"][0]["text"])

    def test_pdf_text_and_page_number(self):
        # Test PDF contains standard Helvetica font and a small literal text stream.
        from pypdf import PdfWriter
        from pypdf.generic import (
            DictionaryObject, NameObject, DecodedStreamObject, NumberObject,
        )
        writer = PdfWriter()
        page = writer.add_blank_page(width=300, height=300)
        font = DictionaryObject({
            NameObject("/Type"): NameObject("/Font"),
            NameObject("/Subtype"): NameObject("/Type1"),
            NameObject("/BaseFont"): NameObject("/Helvetica"),
        })
        font_ref = writer._add_object(font)
        resources = DictionaryObject({
            NameObject("/Font"): DictionaryObject({NameObject("/F1"): font_ref})
        })
        page[NameObject("/Resources")] = resources
        stream = DecodedStreamObject()
        stream.set_data(b"BT /F1 12 Tf 50 200 Td (Python variables hold values) Tj ET")
        page[NameObject("/Contents")] = writer._add_object(stream)
        out = io.BytesIO()
        writer.write(out)
        result = extract(out.getvalue(), ".pdf")
        self.assertEqual(result["units"][0]["locator"], "Page 1")
        self.assertIn("Python variables hold values", result["units"][0]["text"])

    def test_image_only_pdf_is_not_accepted_as_empty_knowledge(self):
        from pypdf import PdfWriter
        writer = PdfWriter()
        writer.add_blank_page(width=200, height=200)
        out = io.BytesIO()
        writer.write(out)
        with self.assertRaisesRegex(ValueError, "No selectable text"):
            extract(out.getvalue(), ".pdf")

    def test_wrong_file_signature_rejected(self):
        with self.assertRaisesRegex(ValueError, "not a PDF"):
            extract(b"This is not a PDF", ".pdf")

    def test_unsupported_format_rejected(self):
        with self.assertRaisesRegex(ValueError, "Unsupported"):
            extract(b"any text", ".exe")

    def test_invalid_zip_rejected(self):
        with self.assertRaisesRegex(ValueError, "not a valid"):
            zip_guard(b"not a zip")

    def test_too_many_archive_entries_rejected(self):
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, "w") as archive:
            for i in range(501):
                archive.writestr(f"part_{i}.xml", "test")
        with self.assertRaisesRegex(ValueError, "too many"):
            zip_guard(stream.getvalue())

    def test_large_upload_rejected(self):
        with self.assertRaisesRegex(ValueError, "10 MB"):
            extract(b"x" * (10 * 1024 * 1024 + 1), ".txt")


if __name__ == "__main__":
    unittest.main(verbosity=2)
