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


def test_a_prompt_starting_with_a_dash_is_read_in_equals_form():
    args = build_parser().parse_args(["extract", "--image=a.png", "--prompt=-Transcribe"])
    assert args.prompt == "-Transcribe"


class _FakeModel:
    """Stands in for load_model and generate_one, counting calls."""

    def __init__(self, fail_on=()):
        self.loads = []
        self.generated = []
        self.fail_on = set(fail_on)

    def load(self, path):
        self.loads.append(path)
        return {"model": "m", "processor": "p", "device": "cpu", "dtype": "float32"}

    def generate(self, loaded, image, prompt, max_new_tokens):
        self.generated.append((image, prompt, max_new_tokens))
        if Path(image).name in self.fail_on:
            raise RuntimeError(f"generation blew up on {Path(image).name}")
        return '{"text": "%s"}' % Path(image).stem, 7


@pytest.fixture
def fake_model(monkeypatch, tmp_path):
    fake = _FakeModel()
    monkeypatch.setattr(qianfan_ocr, "cached_snapshot", lambda m, r: f"/hf/{m}@{r}")
    monkeypatch.setattr(qianfan_ocr, "load_model", fake.load)
    monkeypatch.setattr(qianfan_ocr, "generate_one", fake.generate)
    monkeypatch.setattr(qianfan_ocr, "lock_path", lambda: tmp_path / "lock" / "model.lock")
    return fake


def _images(tmp_path, *names):
    paths = []
    for name in names:
        path = tmp_path / name
        path.write_bytes(b"png")
        paths.append(str(path))
    return paths


def _requests(tmp_path, items):
    path = tmp_path / "requests.json"
    path.write_text(json.dumps(items))
    return str(path)


def _batch(tmp_path, items, model="baidu/Qianfan-OCR", revision="abc"):
    lines = []
    qianfan_ocr.extract_batch(
        qianfan_ocr.read_requests(_requests(tmp_path, items)),
        model,
        revision,
        lines.append,
    )
    return lines


def test_extract_batch_loads_once_and_reads_every_item_in_order(tmp_path, fake_model):
    a, b, c = _images(tmp_path, "a.png", "b.png", "c.png")
    lines = _batch(
        tmp_path,
        [
            {"id": "0", "image": a, "prompt": "Read a", "maxNewTokens": 10},
            {"id": "1", "image": b, "prompt": "Read b", "maxNewTokens": 10},
            {"id": "2", "image": c, "prompt": "Read c", "maxNewTokens": 10},
        ],
    )
    assert fake_model.loads == ["/hf/baidu/Qianfan-OCR@abc"]
    assert [g[0] for g in fake_model.generated] == [a, b, c]
    assert [line["type"] for line in lines] == ["start", "item", "item", "item", "end"]
    assert [line.get("id") for line in lines[1:4]] == ["0", "1", "2"]
    assert lines[2]["parsed"] == {"text": "b"}
    assert lines[2]["generateMs"] == 7
    assert lines[0]["model"] == "baidu/Qianfan-OCR"
    assert lines[0]["revision"] == "abc"
    assert lines[-1]["count"] == 3


def test_extract_batch_reports_a_failing_item_and_reads_the_rest(tmp_path, fake_model):
    fake_model.fail_on = {"b.png"}
    a, b, c = _images(tmp_path, "a.png", "b.png", "c.png")
    missing = str(tmp_path / "gone.png")
    lines = _batch(
        tmp_path,
        [
            {"id": "a", "image": a, "prompt": "p", "maxNewTokens": 10},
            {"id": "b", "image": b, "prompt": "p", "maxNewTokens": 10},
            {"id": "gone", "image": missing, "prompt": "p", "maxNewTokens": 10},
            {"id": "c", "image": c, "prompt": "p", "maxNewTokens": 10},
        ],
    )
    items = {line["id"]: line for line in lines if line["type"] == "item"}
    assert "rawOutput" in items["a"] and "rawOutput" in items["c"]
    assert "generation blew up on b.png" in items["b"]["error"]
    assert "image not found" in items["gone"]["error"]
    assert "rawOutput" not in items["gone"]


