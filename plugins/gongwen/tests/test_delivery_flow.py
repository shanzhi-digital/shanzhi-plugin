"""交付链路回归测试；运行时数据和生成文件全部位于临时目录。"""
import argparse
import atexit
import contextlib
import io
import json
import logging
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch
from types import SimpleNamespace

_RUNTIME = tempfile.TemporaryDirectory(prefix="gongwen_test_runtime_")
os.environ["GONGWEN_DATA_DIR"] = _RUNTIME.name
os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from gongwen import _legacy
from gongwen.cli.draft_cmds import cmd_draft
from engine.core.document.models import DocumentModel


def _cleanup_runtime():
    logging.shutdown()
    _RUNTIME.cleanup()


atexit.register(_cleanup_runtime)


class DeliveryFlowTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="gongwen_delivery_")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.source = self.root / "草稿.md"
        self.source.write_text("# 关于开展工作的通知\n各单位：\n请认真落实有关工作。", encoding="utf-8")
        self.output = self.root / "成品.docx"

    def args(self, **overrides):
        values = dict(input=str(self.source), output=str(self.output), doc_type="",
                      default_doc_type="", recipients=[], signer="测试单位", date="2026年8月1日",
                      attachments=[], no_ai_declaration=True, config_overrides="", layout=None,
                      verify=True, json=True, apply=True, selected_rules=None,
                      remove_ai_declaration=True)
        values.update(overrides)
        return argparse.Namespace(**values)

    def capture(self, command, args):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = command(args)
        return rc, json.loads(buf.getvalue())

    @staticmethod
    def verified_result(**overrides):
        result = dict(verify_executed=True, verified=True, verify_passed=True,
                      verify_p0=0, verify_p1=2, verify_p2=3, verify_error=None)
        result.update(overrides)
        return result

    def mock_draft(self, result, *, create=True, rc=0, args=None, exception=None):
        def md(md_args):
            Path(md_args.output).write_bytes(b"interim")
            return 0

        def optimize(opt_args):
            self.assertTrue(opt_args.json)
            if create:
                Path(opt_args.output).write_bytes(b"final")
            if exception:
                raise exception
            print(json.dumps(result))
            return rc

        with patch.object(_legacy, "cmd_md2docx", side_effect=md) as md_call, \
             patch.object(_legacy, "cmd_optimize", side_effect=optimize) as opt_call:
            code, payload = self.capture(cmd_draft, args or self.args())
        return code, payload, md_call, opt_call

    def test_type_priority_and_layout_forwarding(self):
        for explicit, fm, default, expected in (
            ("notice", "report", "speech", "notice"),
            ("", "report", "speech", "report"),
            ("", "", "report", "report"),
            ("", "", "", "notice"),
        ):
            with self.subTest(explicit=explicit, fm=fm, default=default):
                text = (f"---\ndoc_type: {fm}\n---\n" if fm else "") + "# 测试公文\n正文。"
                self.source.write_text(text, encoding="utf-8-sig")
                rc, result, md, opt = self.mock_draft(self.verified_result(), args=self.args(
                    doc_type=explicit, default_doc_type=default, layout="layout.json"))
                self.assertEqual(rc, 0)
                self.assertEqual(result["doc_type"], expected)
                self.assertEqual(md.call_args.args[0].doc_type, expected)
                self.assertEqual(opt.call_args.args[0].doc_type, expected)
                self.assertEqual(opt.call_args.args[0].layout, "layout.json")
                self.assertTrue(result["verified"])

    def test_stdin_front_matter_uses_same_type(self):
        stdin = SimpleNamespace(buffer=io.BytesIO(b"---\ndoc_type: report\n---\n# title\nbody"))
        with patch("sys.stdin", stdin):
            rc, result, md, opt = self.mock_draft(self.verified_result(), args=self.args(
                input="-", default_doc_type="notice"))
        self.assertEqual(rc, 0)
        self.assertEqual(result["doc_type"], "report")
        self.assertEqual(md.call_args.args[0].doc_type, opt.call_args.args[0].doc_type)

    def test_draft_does_not_infer_verified_from_zero_exit(self):
        for result in ({}, ["unexpected"], self.verified_result(verify_executed=False),
                       self.verified_result(verify_passed=False),
                       self.verified_result(verify_p0=1),
                       self.verified_result(verify_error="检查异常")):
            with self.subTest(result=result):
                rc, payload, _, _ = self.mock_draft(result)
                self.assertNotEqual(rc, 0)
                self.assertFalse(payload["verified"])

    def test_draft_requires_final_file(self):
        rc, result, _, _ = self.mock_draft(self.verified_result(), create=False)
        self.assertNotEqual(rc, 0)
        self.assertFalse(result["output_exists"])
        self.assertFalse(result["verified"])
        self.assertIn("不存在", result["verify_error"])

    def test_draft_reports_exception(self):
        rc, result, _, _ = self.mock_draft({}, exception=RuntimeError("检查异常"))
        self.assertNotEqual(rc, 0)
        self.assertFalse(result["verified"])
        self.assertIn("检查异常", result["verify_error"])

    def test_draft_no_verify_is_unverified(self):
        rc, result, _, _ = self.mock_draft(self.verified_result(
            verify_executed=False, verified=False, verify_passed=False, verify_p0=None),
            args=self.args(verify=False))
        self.assertEqual(rc, 0)
        self.assertFalse(result["verified"])
        self.assertFalse(result["verify_executed"])

    def test_draft_human_mode_also_requires_structured_verification(self):
        def md(args):
            Path(args.output).write_bytes(b"interim")
        def opt(args):
            self.assertTrue(args.json)
            Path(args.output).write_bytes(b"final")
            print("not json")
            return 0
        buf = io.StringIO()
        with patch.object(_legacy, "cmd_md2docx", side_effect=md), \
             patch.object(_legacy, "cmd_optimize", side_effect=opt), \
             contextlib.redirect_stdout(buf), contextlib.redirect_stderr(io.StringIO()):
            rc = cmd_draft(self.args(json=False))
        self.assertNotEqual(rc, 0)
        self.assertNotIn("验证通过", buf.getvalue())

    def run_optimize(self, *, final_issues=(), error=None, create=True, apply=True, layout=False):
        model = DocumentModel()
        engine = Mock()
        engine.check.side_effect = [[], error if error else list(final_issues)]
        engine.check_and_fix.return_value = ([], model)
        events = []
        def parse(path):
            if Path(path) == self.output:
                events.append("verify")
            return model
        def generate(_model, path, **kwargs):
            events.append("generate")
            if create:
                Path(path).write_bytes(b"docx")
        layout_path = self.root / "layout.json"
        layout_path.write_text(json.dumps(dict(header={"enabled": True}, footer={"enabled": True},
                                              page_number={"enabled": True})), encoding="utf-8")
        with patch("engine.core.document.parser.parse_docx", side_effect=parse), \
             patch("engine.core.document.generator.generate_docx", side_effect=generate), \
             patch("engine.core.rules.engine.RuleEngine", return_value=engine), \
             patch("engine.core.document.modifier.clean_path_b_markers", return_value=0), \
             patch("engine.core.document.modifier.bold_first_sentence_of_body", return_value=0), \
             patch("engine.core.document.modifier._insert_blank_lines", return_value=0), \
             patch("engine.inject.inject_header", side_effect=lambda *a: events.append("header")), \
             patch("engine.inject.inject_footer", side_effect=lambda *a: events.append("footer")), \
             patch("engine.inject.inject_page_number", side_effect=lambda *a: events.append("page_number")):
            rc, result = self.capture(_legacy.cmd_optimize, self.args(
                doc_type="notice", apply=apply, layout=str(layout_path) if layout else None))
        return rc, result, events

    def test_optimize_layout_precedes_final_check(self):
        rc, result, events = self.run_optimize(layout=True)
        self.assertEqual(rc, 0)
        self.assertEqual(events, ["generate", "header", "footer", "page_number", "verify"])
        self.assertTrue(result["verified"])

    def test_optimize_check_exception_is_failure(self):
        rc, result, _ = self.run_optimize(error=RuntimeError("检查异常"))
        self.assertNotEqual(rc, 0)
        self.assertTrue(result["verify_executed"])
        self.assertFalse(result["verified"])
        self.assertFalse(result["verify_passed"])
        self.assertIn("检查异常", result["verify_error"])

    def test_optimize_missing_output_is_failure(self):
        rc, result, events = self.run_optimize(create=False)
        self.assertNotEqual(rc, 0)
        self.assertFalse(result["verify_executed"])
        self.assertFalse(result["verified"])
        self.assertIn("不存在", result["verify_error"])
        self.assertNotIn("verify", events)

    def test_optimize_p0_fails_but_p1_p2_are_reported(self):
        for p0 in (0, 1):
            with self.subTest(p0=p0):
                issues = [SimpleNamespace(severity="P1"), SimpleNamespace(severity="P2")]
                if p0:
                    issues.append(SimpleNamespace(severity="P0"))
                rc, result, _ = self.run_optimize(final_issues=issues)
                self.assertEqual(rc, p0)
                self.assertEqual(result["verified"], p0 == 0)
                self.assertEqual((result["verify_p0"], result["verify_p1"], result["verify_p2"]), (p0, 1, 1))

    def test_optimize_preview_has_no_deliverable(self):
        rc, result, events = self.run_optimize(apply=False)
        self.assertEqual(rc, 0)
        self.assertIsNone(result["output"])
        self.assertEqual(result["planned_output"], str(self.output))
        self.assertFalse(result["applied"])
        self.assertFalse(result["verified"])
        self.assertFalse(result["output_exists"])
        self.assertEqual(events, [])

    def test_md2docx_loads_final_type_rules(self):
        self.source.write_text("---\ndoc_type: report\n---\n# 工作报告\n正文。", encoding="utf-8")
        real_load = _legacy._load_rules_with_overrides
        for explicit, expected in (("notice", "notice"), (None, "report")):
            with self.subTest(explicit=explicit), patch.object(_legacy, "_load_rules_with_overrides", wraps=real_load) as load:
                _, result = self.capture(_legacy.cmd_md2docx, self.args(doc_type=explicit))
                self.assertEqual(load.call_args.args[0], expected)
                self.assertEqual(result["doc_type"], expected)

    def test_real_cli_notification_and_report(self):
        for doc_type, title in (("notice", "关于开展工作的通知"), ("report", "关于工作开展情况的报告")):
            with self.subTest(doc_type=doc_type):
                self.source.write_text(
                    f"---\ndoc_type: {doc_type}\nsigner: 测试单位\ndate: 2026年8月1日\n---\n"
                    f"# {title}\n各单位：\n请认真落实有关工作。\n", encoding="utf-8")
                output = self.root / f"{doc_type}.docx"
                proc = subprocess.run([sys.executable, "-m", "gongwen", "draft", str(self.source),
                    "-o", str(output), "--default-doc-type", "speech", "--no-ai-declaration", "--json"],
                    cwd=ROOT, env=dict(os.environ, PYTHONUTF8="1"), capture_output=True, text=True, encoding="utf-8")
                self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
                result = json.loads(proc.stdout)
                self.assertTrue(output.is_file())
                self.assertEqual(result["doc_type"], doc_type)
                self.assertTrue(result["verify_executed"])
                self.assertTrue(result["verified"])
                self.assertEqual(result["verify_p0"], 0)
                from docx import Document
                self.assertIn(title, "\n".join(p.text for p in Document(output).paragraphs))

    def test_real_redhead_roles_and_invalid_body(self):
        from docx import Document
        from docx.shared import Pt
        from engine.core.document.parser import parse_docx
        from engine.core.rules.engine import RuleEngine
        from engine.core.rules.checker import check_document
        from engine.inject import inject_header

        # 复现本地红头报告验收样例，保持测试不依赖工作区外部产物。
        self.source.write_text("---\ndoc_type: report\n---\n# 关于档案整理工作情况的报告\n\n"
            "各有关单位：\n\n为规范档案管理，现就有关工作报告如下。\n\n## 一、工作情况\n\n"
            "已完成资料梳理，明确收集、复核与归档责任。\n\n## 二、下一步安排\n\n"
            "继续完善目录，核实材料完整性，按规定报送办理情况。\n\n特此报告。\n", encoding="utf-8")
        layout = self.root / "layout.json"
        layout.write_text(json.dumps({"header": {"org_name": "测试机关文件", "doc_number": "测试〔2026〕1号"},
            "footer": {"printer": "测试机关办公室", "print_date": "2026年11月12日"},
            "page_number": {"format": "— {PAGE} —", "alignment": "right", "font": "宋体", "size": 14}}), encoding="utf-8")
        rc, result = self.capture(cmd_draft, self.args(layout=str(layout)))
        self.assertEqual(rc, 0, result)
        self.assertTrue(result["verified"])
        model = parse_docx(self.output)
        self.assertEqual(model.paragraphs[0].role, "org")
        self.assertEqual(model.paragraphs[0].runs[0].format.font_size_pt, 30)
        self.assertFalse(model.paragraphs[0].is_heading)
        self.assertEqual(model.paragraphs[3].role, "doc_number")
        self.assertEqual(next(p for p in model.paragraphs if p.text == "各有关单位：").role, "recipient")
        self.assertEqual(next(p for p in model.paragraphs if "办公室" in p.text and "印发" in p.text).role, "imprint")
        self.assertFalse([i for i in RuleEngine().check(model, "report") if i.severity == "P0"])

        # 正文和版记分别受自己的规则约束，不因版式角色跳过正文错误。
        doc = Document(self.output)
        body_index = next(i for i, p in enumerate(doc.paragraphs) if p.text.startswith("已完成资料"))
        doc.paragraphs[body_index].runs[0].font.size = Pt(10)
        bad = self.root / "正文错误.docx"
        doc.save(bad)
        issues = RuleEngine().check(parse_docx(bad), "report")
        self.assertTrue(any(i.severity == "P0" and i.location == f"paragraph:{body_index}"
                            for i in issues))

        # 带签发人的文号行、抄送行也有明确角色，抄送仍走cc专属检查。
        from engine.inject import inject_footer
        plain = self.root / "签发版式.docx"
        doc = Document()
        doc.add_paragraph("普通正文。")
        doc.save(plain)
        inject_header(str(plain), {"org_name": "测试机关文件", "doc_number": "测〔2026〕2号", "signer": "张三"})
        inject_footer(str(plain), {"cc": "测试单位", "printer": "测试办公室", "print_date": "2026年11月12日"})
        marked = parse_docx(plain)
        self.assertEqual(next(p for p in marked.paragraphs if "签发人" in p.text).role, "doc_number")
        cc = next(p for p in marked.paragraphs if p.text.startswith("抄送："))
        self.assertEqual(cc.role, "cc")
        cc.runs[0].format.font_name = "错误字体"
        cc_issues = check_document(marked, {"check_rules": [{"id": "TEST-CC", "field": "cc.font",
            "expected": "仿宋_GB2312", "severity": "P0", "name": "抄送字体", "message": "应为仿宋"}]})
        self.assertTrue(any(i.rule_id == "TEST-CC" for i in cc_issues))

    def test_optimize_returns_actionable_final_details(self):
        from engine.core.rules.checker import CheckIssue
        issue = CheckIssue("TEST-P0", "format", "P0", "正文字号", "paragraph:8", "10pt", "16pt", "正文应为三号")
        rc, result, _ = self.run_optimize(final_issues=[issue])
        self.assertEqual(rc, 1)
        self.assertEqual(result["verify_issues"], 1)
        self.assertEqual(result["verify_details"][0]["location"], "paragraph:8")
        self.assertEqual(result["verify_details"][0]["rule_id"], "TEST-P0")
        self.assertEqual(result["verify_details"][0]["reason"], "正文应为三号")

    def test_cli_accepts_no_verify_and_layout(self):
        layout = self.root / "版式.json"
        layout.write_text(json.dumps({"page_number": {"enabled": True, "format": "第{PAGE}页"}}), encoding="utf-8")
        proc = subprocess.run([sys.executable, "-m", "gongwen", "draft", str(self.source),
            "-o", str(self.output), "--no-verify", "--layout", str(layout), "--json"],
            cwd=ROOT, env=dict(os.environ, PYTHONUTF8="1"), capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        result = json.loads(proc.stdout)
        self.assertFalse(result["verified"])
        self.assertFalse(result["verify_executed"])
        self.assertEqual(result["optimize"]["layout"], ["page_number"])
        import zipfile
        with zipfile.ZipFile(self.output) as archive:
            footers = [archive.read(name).decode("utf-8") for name in archive.namelist()
                       if name.startswith("word/footer") and name.endswith(".xml")]
        self.assertTrue(any("第" in footer and "页" in footer and "PAGE" in footer for footer in footers))


if __name__ == "__main__":
    unittest.main()
