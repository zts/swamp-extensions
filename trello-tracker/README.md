# @zts/trello-tracker

A [stagecraft](https://swamp-club.com/extensions/@swamp/stagecraft) tracker
that keeps a factory's tickets on one Trello board. Cards are tickets, the
board's open lists are statuses, and its named labels are ticket types. It meets
stagecraft's tracker contract 1 and sits behind a
`@swamp/stagecraft/publisher`, so the shipped `publish`, `claim`, `create`,
`fetch-issue` and `mark-duplicate` workflows drive it like any other tracker.

## What it offers

- Tickets are found by card id, shortLink, or display id `<prefix>-<number>`
  (for example `trello-12`), and only on the configured board: a card anywhere
  else is `not_found`.
- Comments are the ticket's activity, read in full and oldest first.
- Statuses are the names of the board's open lists; types are label names. A
  name that matches no list or label, or more than one, is refused.
- Relations (`parent_of`, `blocked_by`, `related_to`, `duplicate_of`) follow
  stagecraft's rules: one parent, no parent loops, one duplicate target, no
  duplicate chains.
- No history, assign or pull-request capability: lifecycle entries arrive as
  comments.

## Setup

### 1. Get a key and token

Create a Trello integration at https://trello.com/power-ups/admin, open
**Authorization → Trello Auth**, generate an API key, and follow the
**Token** link beside it to make a token with `read,write` scope. Prefer an
expiring token (`expiration=30days`); revoke any token under **Applications**
in your Trello account.

### 2. Store them in a vault

Store both in a vault. `swamp vault put` prompts for each value in a
terminal:

```sh
swamp vault put my-vault trello-api-key
swamp vault put my-vault trello-token
```

### 3. Create the tracker

Create the tracker, wiring the credentials from the vault, and have it
describe itself:

```yaml
# models/@zts/trello-tracker/trello.yaml (globalArguments)
globalArguments:
  boardId: AbCd1234 # the board URL's shortLink, trello.com/b/AbCd1234
  prefix: trello
  apiKey: ${{ vault.get(my-vault, trello-api-key) }}
  token: ${{ vault.get(my-vault, trello-token) }}
```

```sh
swamp model create @zts/trello-tracker trello --json
swamp model method run trello describe
```

### 4. Add a publisher and bind the factory

Put a publisher in front of it, mapping each status key your factory uses to
a list name on the board, and bind the factory to the publisher with
`tracker: { kind: trello }` in its definition:

```sh
swamp model create @swamp/stagecraft/publisher trello-pub \
  --global-arg tracker=trello --json
```

```yaml
# models/@swamp/stagecraft/publisher/trello-pub.yaml (globalArguments)
globalArguments:
  tracker: trello
  statuses:
    open: Open
    in_progress: In progress
    shipped: Shipped
    closed: Closed
```

### 5. Run conformance on a test board

Check it against a board you keep for testing:

```sh
swamp workflow run @swamp/stagecraft/conformance --input tracker=trello-pub \
  --input statusNames="In progress,Shipped" --input createType=fix \
  --input missing=000000000000000000000000
```

## Things to know

- **Relations live in swamp, not Trello.** Trello has no card-to-card links, so
  relations are kept in this tracker's swamp data and are not visible on the
  board. They are as durable as your swamp datastore.
- **A timed-out write can be repeated.** Trello has no idempotency keys: if a
  comment or a new card is made but the answer is lost to a timeout, the retry
  makes it again.
- **Credentials stay in the header.** Requests send the key and token in an
  `Authorization: OAuth ...` header, never in the URL, and no answer, failure
  detail or log line contains them.
- **Rate limits** surface as `rate_limited`, with Trello's `Retry-After` value
  when it sends one.
