# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "huggingface-hub>=2.4.0",
#     "pillow>=10",
#     "torch>=2.5",
#     "torchvision>=0.20",
#     "transformers>=4.57",
# ]
# ///
"""Run Qianfan-OCR locally on one image, for the @zts/qianfan-ocr behavior.

Usage: qianfan_ocr.py [--watch-stdin] SUBCOMMAND ...

Subcommands print one JSON object on stdout; progress goes to stderr.
  install  [--model ID] [--revision SHA]
      Download the model at that revision into the Hugging Face cache, unless
      it is already there in full.
  extract  --image PATH --prompt TEXT [--model ID] [--revision SHA]
           [--max-new-tokens N] [--batch-id ID] [--lock-timeout SECONDS]
      Read the image with the model. Never downloads: a model that is not
      fully cached is an error that says to run install.
  extract-batch  [--model ID] [--revision SHA] [--batch-id ID]
                 [--lock-timeout SECONDS]
      Read many images with one load of the model. The first line of stdin is
      a JSON list of {"id", "image", "prompt", "maxNewTokens"}; the caller
      sends nothing more, and with --watch-stdin keeps stdin open until this
      exits. Prints JSON lines instead of
      one object: {"type": "start", ...}, then one {"type": "item", "id", ...}
      per image as it finishes (with "error" for an image that failed), then
      {"type": "end", "count"}. Each line is flushed as it is written, so a
      crash keeps the items that finished. Never downloads, like extract.

With --watch-stdin, the helper exits as soon as its stdin closes: the caller
holds it open for the whole run, so a caller that dies, even by SIGKILL, takes
the helper with it. uv run passes stdin through to this script.

While it holds the model lock, the helper records itself in holder.json beside
the lock: {"pid", "parentPid", "startedAt", "command", "batchId"}. A helper
that is killed leaves the file behind, so it names the holder only while that
PID is alive and a qianfan_ocr.py process. --batch-id is what it records as
batchId; --lock-timeout gives up waiting for the lock after that many seconds.

The first line on stderr is always STARTED, so the caller can tell a failure
of this script from uv failing before it ran. A handled error prints
{"error": "..."} on stdout and exits 1; for extract-batch, only before its
start line.

torch, transformers, PIL and huggingface_hub are imported inside functions, so
the module and its tests import with the standard library only.
"""

import argparse
import contextlib
import fcntl
import json
import os
import re
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

STARTED = "qianfan-ocr helper started"

DEFAULT_MODEL = "baidu/Qianfan-OCR"

# baidu/Qianfan-OCR main as of 2026-04-29. One extension version always runs
# the same weights; install and extract take --revision to choose others.
DEFAULT_REVISION = "623bf5d20d446abdb36606aa4547cd0c18886fe5"


class HelperError(Exception):
    """An error reported to the caller as {"error": ...} on stdout."""


def parse_model_json(raw):
    """Best-effort parse of a JSON object from model output; None if there isn't one."""
    fenced = re.search(r"```(?:json)?\s*(.*?)```", raw, re.DOTALL)
    candidate = fenced.group(1) if fenced else raw
    start, end = candidate.find("{"), candidate.rfind("}")
    if start == -1 or end < start:
        return None
    try:
        parsed = json.loads(candidate[start : end + 1])
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


def pick_device(mps_available, cuda_available):
    """The device and dtype name to run on: MPS, then CUDA, then CPU in float32."""
    if mps_available:
        return "mps", "bfloat16"
    if cuda_available:
        return "cuda", "bfloat16"
    return "cpu", "float32"


def lock_path():
    """The machine-wide lock file that runs of the model take turns on."""
    cache = os.environ.get("XDG_CACHE_HOME") or str(Path.home() / ".cache")
    return Path(cache) / "qianfan-ocr" / "model.lock"


def is_helper_process(pid):
    """Whether pid is a live process running qianfan_ocr.py, so a PID the OS
    has since given to something else is never taken for a helper."""
    result = subprocess.run(
        ["ps", "-o", "command=", "-p", str(pid)], capture_output=True, text=True
    )
    return result.returncode == 0 and "qianfan_ocr.py" in result.stdout


