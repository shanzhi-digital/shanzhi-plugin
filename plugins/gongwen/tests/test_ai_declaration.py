"""默认不追加插件声明，并保留正文、修订及附注布局。"""
from io import BytesIO
from pathlib import Path
import sys
import tempfile
import unittest
from zipfile import ZipFile

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml.ns import qn
from lxml import etree

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from engine.core.document.generator import generate_docx
from engine.core.document.models import (
    DocumentModel, Paragraph, ParagraphFormat, Run, RunFormat, Table, TableCell,
)
from engine.core.document.tracked_annotator import inject_tracked_with_comments
from gongwen.md2docx_render import render_model_to_docx

PLUGIN_DECLARATION = "（内容由GongWen-skill-AI生成，仅供参考）"
NS = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}


def model_for(*texts):
    return DocumentModel(paragraphs=[
        Paragraph(index=i, text=text, role="body") for i, text in enumerate(texts)
    ])


class AiDeclarationTests(unittest.TestCase):
    def test_generation_defaults_and_legacy_false_never_append(self):
        for render in (generate_docx, render_model_to_docx):
            for kwargs in ({}, {"no_ai_declaration": False}, {"no_ai_declaration": True}):
                with self.subTest(render=render.__name__, kwargs=kwargs):
                    output = BytesIO()
                    render(model_for("普通正文"), output, **kwargs)
                    self.assertEqual([p.text for p in Document(output).paragraphs], ["普通正文"])

    def test_only_full_plugin_declaration_is_removed(self):
        preserved = [
            "以下数据仅供参考，请按实际情况执行。",
            "（内容由AI生成，仅供参考）",
            "引用文字：" + PLUGIN_DECLARATION,
            "[内容真实标记]",
        ]
        for render in (generate_docx, render_model_to_docx):
            with self.subTest(render=render.__name__):
                output = BytesIO()
                model = model_for(*preserved, PLUGIN_DECLARATION, PLUGIN_DECLARATION.lower())
                render(model, output)
                self.assertEqual([p.text for p in Document(output).paragraphs], preserved)
                self.assertEqual(len(model.paragraphs), len(preserved) + 2)

    def test_render_removal_keeps_table_anchor(self):
        model = model_for("前段", PLUGIN_DECLARATION, "后段")
        model.tables = [Table(index=0, rows=1, cols=1, insert_after_index=1,
                              cells=[TableCell(row=0, col=0, text="表格")])]
        output = BytesIO()
        render_model_to_docx(model, output)
        body = Document(output).element.body
        tags = [element.tag.split("}")[-1] for element in body]
        self.assertEqual(tags, ["p", "tbl", "p", "sectPr"])

    def test_tracked_output_keeps_changes_without_declaration(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.docx"
            output = Path(directory) / "tracked.docx"
            doc = Document()
            doc.add_paragraph("原始内容仅供参考。")
            doc.add_paragraph("（内容由AI生成，仅供参考）")
            doc.add_paragraph(PLUGIN_DECLARATION)
            doc.save(source)
            inject_tracked_with_comments(source, [{
                "para_index": 0,
                "original_text": "原始内容仅供参考。",
                "optimized_text": "更新内容仅供参考。",
            }], [], output)
            with ZipFile(output) as archive:
                root = etree.fromstring(archive.read("word/document.xml"))
            self.assertTrue(root.findall(".//w:ins", NS))
            self.assertTrue(root.findall(".//w:del", NS))
            all_text = "".join(root.itertext())
            self.assertIn("仅供参考", all_text)
            self.assertIn("（内容由AI生成，仅供参考）", all_text)
            self.assertNotIn(PLUGIN_DECLARATION, all_text)

    def test_note_default_style_and_literal_spaces(self):
        model = model_for("联系  人：张三")
        model.paragraphs[0].role = "note"
        output = BytesIO()
        render_model_to_docx(model, output)
        para = Document(output).paragraphs[0]
        self.assertEqual(para.text, "（联系  人：张三）")
        self.assertEqual(para.style.style_id, "GongwenLayout_note")
        self.assertEqual(para.alignment, WD_ALIGN_PARAGRAPH.LEFT)
        self.assertEqual(para.paragraph_format.first_line_indent.pt, 32)
        self.assertEqual(para.runs[0].font.size.pt, 16)
        self.assertEqual(para.runs[0]._element.rPr.rFonts.get(qn("w:eastAsia")), "仿宋_GB2312")
        self.assertEqual(model.paragraphs[0].text, "联系  人：张三")

    def test_note_config_and_run_format_are_preserved(self):
        model = model_for("（附注）")
        para = model.paragraphs[0]
        para.role = "note"
        para.runs = [Run(text="（附注）", format=RunFormat(strikethrough=True))]
        output = BytesIO()
        render_model_to_docx(model, output, rules={"note": {
            "font": "楷体_GB2312", "size": 14, "align": "left", "first_line_indent": "3em",
        }})
        rendered = Document(output).paragraphs[0]
        self.assertEqual(rendered.text, "（附注）")
        self.assertEqual(rendered.paragraph_format.first_line_indent.pt, 42)
        self.assertEqual(rendered.runs[0].font.size.pt, 14)
        self.assertTrue(rendered.runs[0].font.strike)

    def test_attachment_explicit_zero_indent_and_role(self):
        model = model_for("2. 附件续项")
        model.paragraphs[0].role = "attachment"
        model.paragraphs[0].format = ParagraphFormat(
            alignment="left", left_indent_pt=80, first_line_indent_pt=0,
        )
        for render in (generate_docx, render_model_to_docx):
            with self.subTest(render=render.__name__):
                output = BytesIO()
                render(model, output)
                para = Document(output).paragraphs[0]
                self.assertEqual(para.style.style_id, "GongwenLayout_attachment")
                self.assertEqual(para.paragraph_format.left_indent.pt, 80)
                self.assertEqual(para.paragraph_format.first_line_indent.pt, 0)

    def test_reordered_model_replaces_stale_plugin_roles(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.docx"
            doc = Document()
            from docx.enum.style import WD_STYLE_TYPE
            for role in ("attachment", "note", "signature", "date"):
                name = f"GongwenLayout_{role}"
                doc.styles.add_style(name, WD_STYLE_TYPE.PARAGRAPH)
                doc.add_paragraph("源段落", style=name)
            doc.add_paragraph("用户样式", style="Quote")
            doc.save(source)
            model = model_for("特此通知", "署名机关", "2026年11月13日", "（联系人）", "用户样式")
            for para, role in zip(model.paragraphs, ("body", "signature", "date", "note", "body")):
                para.role = role
            model.source_path = str(source)
            output = BytesIO()
            generate_docx(model, output)
            paragraphs = Document(output).paragraphs
            self.assertEqual([p.style.style_id for p in paragraphs], [
                "Normal", "GongwenLayout_signature", "GongwenLayout_date", "GongwenLayout_note", "Quote",
            ])

    def test_attachment_hanging_indent_is_valid_ooxml(self):
        model = model_for("附件：1. 多附件名称")
        model.paragraphs[0].role = "attachment"
        model.paragraphs[0].format = ParagraphFormat(
            alignment="left", left_indent_pt=112, first_line_indent_pt=-80,
        )
        for render in (generate_docx, render_model_to_docx):
            with self.subTest(render=render.__name__):
                output = BytesIO()
                render(model, output)
                para = Document(output).paragraphs[0]
                ind = para._element.pPr.find(qn("w:ind"))
                self.assertEqual(ind.get(qn("w:hanging")), "1600")
                self.assertIsNone(ind.get(qn("w:firstLine")))
                self.assertEqual(para.paragraph_format.left_indent.pt, 112)
                self.assertEqual(para.paragraph_format.first_line_indent.pt, -80)

    def test_generator_preserves_note_style_and_space_xml(self):
        model = model_for("（联系  人：张三） ")
        model.paragraphs[0].role = "note"
        model.paragraphs[0].format = ParagraphFormat(alignment="left", first_line_indent_pt=32)
        output = BytesIO()
        generate_docx(model, output)
        para = Document(output).paragraphs[0]
        self.assertEqual(para.style.style_id, "GongwenLayout_note")
        self.assertEqual(para.text, model.paragraphs[0].text)
        text = para._element.find(".//" + qn("w:t"))
        self.assertEqual(text.get(qn("xml:space")), "preserve")


if __name__ == "__main__":
    unittest.main()
