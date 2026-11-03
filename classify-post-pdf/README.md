# @zts/classify-post-pdf

Read the key details off a scanned letter (PDF): who sent it, when, who it is
for, what kind of document it is, and its reference numbers. Point it at a
directory of scanned post and it records each letter as typed data you can
query, sort or act on.

`scan` renders the top of a page with [PDFium][pdfium] compiled to WebAssembly,
inside swamp, then asks an installed [`@zts/qianfan-ocr`][qianfan] behavior to
read it with a letter prompt. `scanBatch` does the same for many letters with
one load of the model. Nothing leaves the machine.

[pdfium]: https://pdfium.googlesource.com/pdfium/
[qianfan]: https://swamp-club.com/extensions/@zts/qianfan-ocr

## Requirements

Everything `@zts/qianfan-ocr` needs: macOS on Apple silicon or Linux, uv, about
10GB of disk for the model and about 10GB of memory to run it. This extension
adds no requirements of its own: no Python and no other programs.

## Setup

Set up `@zts/qianfan-ocr` first. `scan` uses an existing qianfan-ocr behavior
and never creates one, so the uv path and model cache are the ones you set.

```sh
swamp extension pull @zts/qianfan-ocr
swamp behavior create @zts/qianfan-ocr qianfan-ocr
# Optional: --global-arg uvPath=/path/to/uv, --global-arg hfHome=/path/to/cache
swamp behavior run qianfan-ocr install

swamp extension pull @zts/classify-post-pdf
swamp behavior create @zts/classify-post-pdf classify-post-pdf
```

If your qianfan-ocr behavior has another name, pass it as the global argument
`ocrBehavior`. If it is missing or not installed, `scan` fails with the setup
commands above in its error.

`scanBatch` and the `scan-mail` workflow need `@zts/qianfan-ocr` 2026.11.03.1 or
later, which has `extractBatch`. With an older one they fail saying so. To
update, pull it and run its install again, since the new helper may need its
environment rebuilt:

```sh
swamp extension pull @zts/qianfan-ocr
swamp behavior run qianfan-ocr install
```

This was tested with `@zts/qianfan-ocr` 2026.11.03.1.

## Usage

```sh
swamp behavior run classify-post-pdf scan --input pdfPath=scans/letter.pdf
```

| Input          | Default        | What                                |
| -------------- | -------------- | ----------------------------------- |
| `pdfPath`      |                | the PDF; absolute, or repo-relative |
| `page`         | `1`            | which page to read                  |
| `fraction`     | `0.25`         | share of the page, from the top     |
| `dpi`          | `200`          | render resolution, 50 to 600        |
| `prompt`       | the letter one | replace the prompt                  |
| `maxNewTokens` | `1024`         | most tokens the model may generate  |

The top quarter of the first page usually holds the letterhead, date, address
block and references. Reading less of the page is faster and keeps the body of
the letter out of the model.

To read many letters with one load of the model:

```sh
swamp behavior run classify-post-pdf scanBatch \
  --input 'pdfPaths=["scans/a.pdf","scans/b.pdf"]'
```

`scanBatch` takes `page`, `fraction`, `dpi`, `prompt` and `maxNewTokens` as
`scan` does, applied to every letter, and exactly one of:

| Input      | What                                                                                                           |
| ---------- | -------------------------------------------------------------------------------------------------------------- |
| `pdfPaths` | the PDFs; absolute, or repo-relative                                                                           |
| `list`     | a list `listPdfs` wrote on this behavior: the `run` it was given, or the list's full name (`pdf-list` if none) |

It renders every PDF, has qianfan-ocr read them all with one `extractBatch`
call, then writes each letter's `details` and `header` as `scan` does. A PDF
that cannot be read or rendered is never sent, and a letter the model fails on
gets no records; both are recorded as failed in the `scan-batch` record (below)
and the rest go on. Each letter's result is read through qianfan-ocr's batch
record, at the version that batch wrote, never by its latest name. Two files
that would share records are sent once, with a warning.

`scanBatch` fails, after writing every record it can, when:

- the batch failed before any letter (qianfan-ocr missing, not installed or too
  old), with how to fix it in the error;
- qianfan-ocr's helper failed part way, such as a crash: the letters it read
  before then keep their records, and the rest are `notRun`;
- letters were given but none was read.

Given no PDFs, as for an empty directory, it writes an empty `scan-batch` record
and succeeds.

To read a whole directory:

```sh
swamp workflow run @zts/classify-post-pdf/scan-mail --input directory=scans
```

