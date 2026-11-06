import fcntl
import json
import os
import signal
import subprocess
import sys
import textwrap
import time
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


def _run_helper(args, env_extra=None, stdin=None):
    script = Path(qianfan_ocr.__file__)
    env = {"PATH": "/usr/bin:/bin", **(env_extra or {})}
    return subprocess.run(
        [sys.executable, str(script), *args],
        input=stdin,
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


def _requests(items):
    """Requests as the one line the caller sends on stdin."""
    return json.dumps(items) + "\n"


def _batch(tmp_path, items, model="baidu/Qianfan-OCR", revision="abc"):
    lines = []
    qianfan_ocr.extract_batch(
        qianfan_ocr.read_requests(_requests(items)),
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

    def counting(path, *args):
        taken.append(path)
        return real(path, *args)

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
def test_read_requests_rejects_bad_requests(items, message):
    with pytest.raises(qianfan_ocr.HelperError, match=message):
        qianfan_ocr.read_requests(_requests(items))


def test_read_requests_rejects_a_line_that_is_not_json():
    with pytest.raises(qianfan_ocr.HelperError, match="cannot read requests"):
        qianfan_ocr.read_requests("not json\n")


def test_extract_batch_lines_are_flushed_one_per_item(tmp_path):
    """Run the real script with a stub model: each item line must reach the
    pipe before the next item is generated, so a crash keeps what finished."""
    a, b = _images(tmp_path, "a.png", "b.png")
    requests = _requests(
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
        [sys.executable, str(stub), "extract-batch"],
        input=requests,
        capture_output=True,
        text=True,
        env={"PATH": "/usr/bin:/bin", "XDG_CACHE_HOME": str(tmp_path / "cache")},
        timeout=30,
    )
    assert result.returncode == 9
    lines = [json.loads(line) for line in result.stdout.splitlines()]
    assert [line["type"] for line in lines] == ["start", "item"]
    assert lines[1]["id"] == "0"


def test_extract_batch_with_invalid_requests_reports_a_json_error():
    result = _run_helper(["extract-batch"], stdin=_requests([]))
    assert result.returncode == 1
    assert "at least one" in json.loads(result.stdout)["error"]


def test_extract_batch_arguments_default_to_the_pinned_revision():
    args = build_parser().parse_args(["extract-batch"])
    assert args.model == "baidu/Qianfan-OCR"
    assert args.revision == qianfan_ocr.DEFAULT_REVISION


def test_extract_batch_that_fails_to_load_prints_no_lines(tmp_path):
    """A load failure after the lock (a real OOM) must leave stdout empty and
    exit non-zero, so the caller treats it as failing before any item."""
    (a,) = _images(tmp_path, "a.png")
    requests = _requests([{"id": "0", "image": a, "prompt": "p", "maxNewTokens": 1}])
    stub = tmp_path / "stub_load.py"
    stub.write_text(
        textwrap.dedent(
            f"""
            import sys
            sys.path.insert(0, {str(Path(qianfan_ocr.__file__).parent)!r})
            import qianfan_ocr
            qianfan_ocr.cached_snapshot = lambda m, r: "/hf"
            def load(path):
                raise MemoryError("out of memory loading the model")
            qianfan_ocr.load_model = load
            sys.exit(qianfan_ocr.main(sys.argv[1:]))
            """
        )
    )
    result = subprocess.run(
        [sys.executable, str(stub), "extract-batch"],
        input=requests,
        capture_output=True,
        text=True,
        env={"PATH": "/usr/bin:/bin", "XDG_CACHE_HOME": str(tmp_path / "cache")},
        timeout=30,
    )
    assert result.returncode != 0
    assert result.stdout == ""
    assert "out of memory loading the model" in result.stderr


def test_extract_loads_once_and_returns_what_it_read(tmp_path, fake_model):
    (a,) = _images(tmp_path, "letter.png")
    result = qianfan_ocr.extract(a, "Read it", "baidu/Qianfan-OCR", "abc", 64)
    assert fake_model.loads == ["/hf/baidu/Qianfan-OCR@abc"]
    assert fake_model.generated == [(a, "Read it", 64)]
    assert set(result) == {
        "model",
        "revision",
        "device",
        "dtype",
        "prompt",
        "rawOutput",
        "parsed",
        "lockWaitMs",
        "loadMs",
        "generateMs",
    }
    assert result["rawOutput"] == '{"text": "letter"}'
    assert result["parsed"] == {"text": "letter"}
    assert (result["device"], result["dtype"]) == ("cpu", "float32")
    assert (result["model"], result["revision"], result["prompt"]) == (
        "baidu/Qianfan-OCR",
        "abc",
        "Read it",
    )
    assert result["generateMs"] == 7


def _holder(lock):
    return json.loads((Path(lock).parent / "holder.json").read_text())


def _hold_lock(lock, seconds, holder=None):
    """A process that holds the lock for seconds, recording holder in holder.json."""
    process = subprocess.Popen(
        [
            sys.executable,
            "-c",
            textwrap.dedent(
                f"""
                import fcntl, json, os, time
                f = open({str(lock)!r}, "a")
                fcntl.flock(f, fcntl.LOCK_EX)
                holder = {holder!r}
                if holder is not None:
                    holder = {{**holder, "pid": os.getpid()}}
                    with open({str(Path(lock).parent / "holder.json")!r}, "w") as h:
                        json.dump(holder, h)
                print("held", flush=True)
                time.sleep({seconds})
                """
            ),
        ],
        stdout=subprocess.PIPE,
        text=True,
    )
    assert process.stdout.readline().strip() == "held"
    return process


def test_model_lock_records_its_holder_and_removes_it_on_release(tmp_path):
    lock = tmp_path / "model.lock"
    with model_lock(lock, owner={"command": "extract-batch", "batchId": "batch-1"}):
        holder = _holder(lock)
    assert holder["pid"] == os.getpid()
    assert holder["parentPid"] == os.getppid()
    assert holder["command"] == "extract-batch"
    assert holder["batchId"] == "batch-1"
    assert holder["startedAt"].endswith("Z")
    assert not (tmp_path / "holder.json").exists()
    assert [p.name for p in tmp_path.iterdir()] == ["model.lock"]


def test_model_lock_leaves_a_holder_record_another_process_wrote(tmp_path):
    lock = tmp_path / "model.lock"
    with model_lock(lock):
        (tmp_path / "holder.json").write_text(json.dumps({"pid": 1}))
    assert _holder(lock) == {"pid": 1}


def test_a_waiter_says_who_holds_the_lock(tmp_path, capsys):
    lock = tmp_path / "model.lock"
    holder = _hold_lock(lock, 0.6, {"command": "extract-batch", "batchId": "batch-7"})
    try:
        with model_lock(lock, is_helper=lambda pid: pid == holder.pid):
            pass
    finally:
        holder.wait(timeout=5)
    waiting = capsys.readouterr().err
    assert f"held by pid {holder.pid}" in waiting
    assert "batch-7" in waiting


def test_a_waiter_does_not_name_a_holder_that_is_not_a_live_helper(tmp_path, capsys):
    lock = tmp_path / "model.lock"
    holder = _hold_lock(lock, 0.6, {"command": "extract-batch", "batchId": "batch-7"})
    try:
        with model_lock(lock, is_helper=lambda pid: False):
            pass
    finally:
        holder.wait(timeout=5)
    waiting = capsys.readouterr().err
    assert "held by an unknown process" in waiting
    assert "batch-7" not in waiting


def test_model_lock_gives_up_after_its_timeout_naming_the_holder(tmp_path):
    lock = tmp_path / "model.lock"
    holder = _hold_lock(lock, 5, {"command": "extract", "batchId": "ocr-a"})
    try:
        start = time.monotonic()
        with pytest.raises(qianfan_ocr.HelperError, match=f"held by pid {holder.pid}"):
            with model_lock(lock, timeout=0.5, is_helper=lambda pid: True):
                pass
        assert time.monotonic() - start < 3
    finally:
        holder.kill()
        holder.wait(timeout=5)


def test_lock_timeout_and_batch_id_are_read_from_the_command_line():
    args = build_parser().parse_args(
        ["--watch-stdin", "extract-batch", "--batch-id=batch-1", "--lock-timeout=30"]
    )
    assert args.watch_stdin is True
    assert (args.batch_id, args.lock_timeout) == ("batch-1", 30.0)
    args = build_parser().parse_args(["extract", "--image=a", "--prompt=p"])
    assert (args.watch_stdin, args.batch_id, args.lock_timeout) == (False, None, None)


def _stub_helper(tmp_path):
    """The real script with a stub model, at a path named qianfan_ocr.py; each
    image takes STUB_GENERATE_S seconds."""
    stub = tmp_path / "stub" / "qianfan_ocr.py"
    stub.parent.mkdir()
    stub.write_text(
        textwrap.dedent(
            f"""
            import importlib.util, os, sys, time
            spec = importlib.util.spec_from_file_location("real", {str(qianfan_ocr.__file__)!r})
            helper = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(helper)
            helper.cached_snapshot = lambda m, r: "/hf"
            helper.load_model = lambda path: {{"device": "cpu", "dtype": "float32"}}
            def generate(loaded, image, prompt, max_new_tokens):
                time.sleep(float(os.environ.get("STUB_GENERATE_S", "0")))
                return "{{}}", 1
            helper.generate_one = generate
            sys.exit(helper.main(sys.argv[1:]))
            """
        )
    )
    return stub


def _lock_is_free(lock):
    with open(lock, "a") as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return False
        fcntl.flock(handle, fcntl.LOCK_UN)
        return True


def _alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    # A zombie still answers kill 0; ps shows it as Z.
    state = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True)
    return bool(state.stdout.strip()) and not state.stdout.strip().startswith("Z")


def _wait_for(condition, seconds):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if condition():
            return True
        time.sleep(0.1)
    return condition()


def test_the_helper_exits_when_its_parent_is_killed_mid_batch(tmp_path):
    """A parent holds the helper's stdin, stdout and stderr, as swamp does;
    SIGKILL it part way through a batch and the helper must exit and free the
    lock at once, though its stderr is now a broken pipe too. Each image takes
    30s, so finishing the current one before exiting fails the test."""
    stub = _stub_helper(tmp_path)
    cache = tmp_path / "cache"
    lock = cache / "qianfan-ocr" / "model.lock"
    images = _images(tmp_path, *[f"{n}.png" for n in range(20)])
    requests = _requests(
        [{"id": str(n), "image": image, "prompt": "p", "maxNewTokens": 1} for n, image in enumerate(images)]
    )
    parent = subprocess.Popen(
        [
            sys.executable,
            "-c",
            textwrap.dedent(
                f"""
                import subprocess, sys, time
                helper = subprocess.Popen(
                    [sys.executable, {str(stub)!r}, "--watch-stdin", "extract-batch", "--batch-id=b1"],
                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                )
                helper.stdin.write({requests.encode()!r})
                helper.stdin.flush()
                print(helper.pid, flush=True)
                time.sleep(600)
                """
            ),
        ],
        stdout=subprocess.PIPE,
        text=True,
        env={"PATH": "/usr/bin:/bin", "XDG_CACHE_HOME": str(cache), "STUB_GENERATE_S": "30"},
    )
    helper_pid = int(parent.stdout.readline())
    try:
        assert _wait_for(lambda: (lock.parent / "holder.json").exists(), 10)
        assert _holder(lock)["batchId"] == "b1"
        parent.kill()
        parent.wait(timeout=5)
        assert _wait_for(lambda: not _alive(helper_pid), 5), "helper outlived its parent"
        assert _lock_is_free(lock)
    finally:
        if _alive(helper_pid):
            os.kill(helper_pid, signal.SIGKILL)

    # The next batch after the killed one takes the lock and finishes. It runs
    # without --watch-stdin: subprocess.run closes stdin once it is written.
    result = subprocess.run(
        [sys.executable, str(stub), "extract-batch", "--lock-timeout=10"],
        input=_requests([{"id": "0", "image": images[0], "prompt": "p", "maxNewTokens": 1}]),
        capture_output=True,
        text=True,
        env={"PATH": "/usr/bin:/bin", "XDG_CACHE_HOME": str(cache)},
        timeout=30,
    )
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout.splitlines()[-1]) == {"type": "end", "count": 1}


def test_without_watch_stdin_a_closed_stdin_does_not_stop_the_helper(tmp_path):
    stub = _stub_helper(tmp_path)
    (a,) = _images(tmp_path, "a.png")
    result = subprocess.run(
        [sys.executable, str(stub), "extract", f"--image={a}", "--prompt=p"],
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        env={"PATH": "/usr/bin:/bin", "XDG_CACHE_HOME": str(tmp_path / "cache"), "STUB_GENERATE_S": "0.5"},
        timeout=30,
    )
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout)["rawOutput"] == "{}"
