# @zts/qianfan-ocr

Run [Qianfan-OCR][model] (`baidu/Qianfan-OCR`), a vision-language model, on your
own machine to read text or structured details from an image. You give the
prompt, so the same behavior transcribes a page, pulls the fields off an
invoice, or answers a question about a screenshot.

The model runs in a Python helper that [uv][uv] runs, so torch and transformers
stay out of swamp's Deno runtime. Nothing leaves the machine once the model is
installed.

[model]: https://huggingface.co/baidu/Qianfan-OCR
[uv]: https://docs.astral.sh/uv/

## Requirements

- macOS on Apple silicon, or Linux (x86_64 or aarch64). torch has no wheels for
  Intel Macs, and the helper's lock file needs POSIX `flock`, so not Windows.
- uv on `PATH`, or at `uvPath`.
- Disk: the model is about 9.5GB in the Hugging Face cache. The Python
  environment (torch, transformers) is about 800MB on Apple silicon. On Linux
  x86_64, torch brings the NVIDIA CUDA libraries: about 3GB to download and
  several GB more once installed.
- Memory: loading the model takes about 10GB. On Apple silicon it runs on MPS,
  on NVIDIA on CUDA, and otherwise on the CPU (slowly).

## Usage

```sh
swamp extension pull @zts/qianfan-ocr
swamp behavior create @zts/qianfan-ocr ocr
swamp behavior run ocr install
```

`install` builds the helper's Python environment and downloads the model. It
skips whatever is already there, so run it as often as you like, and run it
again after each `swamp extension update`. On this author's Mac the first
install took 1.5s with the model already downloaded and uv's cache already
holding torch, and a repeat took 0.4s. From nothing, expect to download about
10GB (13GB on Linux x86_64).

```sh
swamp behavior run ocr extract \
  --input imagePath=scans/page-1.png \
  --input 'prompt=Transcribe all the text in this image.'

swamp behavior run ocr extract \
  --input imagePath=/tmp/invoice.png \
  --input 'prompt=Return JSON with keys "supplier", "invoice_number" and "total".' \
  --input name=invoice-0042
```

Each `extract` writes an `ocr` resource named `ocr-` and the image file's stem
(or `ocr-` and `name`), so `scans/page-1.png` becomes `ocr-page-1`. `install`
writes one resource, `install`.

| Field                  | What                                            |
| ---------------------- | ----------------------------------------------- |
| `rawOutput`            | the model's answer, as generated                |
| `parsed`, `parsedOk`   | the JSON object in the answer, if there was one |
| `model`, `revision`    | which weights ran                               |
| `device`, `dtype`      | `mps`/`cuda`/`cpu` and `bfloat16`/`float32`     |
| `lockWaitMs`           | time spent waiting for another run to finish    |
| `loadMs`, `generateMs` | model load and generation time                  |
| `image`, `prompt`      | what was asked                                  |

On this author's Mac (MPS), loading the model took 14s and reading the sample
image took 19s, about 50s for the whole run.

### Many images: `extractBatch`

Loading the model takes most of an `extract`. `extractBatch` loads it once and
reads every image in the list with it, then exits, so a batch of letters pays
for one load instead of one per letter.

```sh
swamp behavior run ocr extractBatch --input 'items:json=[
  {"imagePath": "scans/page-1.png", "prompt": "Transcribe all the text."},
  {"imagePath": "scans/page-2.png", "prompt": "Transcribe all the text.", "name": "p2"}
]' --input name=scans
```

Each image gets the same `ocr` resource `extract` would write (`ocr-page-1`,
`ocr-p2`), with the batch's `loadMs` and `lockWaitMs` on each. The batch also
writes a `batch` resource, `batch-` and `name` (default: the time it started,
such as `batch-2026-11-02T21-53-21-794Z`), kept for 7 days:

| Field                             | What                                                   |
| --------------------------------- | ------------------------------------------------------ |
| `items[].status`                  | `ok`, `error` or `notRun`, in the order given          |
| `items[].record`, `recordVersion` | the `ocr` resource this batch wrote; null unless `ok`  |
| `items[].error`                   | why the image could not be read                        |
| `succeeded`, `failed`, `notRun`   | counts                                                 |
| `error`                           | why the helper stopped part way, if it did             |
| `loadMs`, `lockWaitMs`, `totalMs` | one model load, the wait for the lock, the whole batch |

**Read results through the batch record.** An image that fails leaves any
earlier `ocr-<name>` record in place, so the latest `ocr-<name>` may be from an
older run. `items[].record` and `recordVersion` name the record this batch
wrote; anything else is not this batch's result.

- **One bad image does not stop the batch.** A missing image or a failed
  generation is that item's `error`, and the rest are read. A batch where no
  image was read still succeeds, with a warning in the log.
- **A batch that dies part way keeps what it finished.** The helper reports each
  image as it is read, so if it is killed (for example for lack of memory), the
  images already read keep their `ocr` records, the rest are `notRun`, the batch
  record is written, and the method fails. If the helper fails before it has
  finished any image (the model is not installed, or it is killed or cancelled
  while reading the first one), nothing is written, not even the batch record or
  the errors for missing images, as with `extract`.
- **Cancelling a batch keeps what it finished, too.** Cancelling the swamp run
  stops the helper and releases the model lock; the images already read keep
  their `ocr` records, the rest are `notRun` on the batch record, and the run
  ends cancelled.
