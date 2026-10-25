# @zts/cataas

Fetch random cats from [Cat as a Service](https://cataas.com) into swamp. The
`random` method calls `GET /cat?json=true`, checks the response, and records the
cat as the `cat` resource: its id, tags, absolute image URL, MIME type and when
it was added to cataas. Nothing is written when the request fails, times out
(after 10 seconds) or returns a body that is not a cat.

## Usage

```sh
swamp extension pull @zts/cataas
swamp behavior create @zts/cataas cat
swamp behavior run @zts/cataas random cat
```

Read the recorded cat:

```sh
swamp data query 'behavior("cat") && name == "random"' --select content
```

## The `cat` resource

```json
{
  "id": "kGtGSL9LeRyo1AS3",
  "tags": ["SWS"],
  "createdAt": "2024-06-17T09:17:52.803Z",
  "url": "https://cataas.com/cat/kGtGSL9LeRyo1AS3?position=center",
  "mimetype": "image/jpeg"
}
```

Each run writes a new version under the instance name `random`; the last 10
versions are kept.

## Configuration

None. The behavior always calls `https://cataas.com`, and no credentials are
needed: cataas is a public API.