The workflow lists the PDFs with `listPdfs`, then reads them all with one
`scanBatch`, using the `classify-post-pdf` behavior created above (or creating
it if it is missing). The model loads once for the whole directory. The run view
shows one scan step rather than each letter's progress; the `scan-batch` record
says how each one went. A letter that fails does not stop the rest, but a helper
crash part way fails the run, keeping what was read. Symlinks to PDFs are
followed; a broken link is skipped with a warning. Each run keeps its list as
`pdf-list-<run id>`, so runs started together each scan their own directory.
These lists expire after 7 days, and `swamp data gc` removes them.

## What it records

Each scan writes two records named after the file and its contents, for example
`scans/Water bill.pdf` becomes `details-Water-bill-1a2b3c4d5e6f7a8b` and
`header-Water-bill-1a2b3c4d5e6f7a8b`:

- `header`: the rendered region, as PNG.
- `details`:

| Field                                  | What                                                                                  |
| -------------------------------------- | ------------------------------------------------------------------------------------- |
| `sender`, `date`                       | who sent it, and its date as written                                                  |
| `recipient`, `recipientAddress`        | who it is for                                                                         |
| `documentType`                         | `bill`, `statement`, `invoice`, `reminder`, `notice`, `other`, or null if not visible |
| `documentTypeRaw`                      | the model's own words for the type                                                    |
| `referenceNumbers`                     | label to value, such as account number                                                |
| `otherDetails`                         | other facts, such as amount due                                                       |
| `parsedOk`, `rawOutput`                | whether the answer held JSON, and the answer itself                                   |
| `pdfPath`, `page`, `fraction`, `dpi`   | what was read                                                                         |
| `contentHash`                          | SHA-256 of the PDF                                                                    |
| `ocr`                                  | the qianfan-ocr record it came from                                                   |
| `model`, `revision`, `device`, timings | how it was read                                                                       |

Each `scanBatch` also writes `scan-batch-<run or time>-<random>`, kept 7 days
(the last 10): every PDF's `path`, record `name`, `status` (`ok`, `error` or
`notRun`), the `details` record written and the `error`; the qianfan-ocr `batch`
record the letters were read from; `succeeded`, `failed` and `notRun` counts;
`loadMs`; and the batch's `error`, if it failed part way.

Scanning the same file again adds a version to its records (100 are kept). A
different letter saved under a reused name, such as a scanner's `scan0001.pdf`,
gets its own records, because its contents differ. Two files share records only
when they hold the same contents under names that differ only in punctuation;
`listPdfs` keeps the first and logs a warning naming the one it skipped. Names
keep at most 64 characters of the file name.

## What to expect

- **`scan` loads the model for each letter; `scanBatch` loads it once.** On this
  author's Mac (MPS), reading the sample letter took 14s to load the model and
  14s to read it, 49s for the whole `swamp behavior run`. Scans take turns on
  the model across the machine.
- **A batch holds the behavior.** `scanBatch` holds the `classify-post-pdf`
  behavior for the whole batch, minutes for a large inbox, where the old
  workflow held it a letter at a time. Another `scan-mail` run's `listPdfs`, or
  a `scan`, waits behind it and can time out (`SWAMP_LOCK_TIMEOUT_MS`, 60s by
  default). Run large directories one at a time.
- **A crash is not a cancel.** When qianfan-ocr's helper crashes part way, the
  letters it read keep their `details` and `header`, and `scan-batch` records
  the rest. When the run itself is cancelled or times out while the batch is
  reading, `scanBatch` stops there: qianfan-ocr may keep the ocr records it
  wrote, but no `details`, `header` or `scan-batch` is written, and running it
  again reads those letters again.
- **Local only.** `scan` calls qianfan-ocr through swamp's `runModel`, which
  remote workers do not offer.
- **qianfan-ocr keeps its own record** of each read, under its own behavior. Its
  `image` field names a temporary file that `scan` has already removed; the
  image is kept here as `header`.
- **Personal data.** `details` and `header` hold what your letters say, as do
  qianfan-ocr's records, in the swamp datastore. `scan` keeps the letters'
  contents out of its logs; they name files and record names only.
- **Only the image is read.** A PDF's text layer, if it has one, is not used.

## Development

```sh
~/.swamp/deno/deno test --no-config --allow-all
```

The tests render the synthetic letter in `testdata/` with the real PDFium; they
need no model. `testdata/make_sample_letter.py` regenerates it
(`uv run --script testdata/make_sample_letter.py`); everything in it is made up.

## License

MIT.
