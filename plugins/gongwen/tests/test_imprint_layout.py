"""版记及版头文号的真实 DOCX / OOXML 回归测试。"""
from pathlib import Path
import sys
import tempfile
import unittest
from zipfile import ZipFile

from docx import Document
from docx.enum.style import WD_STYLE_TYPE
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from lxml import etree

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from engine.inject import inject_footer, inject_header


NS = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
IMPRINT_STYLES = {
    "GongwenLayout_cc", "GongwenLayout_imprint", "GongwenLayout_imprint_separator",
}


class ImprintLayoutTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        self.path = Path(self.temp_dir.name) / "版记测试.docx"
        doc = Document()
        doc.add_paragraph("正文保留[2026]，编号0007。")
        doc.add_paragraph("附件：1. 工作安排")
        doc.add_paragraph("附件1")
        doc.add_paragraph("工作安排的实际正文。")
        doc.add_table(rows=1, cols=1).cell(0, 0).text = "附件末尾表格内容"
        doc.save(self.path)
        self.config = {"cc": "测试单位", "printer": "测试办公室", "print_date": "2026年11月12日"}

    def body(self):
        with ZipFile(self.path) as archive:
            return etree.fromstring(archive.read("word/document.xml")).find("w:body", NS)

    @staticmethod
    def style(paragraph):
        return paragraph.find("w:pPr/w:pStyle", NS).get(qn("w:val"))

    def marked(self, body=None):
        if body is None:
            body = self.body()
        return [p for p in body.findall("w:p", NS)
                if p.find("w:pPr/w:pStyle", NS) is not None and self.style(p) in IMPRINT_STYLES]

    @staticmethod
    def text(element):
        return "".join(element.itertext())

    def test_three_rules_are_black_single_lines_with_8_6_8_widths(self):
        inject_footer(str(self.path), self.config)
        block = self.marked()
        self.assertEqual([self.style(p) for p in block], [
            "GongwenLayout_imprint_separator", "GongwenLayout_cc",
            "GongwenLayout_imprint_separator", "GongwenLayout_imprint",
            "GongwenLayout_imprint_separator",
        ])
        lines = [p.find("w:pPr/w:pBdr/w:top", NS) for p in block
                 if self.style(p) == "GongwenLayout_imprint_separator"]
        self.assertEqual([line.get(qn("w:sz")) for line in lines], ["8", "6", "8"])
        for line in lines:
            self.assertEqual(line.get(qn("w:val")), "single")
            self.assertEqual(line.get(qn("w:color")), "000000")
            self.assertEqual(line.get(qn("w:space")), "0")
        self.assertIn("抄送：测试单位。", self.text(block[1]))
        self.assertIn("测试办公室", self.text(block[3]))
        self.assertIn("2026年11月12日印发", self.text(block[3]))

    def test_imprint_follows_actual_attachment_and_final_table(self):
        original_body = self.body()
        original_content = [etree.tostring(child) for child in original_body if child.tag != qn("w:sectPr")]
        inject_footer(str(self.path), self.config)
        body = self.body()
        self.assertEqual([etree.tostring(child) for child in list(body)[:len(original_content)]], original_content)
        self.assertEqual(list(body)[len(original_content)], self.marked(body)[0])
        self.assertEqual(list(body)[-1].tag, qn("w:sectPr"))

    def test_explicit_spacing_and_keep_chain_allow_layout_engine_to_paginate(self):
        inject_footer(str(self.path), self.config)
        block = self.marked()
        for index, paragraph in enumerate(block):
            props = paragraph.find("w:pPr", NS)
            spacing = props.find("w:spacing", NS)
            self.assertEqual(spacing.get(qn("w:before")), "660" if index == 0 else "0")
            self.assertEqual(spacing.get(qn("w:after")), "0")
            self.assertEqual(spacing.get(qn("w:lineRule")), "exact")
            self.assertEqual(props.find("w:keepNext", NS).get(qn("w:val")), "0" if index == len(block) - 1 else None)
            self.assertIsNotNone(props.find("w:keepLines", NS))
            self.assertEqual(props.find("w:pageBreakBefore", NS).get(qn("w:val")), "0")
        self.assertFalse(self.body().xpath(".//w:br[@w:type='page']", namespaces=NS))

    def test_repeated_injection_updates_only_marked_block_after_new_attachment(self):
        inject_footer(str(self.path), self.config)
        first_count = len(self.body())
        inject_footer(str(self.path), {"cc": "更新单位", "printer": "更新办公室", "printDate": "2027年1月1日"})
        self.assertEqual(len(self.body()), first_count)
        self.assertEqual(len(self.marked()), 5)
        contents = self.text(self.body())
        self.assertNotIn("测试办公室", contents)
        self.assertNotIn("测试单位", contents)
        self.assertIn("2027年1月1日印发", contents)
        doc = Document(self.path)
        doc.add_paragraph("追加的实际附件正文。")
        doc.save(self.path)
        inject_footer(str(self.path), self.config)
        body = self.body()
        self.assertEqual(len(body), first_count + 1)
        last_attachment = next(p for p in body.findall("w:p", NS) if self.text(p) == "追加的实际附件正文。")
        self.assertLess(list(body).index(last_attachment), list(body).index(self.marked(body)[0]))
        self.assertIn("工作安排的实际正文。", self.text(body))
        self.assertIn("附件末尾表格内容", self.text(body))

    def test_plain_borders_and_near_matching_styles_are_preserved(self):
        doc = Document(self.path)
        ordinary = doc.add_paragraph("抄送：这是正文中的普通文字。")
        border = OxmlElement("w:pBdr")
        top = OxmlElement("w:top")
        top.set(qn("w:val"), "single")
        top.set(qn("w:sz"), "8")
        border.append(top)
        ordinary._element.get_or_add_pPr().append(border)
        empty_border = doc.add_paragraph()
        empty_border._element.get_or_add_pPr().append(etree.fromstring(etree.tostring(border)))
        doc.styles.add_style("GongwenLayout_imprint_separator_user", WD_STYLE_TYPE.PARAGRAPH)
        foreign = doc.add_paragraph("用户自建段落", "GongwenLayout_imprint_separator_user")
        saved = [etree.tostring(p._element) for p in (ordinary, empty_border, foreign)]
        doc.save(self.path)
        for _ in range(2):
            inject_footer(str(self.path), self.config)
        result = [etree.tostring(p) for p in self.body().findall("w:p", NS)]
        for paragraph in saved:
            self.assertIn(paragraph, result)
        self.assertEqual(len(self.marked()), 5)

    def test_single_content_row_has_only_outer_rules_even_after_update(self):
        inject_footer(str(self.path), self.config)
        for config, role in (({"printer": "办公室"}, "imprint"),
                             ({"print_date": "2026年11月12日"}, "imprint"),
                             ({"cc": "单位"}, "cc")):
            with self.subTest(config=config):
                inject_footer(str(self.path), config)
                block = self.marked()
                self.assertEqual([self.style(p) for p in block], [
                    "GongwenLayout_imprint_separator", f"GongwenLayout_{role}",
                    "GongwenLayout_imprint_separator",
                ])
                self.assertEqual([p.find("w:pPr/w:pBdr/w:top", NS).get(qn("w:sz"))
                                  for p in (block[0], block[-1])], ["8", "8"])

    def test_empty_config_does_not_add_or_remove_content(self):
        inject_footer(str(self.path), self.config)
        original = self.path.read_bytes()
        inject_footer(str(self.path), {})
        self.assertEqual(self.path.read_bytes(), original)

    def test_document_number_normalizes_only_year_brackets_and_keeps_digits(self):
        for brackets in ("[2026]", "【2026】", "(2026)", "〔2026〕"):
            for signer in ("", "张三"):
                with self.subTest(brackets=brackets, signer=signer):
                    doc = Document()
                    doc.add_paragraph("正文[2026]【2025】(2024)，编号0007。")
                    doc.save(self.path)
                    config = {"org_name": "测试机关[2026]", "doc_number": f"测{brackets}0007号", "signer": signer}
                    inject_header(str(self.path), config)
                    result = Document(self.path)
                    number = next(p for p in result.paragraphs if p.style.style_id == "GongwenLayout_doc_number")
                    self.assertEqual(number.text, "测〔2026〕0007号" + ("\t签发人：张三" if signer else ""))
                    self.assertEqual(result.paragraphs[0].text, "测试机关[2026]")
                    self.assertEqual(result.paragraphs[-1].text, "正文[2026]【2025】(2024)，编号0007。")
                    self.assertEqual(config["doc_number"], f"测{brackets}0007号")
        doc = Document()
        doc.add_paragraph("正文。")
        doc.save(self.path)
        inject_header(str(self.path), {"org_name": "测试机关", "doc_number": "测[26]0007号", "signer": "张三"})
        result = Document(self.path)
        self.assertIn("测[26]0007号", "\n".join(p.text for p in result.paragraphs))

    def test_existing_org_issuer_and_imprint_roles_are_kept(self):
        inject_header(str(self.path), {"org_name": "测试机关", "signer": "张三"})
        inject_footer(str(self.path), self.config)
        styles = {p.style.style_id for p in Document(self.path).paragraphs}
        self.assertTrue({"GongwenLayout_org", "GongwenLayout_issuer", "GongwenLayout_cc", "GongwenLayout_imprint"} <= styles)


if __name__ == "__main__":
    unittest.main()
