# Security

`pi-semantic-screen` can send explicitly supplied candidate text to a configured remote classifier. The extension applies conservative secret redaction, but it is not a complete data-loss-prevention system.

## Data boundary

- `screen_batch` can egress only the item text, question, and criteria explicitly passed to it after redaction.
- `screen_discover` and low-level `screen_evidence` are local adapter operations.
- `screen_review_start`, `screen_review_next`, and `screen_review_commit` keep review workflow state in local Pi process memory; they do not make network requests.
- A pending review workflow may temporarily retain its current raw evidence packet in memory so repeated `screen_review_next` is idempotent. That packet is released after commit.
- Review accounting, findings, and blocked reasons are not serialized by the parent model into Code Mode state in the canonical workflow.
- The built-in `python-exceptions` adapter reads Python source under the requested scope and invokes a local Python interpreter; it does not make network requests.

Restarting Pi clears process-local review workflows.

## Reporting

For a private repository, report security issues directly to the repository owner rather than opening a public issue. Before publishing this repository publicly, replace this section with the project's preferred private disclosure channel.
