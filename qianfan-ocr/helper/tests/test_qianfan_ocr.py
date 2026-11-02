import json
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import qianfan_ocr  # noqa: E402
from qianfan_ocr import (  # noqa: E402
    STARTED,
    build_parser,
    model_lock,
    parse_model_json,
    pick_device,
)


def test_parse_model_json_plain():
    assert parse_model_json('{"text": "hello"}') == {"text": "hello"}


def test_parse_model_json_strips_markdown_fence():
    raw = 'Here you go:\n```json\n{"title": "Invoice", "total": null}\n```'
    assert parse_model_json(raw) == {"title": "Invoice", "total": None}


def test_parse_model_json_finds_object_inside_prose():
    raw = 'The answer is {"a": {"b": 1}} as requested.'
    assert parse_model_json(raw) == {"a": {"b": 1}}


def test_parse_model_json_returns_none_for_plain_text():
    assert parse_model_json("No JSON here, just OCR text.") is None


def test_parse_model_json_returns_none_for_non_object():
    assert parse_model_json('["a", "b"]') is None


def test_parse_model_json_returns_none_for_broken_json():
    assert parse_model_json('{"a": 1,}') is None


def test_pick_device_prefers_mps():
    assert pick_device(mps_available=True, cuda_available=True) == ("mps", "bfloat16")


def test_pick_device_uses_cuda_without_mps():
    assert pick_device(mps_available=False, cuda_available=True) == ("cuda", "bfloat16")


def test_pick_device_falls_back_to_cpu_in_float32():
    assert pick_device(mps_available=False, cuda_available=False) == ("cpu", "float32")


def test_extract_arguments_default_to_the_pinned_revision():
    args = build_parser().parse_args(["extract", "--image", "a.png", "--prompt", "Read it"])
    assert args.model == "baidu/Qianfan-OCR"
    assert args.revision == qianfan_ocr.DEFAULT_REVISION
    assert args.max_new_tokens == 1024


def test_extract_needs_a_prompt():
    with pytest.raises(SystemExit):
        build_parser().parse_args(["extract", "--image", "a.png"])


def test_model_lock_waits_for_another_holder(tmp_path):
    lock = tmp_path / "model.lock"
    holder = subprocess.Popen(
        [
            sys.executable,
            "-c",
            textwrap.dedent(
                f"""
                import fcntl, sys, time
                f = open({str(lock)!r}, "a")
                fcntl.flock(f, fcntl.LOCK_EX)
                print("held", flush=True)
                time.sleep(0.6)
                """
            ),
        ],
        stdout=subprocess.PIPE,
        text=True,
    )
    try:
        assert holder.stdout.readline().strip() == "held"
        with model_lock(lock) as waited:
            pass
        assert waited["ms"] >= 300
    finally:
        holder.wait(timeout=5)


def test_model_lock_does_not_wait_when_free(tmp_path):
    with model_lock(tmp_path / "sub" / "model.lock") as waited:
        pass
    assert waited["ms"] < 300


def _run_helper(args, env_extra=None):
    script = Path(qianfan_ocr.__file__)
    env = {"PATH": "/usr/bin:/bin", **(env_extra or {})}
    return subprocess.run(
        [sys.executable, str(script), *args],
        capture_output=True,
        text=True,
        env=env,
        timeout=30,
    )


def test_helper_announces_itself_on_stderr_before_failing():
    result = _run_helper(["extract"])
    assert result.returncode != 0
    assert result.stderr.splitlines()[0] == STARTED


def test_extract_of_a_missing_image_reports_a_json_error(tmp_path):
    result = _run_helper(
        ["extract", "--image", str(tmp_path / "nope.png"), "--prompt", "Read it"]
    )
    assert result.returncode == 1
    assert "nope.png" in json.loads(result.stdout)["error"]


def test_extract_of_an_uncached_model_says_run_install(tmp_path):
    image = tmp_path / "page.png"
    image.write_bytes(b"not really a png")
    result = _run_helper(
        ["extract", "--image", str(image), "--prompt", "Read it"],
        {"HF_HOME": str(tmp_path / "hf"), "HF_HUB_OFFLINE": "1", "HOME": str(tmp_path)},
    )
    assert result.returncode == 1
    error = json.loads(result.stdout)["error"]
    assert error.endswith("is not in the Hugging Face cache; run install")
    assert qianfan_ocr.DEFAULT_REVISION in error
