# @zts/home-mail-room

File your scanned post. Drop scanned letters (PDFs) into a folder; this
extension reads who sent each one and when, files it into a cabinet of sender
folders, and puts the ones it is not sure about on a local review page for you
to settle. The reading is done on your machine by an installed
[`@zts/qianfan-ocr`][qianfan] behavior. Nothing leaves the machine.

[qianfan]: https://swamp-club.com/extensions/@zts/qianfan-ocr

## How it fits together

```
Inbound/Incoming ──scanner──► Inbound/ReadyToFile ──filer──► FileCabinet/<Sender>/…
        │                              │                     + original to Inbound/Archived
        └──► Inbound/Failed            │ held for a person
             (could not be read)       ▼
                                review page ──► filed, or Inbound/Skipped
```

| Behavior                      | Moves letters out of | Methods                     |
| ----------------------------- | -------------------- | --------------------------- |
| `@zts/home-mail-room/scanner` | `Incoming`           | `listIncoming`, `scanBatch` |
| `@zts/home-mail-room/filer`   | `ReadyToFile`        | `fileReady`, `decide`       |
| `@zts/home-mail-room/review`  | none                 | `serve`                     |

Each folder has one behavior that takes letters out of it, so two behaviors
never move the same file. They are separate behaviors, not methods on one, so
each has its own lock: reading a large pile of post holds the scanner for
minutes, and the review page's decisions go to the filer meanwhile.

The folders are the truth. A letter is known by its content (its SHA-256), not
its file name, so:

- a letter read before is not read again, wherever it turns up;
- a copy of a letter already filed goes straight to `Archived`;
- to retry a failed or skipped letter, move it back into `Incoming` (to read it
  again) or `ReadyToFile` (to review it again).

## Requirements

Everything `@zts/qianfan-ocr` needs: macOS on Apple silicon or Linux, uv, about
10GB of disk for the model and about 10GB of memory to run it. The scanner needs
`@zts/qianfan-ocr` 2026.11.03.1 or later, which has `extractBatch`. The review
page needs `swamp` on the `PATH` of the process that runs it.

## Setup

```sh
swamp extension pull @zts/qianfan-ocr
swamp behavior create @zts/qianfan-ocr qianfan-ocr
swamp behavior run qianfan-ocr install

swamp extension pull @zts/home-mail-room
swamp behavior create @zts/home-mail-room/scanner scanner \
  --global-arg inboundDir=Inbound
swamp behavior create @zts/home-mail-room/filer filer \
  --global-arg inboundDir=Inbound --global-arg cabinetDir=FileCabinet
swamp behavior create @zts/home-mail-room/review review
```

The workflow uses the behaviors named `scanner` and `filer`. Give the scanner
and the filer the same `inboundDir`. Paths are absolute, or relative to the
repository.

| Behavior | Global argument | Default       | What                                       |
| -------- | --------------- | ------------- | ------------------------------------------ |
| scanner  | `inboundDir`    | `Inbound`     | holds Incoming, ReadyToFile and Failed     |
| scanner  | `ocrBehavior`   | `qianfan-ocr` | the installed `@zts/qianfan-ocr` behavior  |
| filer    | `inboundDir`    | `Inbound`     | holds ReadyToFile, Archived and Skipped    |
| filer    | `cabinetDir`    | `FileCabinet` | the sender folders letters are filed into  |
| filer    | `scanner`       | `scanner`     | the scanner whose details it files from    |
| filer    | `retention`     | `30d`         | how long a filed or skipped letter is kept |
| review   | `filer`         | `filer`       | the filer whose letters the page shows     |

The filer files a letter on its own only into a sender folder that already
exists in the cabinet. Create a folder for each sender you want filed without
asking; a letter from anyone else waits on the review page, where you can name a
new folder.

## Usage

Put scanned letters in `Inbound/Incoming`, then:

```sh
swamp workflow run @zts/home-mail-room/process-incoming
```

| Input        | Default | What                                           |
| ------------ | ------- | ---------------------------------------------- |
| `batchSize`  | `20`    | letters read with each load of the model       |
| `maxBatches` | `0`     | most batches this run; 0 reads all of Incoming |
| `fraction`   | `0.25`  | share of the first page, from the top, to read |

The run lists `Incoming` in batches, reads each batch in its own step, one at a
time, and then files everything waiting in `ReadyToFile`, including letters
earlier runs left there.

For each batch, the scanner reads the top of every letter's first page with one
`extractBatch`, then the whole first page of any letter whose top showed no
sender or date, with a second one while the model is loaded. It writes what it
read as `details-<short hash>` and the image it read from as
`header-<short hash>`, then moves the letter:

| What happened                                  | Letter goes to                                       |
| ---------------------------------------------- | ---------------------------------------------------- |
| read (even with fields missing)                | `ReadyToFile`                                        |
| read before                                    | `ReadyToFile`, without reading it again              |
| not a PDF, the model failed, or no JSON answer | `Failed`                                             |
| the model could not run the batch              | stays in `Incoming`; the step fails, the run goes on |

The details are written before the letter moves, so a run that stops between the
two reads the letter again next time, and no worse. `scan-batch-<run>-<n>`
records what happened to each letter in a batch. A letter read before keeps its
old details, from whenever it was read: the log and the run-summary name each
one and when it was read. To read one again, delete its `details-<short hash>`
first.

A batch renders its images into a `home-mail-room-scan-*` folder in the system
temp folder and removes it when it ends. A batch whose process is killed cannot,
so the next batch removes any such folder over a day old.

The filer then reviews each letter in `ReadyToFile`. It files a letter whose
sender matches a cabinet folder and whose date and document type were read:

```
FileCabinet/<Sender>/<YYYY-MM-DD> <Sender> <type>.pdf
```

The type is one of bill, statement, invoice, reminder, notice, receipt or other,
as the model read it, except that a letter whose first page is at least 1.8
times as tall as it is wide is a receipt, whatever the model said: that is the
shape of a till or card receipt.

A copy goes into the cabinet, is checked against the original, and the original
moves to `Archived`. It never writes over another file: a letter whose
destination is taken is held as a conflict. Everything it cannot file is held
for you, in `ReadyToFile`, with the reasons. Dates are read day first, as UK
post writes them.

A sender matches a folder whatever its case or spacing. The sender proposed for
a held letter is put in title case when it was read all in capitals (five
letters or more, so HMRC stays) or all in lower case: each word capitalised,
except articles and short prepositions and conjunctions after the first. In a
sender read in capitals, words with no vowels (HSBC, BT, PLC) and UK and USA are
taken as initials and stay in capitals. Mixed case is kept as read.
`HSBC UK BANK PLC` is proposed as `HSBC UK Bank PLC`, and
`LONDON BOROUGH OF HACKNEY` as `London Borough of Hackney`.

At the end of the run, the `@zts/home-mail-room/run-summary` report shows what
happened to each letter: read, read before, sent to `Failed` or left in
`Incoming`, then filed, held for review and why, or archived as a copy of a
letter already filed. To see it again later:

```sh
swamp report get @zts/home-mail-room/run-summary \
  --workflow @zts/home-mail-room/process-incoming
```

Swamp keeps the last five runs' reports, for 30 days.

## Reviewing held letters

```sh
swamp behavior run review serve
```

opens the review page on `http://127.0.0.1:8787/` (`--input port=…` to change
it) until Ctrl-C. Each held letter shows beside the part of it that was read,
with the proposed sender, date, type and title. Edit any of them, see where it
will be filed, and file it, or choose "Don't file" to move it to `Skipped`.
Decisions show at once and reach the filer a few at a time in the background;
one the filer refuses comes back with its reason.

The page is its own behavior so a review session never holds the filer, and it
sends decisions through the swamp CLI because a method may call another behavior
with `runModel` only 100 times per run.

Every decision the page sends is a run of the filer's `decide`, and after every
`decide` and `fileReady` the `@zts/home-mail-room/letters` report lists what
that run did, the letters still waiting for review, and every letter filed or
skipped in the last `retention`, newest first, saying whether the filer or a
person decided it. Its latest version is the log of what has been filed:

```sh
swamp report get @zts/home-mail-room/letters --behavior filer
```

To decide without the page:

```sh
swamp behavior run filer decide --literal-inputs --input \
  '{"decisions":[{"letter":"letter-0123456789abcdef","action":"file","sender":"Thames Water"}]}'
```

## Data

| Behavior | Record                 | Kept                                       |
| -------- | ---------------------- | ------------------------------------------ |
| scanner  | `details-<hash>`       | 90 days                                    |
| scanner  | `header-<hash>` (PNG)  | 90 days                                    |
| scanner  | `incoming-<run>`       | 7 days                                     |
| scanner  | `scan-batch-<run>-<n>` | 7 days                                     |
| filer    | `letter-<hash>`        | while held; `retention` once filed/skipped |
| filer    | `header-<hash>` (PNG)  | as its letter                              |
| filer    | `file-ready`           | 7 days, last 10 runs                       |
| filer    | `decisions`            | 7 days, last 10 runs                       |

`file-ready` and `decisions` record what the filer's last `fileReady` and
`decide` runs did to each letter: filed, held and why, a duplicate archived, or
a decision refused.

`swamp data gc` deletes what has expired; run it now and then, or from a
scheduled workflow.

## Developing

```sh
deno test --allow-read --allow-write --allow-env
```

The review page's source is `review/index.html`. Extensions ship only code and
text files, so the page goes out as `review_page.ts`; rebuild it after changing
the page:

```sh
deno run --allow-read=. --allow-write=. review/build.ts
```