def read_holder(path):
    """The holder record beside the lock at path, or None."""
    try:
        holder = json.loads((Path(path).parent / "holder.json").read_text())
    except (OSError, json.JSONDecodeError):
        return None
    return holder if isinstance(holder, dict) else None


def describe_holder(holder, is_helper):
    """Who holds the lock, as far as a holder record that may be stale says."""
    pid = holder.get("pid") if holder else None
    if not isinstance(pid, int) or not is_helper(pid):
        return "held by an unknown process"
    return (
        f"held by pid {pid} ({holder.get('command')} {holder.get('batchId')}, "
        f"since {holder.get('startedAt')})"
    )


def write_holder(path, owner):
    """Record this process as the lock's holder, atomically."""
    holder = Path(path).parent / "holder.json"
    record = {
        "pid": os.getpid(),
        "parentPid": os.getppid(),
        "startedAt": datetime.now(timezone.utc).isoformat(timespec="seconds").replace(
            "+00:00", "Z"
        ),
        "command": None,
        "batchId": None,
        **(owner or {}),
    }
    temp = holder.with_name(f"holder.json.{os.getpid()}.tmp")
    temp.write_text(json.dumps(record))
    os.replace(temp, holder)


def remove_holder(path):
    """Remove the holder record, but only while it still names this process:
    the next holder may already have written its own."""
    holder = read_holder(path)
    if holder and holder.get("pid") == os.getpid():
        (Path(path).parent / "holder.json").unlink(missing_ok=True)


@contextlib.contextmanager
def model_lock(path, owner=None, timeout=None, is_helper=is_helper_process):
    """Hold an exclusive lock on path; yields {"ms": time spent waiting}.

    One model load needs about 10GB of memory, so runs from any swamp instance
    or repo on this machine load and generate one at a time. While it waits,
    it says who holds the lock; with timeout, it gives up after that many
    seconds. Once it has the lock, it records owner in holder.json.
    """
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    waited = {"ms": 0}
    with open(path, "a") as handle:
        start = time.monotonic()
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            held_by = describe_holder(read_holder(path), is_helper)
            print(
                f"waiting for the model lock {path}, {held_by}",
                file=sys.stderr,
                flush=True,
            )
            if timeout is None:
                fcntl.flock(handle, fcntl.LOCK_EX)
            else:
                while True:
                    try:
                        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                        break
                    except BlockingIOError:
                        if time.monotonic() - start >= timeout:
                            held_by = describe_holder(read_holder(path), is_helper)
                            raise HelperError(
                                f"gave up after {timeout:g}s waiting for the model "
                                f"lock {path}, {held_by}"
                            ) from None
                        time.sleep(0.2)
        waited["ms"] = int((time.monotonic() - start) * 1000)
        try:
            write_holder(path, owner)
            yield waited
        finally:
            remove_holder(path)
            fcntl.flock(handle, fcntl.LOCK_UN)


def cached_snapshot(model_id, revision):
    """The local path of a complete cached snapshot, or raise HelperError."""
    from huggingface_hub import snapshot_download
    from huggingface_hub.errors import LocalEntryNotFoundError

    try:
        return snapshot_download(model_id, revision=revision, local_files_only=True)
    except LocalEntryNotFoundError as error:
        raise HelperError(
            f"model {model_id}@{revision} is not in the Hugging Face cache; run install"
        ) from error


def install(model_id, revision):
    from huggingface_hub import snapshot_download

    try:
        path = cached_snapshot(model_id, revision)
        already = True
    except HelperError:
        print(f"downloading {model_id}@{revision}", file=sys.stderr, flush=True)
        path = snapshot_download(model_id, revision=revision)
        already = False
    return {
        "model": model_id,
        "revision": revision,
        "modelAlreadyCached": already,
        "path": path,
    }


