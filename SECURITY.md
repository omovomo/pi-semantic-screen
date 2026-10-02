# Security

`pi-semantic-screen` can send explicitly supplied candidate text to a configured remote classifier. The extension applies conservative secret redaction, but it is not a complete data-loss-prevention system.

## Data boundary

- `screen_batch` can egress only the item text, question, and criteria explicitly passed to it after redaction.
- `screen_discover` and `screen_evidence` are local read-only adapter operations.
- The built-in `python-exceptions` adapter reads Python source under the requested scope and invokes a local Python interpreter; it does not make network requests.
- Raw candidate/evidence text should not be persisted in Code Mode store state.

## Reporting

For a private repository, report security issues directly to the repository owner rather than opening a public issue. Before publishing this repository publicly, replace this section with the project's preferred private disclosure channel.