- **Progress arrives at the end.** The helper logs "item i of n" as it goes, but
  swamp shows the helper's output only once the batch has finished.
- **A batch holds the model for its whole run.** Other runs of `extract` or
  `extractBatch` on this machine wait until it ends, however long it is, unless
  they set `lockTimeoutSeconds` (below).
- Two images must not share a record name: give one a `name`, or the batch fails
  before it starts.

### Waiting for the model: `lockTimeoutSeconds`

`extract` and `extractBatch` wait for any other run on this machine to finish
with the model. By default they wait as long as it takes; with
`--input lockTimeoutSeconds=600` they give up after ten minutes and fail, naming
the run that holds the model. A run that had to wait logs who held the model,
but like all helper output it shows up only once the run ends.

### A helper left running: `stop`

The helper exits when the swamp process that started it goes away, even by
`kill -9`, so normally nothing is left behind. If one is still running, or a run
waits on the model lock and you want to know why, `stop` finds the helper that
holds the lock and stops it:

```sh
swamp behavior run ocr stop
```

It writes a `stop` resource, kept for 7 days:

| Field     | What                                                                       |
| --------- | -------------------------------------------------------------------------- |
| `found`   | `running` (a helper held the lock), `stale` (an old record), `none`        |
| `holder`  | the helper's `pid`, uv's `parentPid`, `startedAt`, `command` and `batchId` |
| `stopped` | whether it is gone now                                                     |
| `signal`  | `SIGTERM`, or `SIGKILL` if it had not exited 10 seconds after `SIGTERM`    |

- **It stops a helper started from any repo on this machine.** The model lock is
  machine-wide, so whichever helper holds it is the one stopped, whatever
  started it.
- **It only signals a qianfan-ocr helper.** The helper records its PID in
  `~/.cache/qianfan-ocr/holder.json` (under `XDG_CACHE_HOME` if set). A helper
  that was killed leaves that file behind, so `stop` acts only while the PID is
  still a process running `qianfan_ocr.py`; otherwise it reports `stale` and
  signals nothing.
- **Run it on the same instance after swamp has died.** swamp lets one method
  run at a time on an instance, but a lock left by a swamp process that is no
  longer running is released on the next run. If it is not, see
  `swamp datastore lock status`, and
  `swamp datastore lock release --force
  --model @zts/qianfan-ocr/<id>`. To
  stop a run whose swamp is still alive, cancel that run instead.

### Global arguments

| Argument | Default                  | What                                               |
| -------- | ------------------------ | -------------------------------------------------- |
| `uvPath` | `uv`                     | the uv executable                                  |
| `hfHome` | Hugging Face's own cache | where the model is kept, passed to uv as `HF_HOME` |

`install` and `extract` both take `model` and `revision`. The default revision
is a commit of `baidu/Qianfan-OCR` pinned in each release, so one version of
this extension always runs the same weights. Pass another revision to try a
newer one, and run `install` with it first.

## What to expect

- **`extract` never downloads.** It runs uv offline and Hugging Face offline. If
  the environment or the model is missing, or a release changed the
  environment's lock, it fails and says to run `install`. A failure after the
  helper started (for example the OS stopping it for lack of memory) is reported
  as the helper's error instead.
- **Each `extract` loads the model again**, which takes most of a run's time;
  use `extractBatch` for many images. Runs take turns: swamp's lock serialises
  runs on one instance, and the helper holds a lock file
  (`~/.cache/qianfan-ocr/model.lock`) across the whole machine, so runs from
  other instances or repos queue rather than load several copies at once.
- **Aborting a run stops the model.** Cancelling the swamp run stops uv and the
  Python process with it, and the model lock is released.
- **The helper goes when swamp goes.** swamp holds the helper's stdin open for
  the whole run; when it closes, because swamp exited, crashed or was killed,
  the helper stops at once and the model lock is released. `extractBatch` sends
  its list of images on stdin, so a killed run leaves no files behind.
- **The model's tokenizer is Qwen2's.** The helper loads it with
  `fix_mistral_regex=False`, which silences a transformers warning that misreads
  the model as a Mistral one; setting it to true would break tokenization.
- **Output varies by device.** MPS, CUDA and CPU can give slightly different
  answers to the same prompt.
- **The `ocr` resource keeps the prompt and the full answer** in the swamp
  datastore. If you read personal documents, personal data ends up there.
- **Pulled extensions get their own environment.** uv names the helper's
  environment after the script's path, so a pulled copy builds its own on first
  install, separate from a copy loaded from source. Updates reuse it and install
  only what changed.
- **`uv cache clean` deletes the environment.** Run `install` to build it again.
- **Pulling warns about binaries.** The files listed under `binaries` are the
  Python helper, `helper/qianfan_ocr.py`, and its uv lock. Read them before you
  run `install`.

## Development

```sh
~/.swamp/deno/deno test --no-config --allow-all
uv run --no-project --with pytest --with 'huggingface-hub>=2.4.0' \
  pytest -p no:cacheprovider helper/tests
```

The Python tests need no torch and no model. After changing the helper's
dependencies, lock again with `uv lock --script helper/qianfan_ocr.py`.

## License

MIT. Qianfan-OCR itself is under its own licence; see the model card.
