#!/usr/bin/env python3
# -*- coding: utf-8 -*-
#
# (c) 2026 Jose AI (https://www.linhut.cn)
# https://github.com/linhut/gongwen-skill
# Licensed under the MIT License. See the LICENSE file for details.
#
"""Markdown 草稿 → 国标初稿 → 格式修复与版式注入 → 最终验证。"""
from __future__ import annotations

import argparse
import contextlib
import io
import json
import sys
import tempfile
from datetime import date as _dt
from pathlib import Path


def _resolve_fm_doc_type(input_src: str, explicit: str | None) -> str:
    """解析已落盘 Markdown 的文种，规则与 md2docx 的 Front Matter 一致。"""
    if explicit:
        return explicit
    lines = Path(input_src).read_text(encoding="utf-8-sig").split("\n")
    if lines and lines[0].strip() == "---":
        front_matter = {}
        for line in lines[1:]:
            if line.strip() == "---":
                return front_matter.get("doc_type", "")
            if ":" in line:
                key, _, value = line.partition(":")
                value = value.strip().strip('"').strip("'")
                if value:
                    front_matter[key.strip()] = value
    return ""


def cmd_draft(args: argparse.Namespace) -> int:
    """生成公文；只根据最终文件与 optimize 的实际检查结果报告验证状态。"""
    from gongwen._legacy import cmd_md2docx, cmd_optimize

    verify = bool(getattr(args, "verify", True))
    is_json = bool(getattr(args, "json", False))
    with tempfile.TemporaryDirectory(prefix="gongwen_draft_") as tmp:
        tmp_dir = Path(tmp)
        input_src = args.input
        if input_src == "-":
            source = tmp_dir / "草稿.md"
            source.write_text(sys.stdin.buffer.read().decode("utf-8-sig"), encoding="utf-8")
            input_src = str(source)
        doc_type = (_resolve_fm_doc_type(input_src, args.doc_type)
                    or getattr(args, "default_doc_type", "") or "notice")
        today = _dt.today().strftime("%Y-%m-%d")
        out = Path(args.output) if args.output else Path(f"修订版+{doc_type}-成品+{today}+v1.docx")
        interim = tmp_dir / "初稿.docx"
        md_args = argparse.Namespace(
            input=input_src, output=str(interim), doc_type=doc_type,
            recipients=getattr(args, "recipients", None) or [],
            signer=getattr(args, "signer", ""), date=getattr(args, "date", ""),
            attachments=getattr(args, "attachments", None) or [],
            note=getattr(args, 'note', ''),
            no_ai_declaration=True,
            config_overrides=getattr(args, "config_overrides", ""),
        )
        if not is_json:
            print("🔧 draft 步骤 1/2: Markdown → 国标初稿")
        with contextlib.redirect_stdout(io.StringIO()) if is_json else contextlib.nullcontext():
            rc = cmd_md2docx(md_args)
        if rc not in (None, 0) or not interim.is_file():
            print("❌ draft: 初稿生成失败", file=sys.stderr)
            return rc if isinstance(rc, int) and rc else 1

        opt_args = argparse.Namespace(
            input=str(interim), output=str(out), doc_type=doc_type,
            selected_rules=None, layout=getattr(args, "layout", None), apply=True,
            remove_ai_declaration=bool(getattr(args, "no_ai_declaration", False)),
            config_overrides=getattr(args, "config_overrides", ""), verify=verify,
            json=True,
        )
        if not is_json:
            print("🔧 draft 步骤 2/2: 格式修复 + 生成成品" + (" + 验证" if verify else ""))
        buf = io.StringIO()
        opt_json = None
        error = None
        rc2 = 1
        try:
            with contextlib.redirect_stdout(buf):
                rc2 = cmd_optimize(opt_args)
            parsed = json.loads(buf.getvalue())
            if not isinstance(parsed, dict):
                raise ValueError("optimize 输出不是 JSON 对象")
            opt_json = parsed
        except Exception as exc:
            error = f"optimize 处理失败: {exc}"
        output_exists = out.is_file()
        executed = bool(opt_json and opt_json.get("verify_executed") is True)
        passed = bool(opt_json and opt_json.get("verify_passed") is True)
        verified = bool(verify and output_exists and rc2 == 0 and executed and passed
                        and opt_json.get("verified") is True
                        and opt_json.get("verify_p0") == 0
                        and not opt_json.get("verify_error") and not error)
        if not output_exists:
            error = error or f"输出文件不存在: {out}"
        elif opt_json and opt_json.get("verify_error"):
            error = error or opt_json["verify_error"]
        elif verify and not verified:
            error = error or "最终验证未通过或未执行"
        result = {
            "command": "draft", "input": args.input, "output": str(out),
            "doc_type": doc_type, "md2docx_ok": True, "optimize_rc": rc2,
            "output_exists": output_exists, "verify_executed": executed,
            "verify_passed": verified, "verified": verified, "verify_error": error,
            "optimize": opt_json,
        }
        for severity in ("p0", "p1", "p2"):
            key = f"verify_{severity}"
            result[key] = opt_json.get(key) if opt_json else None
        if is_json:
            print(json.dumps(result, ensure_ascii=False, indent=2))
        else:
            if output_exists:
                print(f"draft 已生成: {out}")
            if verified:
                print(f"验证通过（P0:0, P1:{result['verify_p1']}, P2:{result['verify_p2']}）")
            elif verify:
                print(f"验证未通过: {error}", file=sys.stderr)
            else:
                print("未执行验证")
        if error or rc2 not in (None, 0):
            return rc2 if isinstance(rc2, int) and rc2 else 1
        return 0
