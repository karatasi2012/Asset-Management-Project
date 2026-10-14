# Asset Ledger

A single-page tool for tracking company cars and the full cost of owning them.

- Vehicle register for owned and leased cars
- Reducing balance depreciation for any period
- Fuel, insurance, licence, driver, tolls and other expenses
- Servicing jobs that use spares and consumables from stock
- Direct, indirect and ownership costs, cost per km, and a life-of-a-car view
- Optional AI agent that researches a car model and suggests performance improvements

All ledger data is stored in your own browser (localStorage). Nothing is sent to a server,
except the few car facts you choose to send when you run the AI agent.
Use Data & settings > Backup to save your data to a file.

To change the app, edit `index.html` and push to GitHub. The site updates in a minute or two.
To switch on live web research, follow `agent/README.md`.
