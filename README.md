# Aclymate AI Integrations

Aclymate's carbon accounting expertise, available inside AI assistants. Estimate Scope 1/2/3 footprints, look up sourced emission factors, explain GHG Protocol scopes, and benchmark against industry peers — all from a chat session.

## What's in this repo

- **`mcp-server/`** — Model Context Protocol server (hosted at `mcp.aclymate.com`). Powers the Claude Connectors Directory entry and the Claude Desktop Extension.
- **`claude/desktop-extension/`** — Packaged `.mcpb` extension for Claude Desktop, pointing at the hosted MCP server via `mcp-remote`.
- **`claude/`** — Submission to [anthropics/skills](https://github.com/anthropics/skills) — Aclymate's carbon accounting expertise as a Claude Skill.
- **`openai/`** — ChatGPT Custom GPT system prompt and REST integration.
- **`plugin/`** — Submission to [anthropics/knowledge-work-plugins](https://github.com/anthropics/knowledge-work-plugins) for the official Claude marketplace.

## Setup

### Claude (via Connectors Directory)

Once approved, the connector will appear in Claude's Connectors Directory. No setup is required — enable it from Settings → Connectors.

### Claude Desktop (via .mcpb extension)

Download the latest `aclymate.mcpb` from this repo's releases and double-click to install in Claude Desktop. No configuration required — the extension connects to the public `https://mcp.aclymate.com/mcp` endpoint.

### Manual MCP client (Claude Code, Cursor, custom clients)

Point any MCP client at `https://mcp.aclymate.com/mcp` over HTTP transport. No authentication required.

```json
{
  "mcpServers": {
    "aclymate": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://mcp.aclymate.com/mcp"]
    }
  }
}
```

## Tools

| Tool | What it does |
|---|---|
| `estimate_emissions` | Estimate a business's annual tCO2e by industry, employee count, and location. Returns Scope 1/2/3 breakdown with low/high range and biggest emission drivers. |
| `explain_scope` | Explain GHG Protocol Scope 1, 2, or 3 in plain English, with industry-specific examples. |
| `get_emission_factor` | Look up a sourced emission factor (kg CO2e per unit) for a specific activity, with citations and caveats. |
| `compare_business_footprint` | Benchmark a company's footprint against industry peers — above, below, or in line — and what top performers do differently. |

All tools are read-only. None of them write to or modify any Aclymate data.

## Usage

Once installed, just ask Claude carbon questions naturally:

- *"What's a typical carbon footprint for a 25-person law firm in Denver?"*
- *"What's the emission factor for short-haul flights per passenger mile?"*
- *"Explain Scope 3 for a SaaS company."*
- *"Our 50-person restaurant chain emits 280 tCO2e/year — how do we compare to peers?"*

Claude will route the question to the appropriate Aclymate tool and return a sourced answer.

## Privacy

Query data (industry, employee count, activity descriptions) is sent to Aclymate's servers to generate responses. No personally identifiable information is collected, and queries are not retained.

Full policy: [aclymate.com/privacy-policy](https://aclymate.com/privacy-policy)

## Support

Email [william@aclymate.com](mailto:william@aclymate.com) for setup questions, bug reports, or partnership inquiries.

## About Aclymate

Aclymate is the carbon accounting platform built for small and mid-sized businesses. Sign up at [aclymate.com](https://aclymate.com) to track and reduce your actual emissions.
