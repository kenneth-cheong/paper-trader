# Paper Trader

The AI funds are in a frozen test until 29 Jan 2027 (README → *The current test*). Until then, don't
change how the funds decide: prompts, models, styles, decisions per day, limits, learning rules or
`symbols.json`. If a request would, say so and ask the owner first. Fixes to crashes, data downloads,
the site and the stall watch are fine.

Every push to `main` runs the live fund workflow (`prices.yml`). Run `node --test` and
`python -m unittest discover -s test -p 'test_*.py'` before pushing.
