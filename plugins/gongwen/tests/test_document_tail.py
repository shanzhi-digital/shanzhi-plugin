"""公文尾部真实 draft/check 和表格位置回归。"""
import atexit
import json
import logging
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
_RUNTIME = tempfile.TemporaryDirectory(prefix='gongwen_tail_runtime_')
os.environ['GONGWEN_DATA_DIR'] = _RUNTIME.name
os.environ['PYTHONDONTWRITEBYTECODE'] = '1'
sys.dont_write_bytecode = True

def _cleanup():
    logging.shutdown()
    _RUNTIME.cleanup()
atexit.register(_cleanup)

from docx import Document
from engine.core.document.models import DocumentModel, Paragraph, Run, Table
from engine.core.document.modifier import normalize_document_tail
from engine.core.document.parser import parse_docx
from engine.core.rules.checker import check_document
from engine.core.rules.manager import load_rules_merged


class DocumentTailTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='gongwen_tail_')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def cli(self, *args):
        result = subprocess.run([sys.executable, '-B', '-m', 'gongwen', *map(str, args)],
            cwd=ROOT, capture_output=True, text=True, encoding='utf-8',
            env={**os.environ, 'PYTHONIOENCODING': 'utf-8', 'PYTHONDONTWRITEBYTECODE': '1'})
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return json.loads(result.stdout)

    def draft(self, text, *args):
        source = self.root / '草稿.md'
        source.write_text(text, encoding='utf-8')
        output = self.root / '成品.docx'
        payload = self.cli('draft', source, '-o', output, '--json', *args)
        self.assertTrue(payload['verified'], payload)
        checked = self.cli('check', output, '-t', 'notice', '--json')
        return output, parse_docx(output), checked

    @staticmethod
    def paragraph(text, role='body', **kw):
        return Paragraph(index=0, text=text, role=role, runs=[Run(text=text)], **kw)

    def test_draft_moves_existing_description_before_signature_and_note_after_date(self):
        output, model, checked = self.draft(
            '# 关于开展工作的通知\n各单位：\n请按要求落实工作。\n特此通知。\n附件：旧表\n'
            '测试办公室\n2026年8月1日\n（联系人：张三，电话：12345678）\n',
            '--attachments', '报名表', '工作安排')
        texts = [p.text for p in model.paragraphs if p.text.strip()]
        self.assertEqual(texts.count('特此通知'), 1)
        self.assertEqual([p.text for p in model.paragraphs if p.role == 'attachment'],
                         ['附件：1.报名表', '2.工作安排'])
        roles = [p.role for p in model.paragraphs if p.text.strip()]
        self.assertLess(roles.index('attachment'), roles.index('signature'))
        self.assertEqual(roles[roles.index('date') + 1], 'note')
        note = next(p for p in model.paragraphs if p.role == 'note')
        self.assertEqual(note.format.alignment, 'left')
        self.assertEqual(note.format.first_line_indent_pt, 32)
        self.assertNotIn('旧表', '\n'.join(texts))
        issues = check_document(model, load_rules_merged('notice'))
        self.assertFalse([p for p in issues if p.rule_id.startswith('CHK-TAIL') or p.rule_id in ('CHK-C027', 'CHK-N004')])
        self.assertEqual(checked, [])
        self.assertEqual(sum(p.style.style_id == 'GongwenLayout_note' for p in Document(output).paragraphs), 1)

    def test_inline_signature_date_with_misplaced_attachment_and_exact_old_ai(self):
        _, model, _ = self.draft(
            '# 关于开展工作的通知\n各单位：\n请落实有关工作要求。\n特此通知。\n'
            '测试区民政局\n2026年8月1日\n附件：旧表\n'
            '（联系人：张三，电话：12345678）\n（内容由GongWen-skill-AI生成，仅供参考）\n',
            '--signer', '测试区民政局', '--date', '2026年8月1日', '--attachments', '报名表')
        self.assertEqual(sum(p.text == '测试区民政局' for p in model.paragraphs), 1)
        self.assertEqual(sum(p.role == 'signature' for p in model.paragraphs), 1)
        self.assertEqual(sum(p.role == 'date' for p in model.paragraphs), 1)
        self.assertEqual([p.role for p in model.paragraphs if p.text.strip()][-4:],
                         ['attachment', 'signature', 'date', 'note'])
        self.assertFalse(any('GongWen-skill-AI' in p.text for p in model.paragraphs))

    def test_front_matter_note_and_single_attachment(self):
        _, model, _ = self.draft(
            '---\nsigner: 测试办公室\ndate: 2026年8月1日\nnote: 联系人：李四，电话：12345\n'
            '---\n# 关于开展工作的通知\n各单位：\n请落实工作要求。\n特此通知。\n',
            '--attachments', '1.报名表')
        self.assertEqual([p.text for p in model.paragraphs if p.role == 'attachment'], ['附件：报名表'])
        self.assertEqual([p.text for p in model.paragraphs if p.role == 'note'], ['（联系人：李四，电话：12345）'])

    def test_explicit_note_overrides_front_matter_and_preserves_reference_body(self):
        _, model, _ = self.draft(
            '---\nsigner: 测试办公室\ndate: 2026年8月1日\nnote: 联系人：旧人，电话：000\n---\n'
            '# 关于开展工作的通知\n各单位：\n工作资料仅供参考，请按要求落实。\n特此通知。\n',
            '--note', '联系人：新人，电话：111')
        self.assertEqual([p.text for p in model.paragraphs if p.role == 'note'], ['（联系人：新人，电话：111）'])
        self.assertTrue(any('仅供参考' in p.text and p.role == 'body' for p in model.paragraphs))

    def test_table_anchor_and_actual_attachment_are_preserved(self):
        p = self.paragraph
        table = Table(index=0, rows=1, cols=1, insert_after_index=2)
        model = DocumentModel(paragraphs=[p('标题', 'title'), p('附件：报名表', 'attachment'),
            p('表格前正文。'), p('特此通知。'), p('测试单位', 'signature'), p('2026年8月1日', 'date'),
            p('附件：报名表', 'attachment'), p('附件1', 'title', is_heading=True, heading_level=0, page_break=True),
            p('实际附件正文。')], tables=[table])
        actual = model.paragraphs[-2:]
        normalize_document_tail(model)
        self.assertEqual(model.paragraphs[table.insert_after_index].text, '表格前正文。')
        self.assertEqual([p.text for p in model.paragraphs[-2:]], [p.text for p in actual])
        self.assertEqual(sum(p.role == 'attachment' for p in model.paragraphs), 1)
        texts = [p.text for p in model.paragraphs]
        self.assertLess(texts.index('特此通知'), texts.index('附件：报名表'))
        self.assertLess(texts.index('附件：报名表'), texts.index('测试单位'))

    def test_checker_reports_order_duplicates_and_note_format(self):
        p = self.paragraph
        model = DocumentModel(paragraphs=[p('正文。'), p('测试单位', 'signature'), p('2026年8月1日', 'date'),
            p('附件：1.报名表', 'attachment'), p('附件：1.报名表', 'attachment'), p('(联系人：甲)', 'note')])
        issues = check_document(model, load_rules_merged('notice'))
        self.assertTrue(any(i.rule_id == 'CHK-TAIL001' for i in issues))
        self.assertTrue(any(i.rule_id == 'CHK-TAIL003' for i in issues))
        normalize_document_tail(model)
        self.assertFalse([i for i in check_document(model, load_rules_merged('notice'))
                          if i.rule_id.startswith('CHK-TAIL') or i.rule_id == 'CHK-C027'])

    def test_real_draft_preserves_actual_attachment_table(self):
        output, model, checked = self.draft(
            '# 关于开展工作的通知\n各单位：\n请落实有关工作要求。特此通知。\n'
            '附件：报名表\n测试办公室\n2026年8月1日\n---\n# 附件：报名表\n'
            '实际附件正文保留。\n| 姓名 | 单位 |\n| --- | --- |\n| 张三 | 测试单位 |\n',
            '--note', '联系人：张三，电话：12345')
        texts = [p.text for p in model.paragraphs if p.text.strip()]
        self.assertIn('特此通知', texts)
        self.assertIn('请落实有关工作要求。', texts)
        self.assertIn('实际附件正文保留。', texts)
        self.assertEqual(len(model.tables), 1)
        table = model.tables[0]
        self.assertGreaterEqual(table.insert_after_index, texts.index('2026年8月1日'))
        self.assertEqual([cell.text for row in Document(output).tables[0].rows for cell in row.cells],
                         ['姓名', '单位', '张三', '测试单位'])
        self.assertFalse([i for i in checked if i['rule_id'].startswith('CHK-TAIL') or i['rule_id'] == 'CHK-N004'])

    def test_imprint_checker_detects_missing_line_and_content_after_imprint(self):
        from engine.inject import inject_footer
        from docx.oxml.ns import qn
        path = self.root / '版记.docx'
        doc = Document()
        doc.add_paragraph('正文内容。')
        doc.save(path)
        inject_footer(str(path), {'cc': '测试单位', 'printer': '测试办公室', 'print_date': '2026年8月1日'})
        def tail_issues():
            return [i for i in check_document(parse_docx(path), load_rules_merged('notice'))
                    if i.rule_id == 'CHK-TAIL006']
        self.assertEqual(tail_issues(), [])
        doc = Document(path)
        separator = next(p for p in doc.paragraphs if p.style.style_id == 'GongwenLayout_imprint_separator')
        border = separator._p.find('./' + qn('w:pPr') + '/' + qn('w:pBdr'))
        border.getparent().remove(border)
        doc.save(path)
        self.assertTrue(tail_issues())
        inject_footer(str(path), {'cc': '测试单位', 'printer': '测试办公室', 'print_date': '2026年8月1日'})
        doc = Document(path)
        doc.add_table(rows=1, cols=1).cell(0, 0).text = '尾随附件表格'
        doc.save(path)
        self.assertTrue(tail_issues())

    def test_contact_extraction_keeps_body_and_does_not_guess(self):
        p = self.paragraph
        model = DocumentModel(paragraphs=[p('请按联系人名册核对，不得遗漏。'),
            p('按要求报送。（联系人：甲，电话：12345）'), p('测试单位', 'signature'), p('2026年8月1日', 'date')])
        normalize_document_tail(model)
        self.assertEqual(model.paragraphs[0].text, '请按联系人名册核对，不得遗漏。')
        self.assertEqual(model.paragraphs[1].text, '按要求报送。')
        self.assertEqual(model.paragraphs[-1].text, '（联系人：甲，电话：12345）')


if __name__ == '__main__':
    unittest.main()
