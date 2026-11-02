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
- **Each `extract` loads the model again**, which takes most of a run's time.
  Runs take turns: swamp's lock serialises runs on one instance, and the helper
  holds a lock file (`~/.cache/qianfan-ocr/model.lock`) across the whole
  machine, so runs from other instances or repos queue rather than load several
  copies at once.
- **Aborting a run stops the model.** Cancelling the swamp run stops uv and the
  Python process with it, and the model lock is released.
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