def load_model(path):
    """Load the cached snapshot at path onto the best device; what generate_one needs."""
    import torch
    from transformers import AutoModelForImageTextToText, AutoProcessor

    device, dtype_name = pick_device(
        torch.backends.mps.is_available(), torch.cuda.is_available()
    )
    print(f"loading {path} on {device} ({dtype_name})", file=sys.stderr, flush=True)
    model = (
        AutoModelForImageTextToText.from_pretrained(path, dtype=getattr(torch, dtype_name))
        .to(device)
        .eval()
    )
    # The model's config.json has no transformers_version, so transformers
    # cannot rule out a Mistral tokenizer from a local path and warns about
    # Mistral's regex. The tokenizer is Qwen2's; fix_mistral_regex=True
    # would swap in Mistral's pre-tokenizer regex, so say False.
    processor = AutoProcessor.from_pretrained(path, fix_mistral_regex=False)
    return {"model": model, "processor": processor, "device": device, "dtype": dtype_name}


def generate_one(loaded, image, prompt, max_new_tokens):
    """The model's answer for one image and prompt, and the milliseconds it took."""
    import torch
    from PIL import Image

    model, processor, device = loaded["model"], loaded["processor"], loaded["device"]
    messages = [
        {
            "role": "user",
            "content": [
                {"type": "image", "image": Image.open(image).convert("RGB")},
                {"type": "text", "text": prompt},
            ],
        }
    ]
    inputs = processor.apply_chat_template(
        messages,
        add_generation_prompt=True,
        tokenize=True,
        return_dict=True,
        return_tensors="pt",
    ).to(device)

    print("generating", file=sys.stderr, flush=True)
    start = time.monotonic()
    with torch.no_grad():
        output_ids = model.generate(**inputs, max_new_tokens=max_new_tokens, do_sample=False)
    generated = output_ids[:, inputs["input_ids"].shape[1] :]
    raw = processor.batch_decode(generated, skip_special_tokens=True)[0].strip()
    return raw, int((time.monotonic() - start) * 1000)


def extract(image, prompt, model_id, revision, max_new_tokens, batch_id=None, lock_timeout=None):
    if not Path(image).is_file():
        raise HelperError(f"image not found: {image}")
    path = cached_snapshot(model_id, revision)

    owner = {"command": "extract", "batchId": batch_id}
    with model_lock(lock_path(), owner, lock_timeout) as waited:
        load_start = time.monotonic()
        loaded = load_model(path)
        load_ms = int((time.monotonic() - load_start) * 1000)
        raw, generate_ms = generate_one(loaded, image, prompt, max_new_tokens)

    return {
        "model": model_id,
        "revision": revision,
        "device": loaded["device"],
        "dtype": loaded["dtype"],
        "prompt": prompt,
        "rawOutput": raw,
        "parsed": parse_model_json(raw),
        "lockWaitMs": waited["ms"],
        "loadMs": load_ms,
        "generateMs": generate_ms,
    }


def read_requests(text):
    """The validated list of extract-batch requests in text, a line of JSON."""
    try:
        requests = json.loads(text)
    except json.JSONDecodeError as error:
        raise HelperError(f"cannot read requests from stdin: {error}") from error
    if not isinstance(requests, list):
        raise HelperError("requests must be a list of requests")
    if not requests:
        raise HelperError("requests must hold at least one request")
    seen = set()
    for request in requests:
        if not isinstance(request, dict):
            raise HelperError("each request must be an object")
        for key, kind in (("id", str), ("image", str), ("prompt", str), ("maxNewTokens", int)):
            if not isinstance(request.get(key), kind):
                raise HelperError(f"request {request.get('id')!r} needs {key}")
        if request["id"] in seen:
            raise HelperError(f"duplicate id in requests: {request['id']}")
        seen.add(request["id"])
    return requests


