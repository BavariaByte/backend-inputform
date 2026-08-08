# Contributing to GIRP Backend-Inputform

Thank you for your interest in contributing to the GIRP Platform!

## Workflow

- Development happens in an internal repository; this GitHub repository is a
  **snapshot mirror** of the latest release with a single `main` branch and no
  history.
- Open pull requests against `main`. Accepted changes are applied to the
  internal repository by the maintainers (with credit in the changelog) and
  appear here with the next release snapshot — your PR is closed once adopted,
  not merged directly.
- **Note:** every release replaces `main` (force push). Re-sync your fork
  before starting new work:
  `git fetch upstream && git reset --hard upstream/main`
- Use **conventional commits** (`feat:`, `fix:`, `docs:`, `chore:`, ...).
- Keep pull requests focused; one topic per PR.

## Development Setup

Follow the setup instructions in [README.md](README.md). Before submitting:

```bash
npm run lint   # must be clean
npm test       # must pass
```

## Licensing

This project is source-available under the
[Sustainable Use License](LICENSE.md). By submitting a contribution you agree
that it is provided under the same license.

## Security Issues

Please do **not** report security vulnerabilities via public issues or pull
requests. Email **security@bavariabyte.com** instead — see
[SECURITY.md](SECURITY.md).
