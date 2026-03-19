# cf-log-viewer

A local web-based viewer for Cloud Foundry application logs. Parses the raw `cf logs` output into a structured, filterable table with drill-down into individual log entries.

## Prerequisites

You need the [Cloud Foundry CLI](https://docs.cloudfoundry.org/cf-cli/install-go-cli.html) installed and authenticated before using this tool.

```bash
# Install the CF CLI (if not already installed)
# macOS
brew install cloudfoundry/tap/cf-cli@8

# Login to your CF environment
cf login -a <API_ENDPOINT>

# Or with SSO
cf login -a <API_ENDPOINT> --sso
```

Make sure you can run `cf logs <app-name> --recent` successfully before using this tool.

## Usage

```bash
npx cf-log-viewer <app-name>
```

This will:

1. Run `cf logs <app-name> --recent` and parse the output
2. Start a local web server on a random port
3. Open your browser with the log viewer

### Options

```bash
npx cf-log-viewer <app-name> --live       # also stream live logs
npx cf-log-viewer <app-name> --no-open    # don't auto-open browser
```

## Features

- **Structured table view** -- timestamp, level, source, logger, message, correlation ID
- **Color-coded levels** -- error (red), warn (yellow), info (blue), debug (gray)
- **Filtering** -- by level, logger, correlation ID, or free-text search
- **Drill-down detail panel** -- click any row to see categorized fields:
  - Message & core info
  - HTTP context (forwarded path, host, user agent)
  - Tracing & correlation (trace IDs, span IDs, SAP Passport)
  - Infrastructure (org, space, container, CF instance)
  - Raw JSON with syntax highlighting
- **Correlation grouping** -- click a correlation ID to filter all entries for that request
- **Live streaming** -- with `--live`, new log entries appear in real-time via WebSocket
- **Download** -- export filtered logs as JSON

## License

MIT
