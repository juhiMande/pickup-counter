# AI notes

> It is a starting draft based on what actually
> happened. Rewrite it in your own words and add what *you* checked and changed. The company
> said they only want honesty here, and they will ask about it in the call.

## Tools used

- **Claude (Anthropic, claude.ai)** generated the first full version of the project from the
  assignment brief: backend, tests, the React screen, Docker setup and a first draft of the README.
- TODO: list anything else you used (Copilot, Cursor, ChatGPT…) and for what.

## A prompt that worked well

TODO: paste the actual prompt you used. Tip: the useful part was giving it the full brief and
asking for the backend and the concurrency tests first, against a real Postgres.

## Things the AI got wrong / I had to check

Real issues that came up while the code was being generated:

- **Lock ordering could deadlock.** The first version of the webhook handler locked the order row
  and *then* the product rows, while the pickup claim locked products first and then the order.
  A late payment and a pickup claim on the same order at the same time could deadlock. Fixed by
  making every path lock products first (in id order), then the order.
- **`needs_review` orders were first counted as holding stock.** For a late payment where the
  units had already been resold, that would make `availableUnits` go negative. Changed so only
  live `pending` and `paid` orders hold stock.

TODO: add anything you found yourself while reviewing or running it, and how you noticed
(a failing test, reading the SQL, trying it in the browser, etc.).
