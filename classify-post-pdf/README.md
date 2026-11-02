# @zts/classify-post-pdf

Read the key details off a scanned letter (PDF): who sent it, when, who it is
for, what kind of document it is, and its reference numbers. Point it at a
directory of scanned post and it records each letter as typed data you can
query, sort or act on.

`scan` renders the top of a page with [PDFium][pdfium] compiled to WebAssembly,
inside swamp, then asks an installed [`@zts/qianfan-ocr`][qianfan] behavior to
read it with a letter prompt. Nothing leaves the machine.

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
swamp behavior create @zts/classify-post-pdf post
```

If your qianfan-ocr behavior has another name, pass it as the global argument
`ocrBehavior`. If it is missing or not installed, `scan` fails with the setup
commands above in its error.

This was tested with `@zts/qianfan-ocr` 2026.11.02.1.

## Usage

```sh
swamp behavior run post scan --input pdfPath=scans/letter.pdf
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

To read a whole directory, one letter at a time:

```sh
swamp workflow run @zts/classify-post-pdf/scan-mail --input directory=scans
```

The workflow lists the PDFs with `listPdfs`, then scans each. A letter that
fails does not stop the rest.

## What it records

Each scan writes two records named after the file and its contents, for
example `scans/Water bill.pdf` becomes `details-Water-bill-1a2b3c4d5e6f7a8b`
and `header-Water-bill-1a2b3c4d5e6f7a8b`:

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

Scanning the same file again adds a version to its records (100 are kept). A
different letter saved under a reused name, such as a scanner's `scan0001.pdf`,
gets its own records, because its contents differ. `listPdfs` refuses a
directory where two files would share records: the same contents under names
that differ only in punctuation.

## What to expect

- **Each letter loads the model again.** That is most of a scan's time: about
  50s a letter on this author's Mac. Scans take turns on the model across the
  machine.
- **Local only.** `scan` calls qianfan-ocr through swamp's `runModel`, which
  remote workers do not offer.
- **qianfan-ocr keeps its own record** of each read, under its own behavior.
  Its `image` field names a temporary file that `scan` has already removed; the
  image is kept here as `header`.
- **Personal data.** `details` and `header` hold what your letters say, as do
  qianfan-ocr's records, in the swamp datastore.
- **Only the image is read.** A PDF's text layer, if it has one, is not used.

## Development

```sh
~/.swamp/deno/deno test --no-config --allow-all
```

The tests render the synthetic letter in `testdata/` with the real PDFium; they
need no model. `testdata/make_sample_letter.py` regenerates it
(`uv run --script testdata/make_sample_letter.py`); everything in it is made
up.

## License

MIT.