def test_extract_batch_takes_the_model_lock_once(tmp_path, fake_model, monkeypatch):
    taken = []
    real = qianfan_ocr.model_lock

    def counting(path):
        taken.append(path)
        return real(path)

    monkeypatch.setattr(qianfan_ocr, "model_lock", counting)
    a, b = _images(tmp_path, "a.png", "b.png")
    _batch(
        tmp_path,
        [
            {"id": "0", "image": a, "prompt": "p", "maxNewTokens": 1},
            {"id": "1", "image": b, "prompt": "p", "maxNewTokens": 1},
        ],
    )
    assert len(taken) == 1


def test_extract_batch_checks_the_cache_before_taking_the_lock(tmp_path, monkeypatch):
    def uncached(model_id, revision):
        raise qianfan_ocr.HelperError("model x@y is not in the Hugging Face cache; run install")

    def no_lock(path):
        raise AssertionError("took the lock for an uncached model")

    monkeypatch.setattr(qianfan_ocr, "cached_snapshot", uncached)
    monkeypatch.setattr(qianfan_ocr, "model_lock", no_lock)
    (a,) = _images(tmp_path, "a.png")
    with pytest.raises(qianfan_ocr.HelperError, match="run install"):
        _batch(tmp_path, [{"id": "0", "image": a, "prompt": "p", "maxNewTokens": 1}])


@pytest.mark.parametrize(
    "items, message",
    [
        ([], "at least one"),
        ({"id": "0"}, "a list"),
        ([{"id": "0", "image": "a", "prompt": "p", "maxNewTokens": 1}] * 2, "duplicate id"),
        ([{"id": "0", "image": "a"}], "prompt"),
    ],
)
def test_read_requests_rejects_a_bad_requests_file(tmp_path, items, message):
    with pytest.raises(qianfan_ocr.HelperError, match=message):
        qianfan_ocr.read_requests(_requests(tmp_path, items))


def test_extract_batch_lines_are_flushed_one_per_item(tmp_path):
    """Run the real script with a stub model: each item line must reach the
    pipe before the next item is generated, so a crash keeps what finished."""
    a, b = _images(tmp_path, "a.png", "b.png")
    requests = _requests(
        tmp_path,
        [
            {"id": "0", "image": a, "prompt": "p", "maxNewTokens": 1},
            {"id": "1", "image": b, "prompt": "p", "maxNewTokens": 1},
        ],
    )
    stub = tmp_path / "stub_run.py"
    stub.write_text(
        textwrap.dedent(
            f"""
            import os, sys
            sys.path.insert(0, {str(Path(qianfan_ocr.__file__).parent)!r})
            import qianfan_ocr
            qianfan_ocr.cached_snapshot = lambda m, r: "/hf"
            qianfan_ocr.load_model = lambda path: {{}}
            def generate(loaded, image, prompt, max_new_tokens):
                if image.endswith("b.png"):
                    os._exit(9)
                return "{{}}", 1
            qianfan_ocr.generate_one = generate
            sys.exit(qianfan_ocr.main(sys.argv[1:]))
            """
        )
    )
    result = subprocess.run(
        [sys.executable, str(stub), "extract-batch", f"--requests={requests}"],
        capture_output=True,
        text=True,
        env={"PATH": "/usr/bin:/bin", "XDG_CACHE_HOME": str(tmp_path / "cache")},
        timeout=30,
    )
    assert result.returncode == 9
    lines = [json.loads(line) for line in result.stdout.splitlines()]
    assert [line["type"] for line in lines] == ["start", "item"]
    assert lines[1]["id"] == "0"


def test_extract_batch_with_an_invalid_requests_file_reports_a_json_error(tmp_path):
    result = _run_helper(["extract-batch", f"--requests={_requests(tmp_path, [])}"])
    assert result.returncode == 1
    assert "at least one" in json.loads(result.stdout)["error"]


def test_extract_batch_arguments_default_to_the_pinned_revision():
    args = build_parser().parse_args(["extract-batch", "--requests=r.json"])
    assert args.model == "baidu/Qianfan-OCR"
    assert args.revision == qianfan_ocr.DEFAULT_REVISION