def extract_batch(requests, model_id, revision, emit, batch_id=None, lock_timeout=None):
    """Read every request with one load of the model, emitting a line per item.

    An image that is missing or fails to generate is reported on its own
    item; the rest still run. The model not being cached fails before the
    lock is taken or anything is emitted.
    """
    path = cached_snapshot(model_id, revision)

    owner = {"command": "extract-batch", "batchId": batch_id}
    with model_lock(lock_path(), owner, lock_timeout) as waited:
        load_start = time.monotonic()
        loaded = load_model(path)
        emit(
            {
                "type": "start",
                "model": model_id,
                "revision": revision,
                "device": loaded.get("device"),
                "dtype": loaded.get("dtype"),
                "lockWaitMs": waited["ms"],
                "loadMs": int((time.monotonic() - load_start) * 1000),
            }
        )
        for n, request in enumerate(requests, 1):
            print(f"item {n} of {len(requests)}", file=sys.stderr, flush=True)
            item = {"type": "item", "id": request["id"]}
            if not Path(request["image"]).is_file():
                emit({**item, "error": f"image not found: {request['image']}"})
                continue
            try:
                raw, generate_ms = generate_one(
                    loaded, request["image"], request["prompt"], request["maxNewTokens"]
                )
            except Exception as error:  # one bad image must not stop the batch
                emit({**item, "error": f"{type(error).__name__}: {error}"})
                continue
            emit(
                {
                    **item,
                    "rawOutput": raw,
                    "parsed": parse_model_json(raw),
                    "generateMs": generate_ms,
                }
            )
        emit({"type": "end", "count": len(requests)})


def exit_when_stdin_closes():
    """Exit the process, from a daemon thread, once stdin reaches EOF.

    os._exit skips cleanup, but the kernel frees the model lock and memory
    when the process ends; holder.json is left for readers to see is stale.
    """

    def watch():
        try:
            while os.read(0, 4096):
                pass
            print("stdin closed: the caller has gone, stopping", file=sys.stderr, flush=True)
        except OSError:
            pass  # stderr went with the caller: a broken pipe must not stop the exit
        finally:
            os._exit(1)

    threading.Thread(target=watch, name="stdin-watch", daemon=True).start()


def emit_line(obj):
    """Write one JSON line to stdout and flush it at once."""
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def build_parser():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--watch-stdin", action="store_true")
    sub = parser.add_subparsers(dest="command", required=True)

    i = sub.add_parser("install")
    i.add_argument("--model", default=DEFAULT_MODEL)
    i.add_argument("--revision", default=DEFAULT_REVISION)

    e = sub.add_parser("extract")
    e.add_argument("--image", required=True)
    e.add_argument("--prompt", required=True)
    e.add_argument("--model", default=DEFAULT_MODEL)
    e.add_argument("--revision", default=DEFAULT_REVISION)
    e.add_argument("--max-new-tokens", type=int, default=1024)

    b = sub.add_parser("extract-batch")
    b.add_argument("--model", default=DEFAULT_MODEL)
    b.add_argument("--revision", default=DEFAULT_REVISION)

    for command in (e, b):
        command.add_argument("--batch-id")
        command.add_argument("--lock-timeout", type=float)
    return parser


def main(argv=None):
    print(STARTED, file=sys.stderr, flush=True)
    args = build_parser().parse_args(argv)
    # The requests come first, so the stdin watcher only ever sees the close.
    requests_line = sys.stdin.buffer.readline() if args.command == "extract-batch" else b""
    if args.watch_stdin:
        exit_when_stdin_closes()
    try:
        if args.command == "install":
            result = install(args.model, args.revision)
        elif args.command == "extract-batch":
            requests = read_requests(requests_line)
            extract_batch(
                requests,
                args.model,
                args.revision,
                emit_line,
                args.batch_id,
                args.lock_timeout,
            )
            return 0
        else:
            result = extract(
                args.image,
                args.prompt,
                args.model,
                args.revision,
                args.max_new_tokens,
                args.batch_id,
                args.lock_timeout,
            )
    except HelperError as error:
        json.dump({"error": str(error)}, sys.stdout)
        print()
        return 1
    json.dump(result, sys.stdout)
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
