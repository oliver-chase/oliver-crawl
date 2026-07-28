# Architecture

How a request actually flows, and why the pieces are split the way they are.

## The whole picture

```mermaid
flowchart TB
    subgraph YOU["Your application"]
        APP["your code"]
        DB[("your database<br/>your scheduler")]
    end

    subgraph PKG["oliver-crawl"]
        API["createCrawler()<br/>crawl · crawlSite · search"]

        subgraph L1["FREE PATH — own"]
            POL["policy<br/>SSRF · robots · same-site"]
            FETCH["fetch<br/>conditional GET · redirects"]
            PARSE["parse<br/>text · JSON-LD · links"]
            GUARD["guard<br/>prompt-injection"]
            REND["render<br/>local Chromium → your service"]
            JINA["Jina Reader<br/>free fallback"]
        end

        subgraph L2["PAID PATH — vendor · opt-in"]
            FC["Firecrawl"]
            AP["Apify"]
        end

        subgraph S["SEARCH — paid · opt-in"]
            SP["Serper → Tavily"]
        end
    end

    WEB(("the web"))

    APP -->|"CrawlTarget"| API
    API --> POL
    POL -->|"approved"| FETCH
    POL -.->|"refused — no network call"| APP
    FETCH --> PARSE --> GUARD
    FETCH -.->|"JS shell / blocked"| REND -.-> JINA
    API -.->|"only if lanes includes 'vendor'"| L2
    API -.-> S

    FETCH <--> WEB
    REND <--> WEB
    JINA <--> WEB
    L2 <--> WEB
    S <--> WEB

    GUARD -->|"CrawlPage"| APP
    API -->|"onUsage · checkBudget · onSignals"| DB

    style L1 fill:#e8f5e9,stroke:#2e7d32
    style L2 fill:#fff3e0,stroke:#e65100
    style S fill:#fff3e0,stroke:#e65100
    style PKG fill:#f5f5f5,stroke:#616161
```

Green needs no credentials and costs nothing. Orange bills per call and stays off unless a call asks for it.

## One page, start to finish

```mermaid
sequenceDiagram
    participant App as your code
    participant C as crawler
    participant P as policy
    participant DNS
    participant Site as origin

    App->>C: crawl(target, url)
    C->>P: eligible? same-site? https?
    P->>DNS: does this host resolve public?
    DNS-->>P: 93.184.216.34
    Note over P,DNS: any private address → refused,<br/>no request ever made

    C->>Site: GET (+ If-None-Match)

    alt nothing changed
        Site-->>C: 304
        C-->>App: notModified — nothing fetched, free
    else new content
        Site-->>C: 200 + HTML
        Note over C: decode with the origin's charset,<br/>not a UTF-8 assumption
        C->>C: parse → guard → hash
        C-->>App: CrawlPage
    else JS shell / blocked / error
        C->>C: local Chromium → your render service → Jina
        C-->>App: CrawlPage, or a failure VALUE
    end
```

## Deciding what to crawl

```mermaid
flowchart LR
    START(["crawlSite(target)"]) --> SEEDS{"seeds given?"}
    SEEDS -->|yes| Q["queue"]
    SEEDS -->|"no + useSitemap"| SM["/sitemap.xml"] --> Q
    SEEDS -->|"no"| BASE["just baseUrl"] --> Q

    Q --> POP["take next URL"]
    POP --> LIM{"within maxPages<br/>and maxDurationMs?"}
    LIM -->|no| DONE(["done · truncated"])
    LIM -->|yes| SEEN{"already visited?"}
    SEEN -->|yes| POP
    SEEN -->|no| CRAWL["crawl it"]

    CRAWL --> DISC{"discovery on?"}
    DISC -->|followPagination| NEXT["next-page link<br/>same depth"] --> FILT
    DISC -->|followLinks| ALL["all same-site links<br/>depth + 1"] --> FILT
    DISC -->|neither| POP

    FILT{"include / exclude<br/>· depth ok?"} -->|pass| Q
    FILT -->|fail| POP

    style DONE fill:#e8f5e9
```

Breadth-first: pages a site links from its homepage are the ones it considers important, so a run that hits `maxPages` keeps the useful pages rather than descending one deep branch.

## Why the boundaries are where they are

| Boundary | Reason |
|---|---|
| **No database in the package** | Your app owns persistence. State leaves through `onUsage` / `checkBudget` / `onSignals` callbacks, so Fallow can write Postgres, another repo a spreadsheet, a fork nothing at all. |
| **No env reads in core** | Config is passed explicitly (`configFromEnv()` is opt-in sugar), so two differently-configured crawlers can exist in one process. |
| **Domain extraction is yours** | You get text, markdown, JSON-LD and links. The mapping from a page to your own records is defined by your schema; any version shipped here would be wrong for every consumer that did not share it. |
| **The two paths are separate** | A reader must be able to tell which code can bill them, and the default must never spend money. |
| **Policy refusals never escalate** | Paying a vendor to fetch what your own guard refused would buy a way around your own controls. |

## Making repeat crawls cheap

Two mechanisms, because origins differ:

```mermaid
flowchart TB
    RC(["re-crawl a known page"]) --> V{"stored validators?"}
    V -->|"ETag / Last-Modified"| CG["conditional GET"]
    CG --> R{"origin says?"}
    R -->|304| FREE(["nothing fetched<br/>→ notModified"])
    R -->|200| HASH
    V -->|"none — most small sites"| HASH["compare content hash"]
    HASH --> SAME{"identical?"}
    SAME -->|yes| SKIP(["fetched, but<br/>→ unchanged<br/>skip re-processing"])
    SAME -->|no| WORK(["real change<br/>→ process it"])

    style FREE fill:#e8f5e9
    style SKIP fill:#e8f5e9
```

The structural hash (`contentRegionSha256`) ignores nav/header/footer, so a cookie-banner tweak isn't a content change — but it only exists for HTML. Text-only rungs (Jina, vendor) set it empty and the comparison falls back to `textSha256`, so a rung change can never fake a content change.

## Module map

```
src/
  index.ts              createCrawler — lane selection, cache, retry
  crawl-site.ts         multi-page: seeds, discovery, budgets, dedup, resume
  map-site.ts           what URLs exist, without crawling them
  search-and-crawl.ts   search → crawl bridge, guards re-applied per result
  core/
    types.ts            the contract everything is built against
    config.ts           defaults, env sugar, limits
    net-address.ts      IP classification (shared by both guards)
    url-safety.ts       is an EXTRACTED url safe to keep?
    url-dedup-key.ts    canonical identity — /a, /a/, /a?utm= are one page
    content-kind.ts     html / calendar / csv / json / feed / text
    charset.ts          decode with the origin's encoding
    host-throttle.ts    per-host pacing, adaptive
    rung-memory.ts      which rung works per host (per-crawler, never global)
    failure-class.ts    transient vs structural — is a retry worth it?
    soft-404.ts         did this page actually say anything?
    extractor-version.ts stamp, so improvements can reach stored pages
    page-cache.ts       in-process stampede guard
    hash.ts             cross-runtime SHA-256
    usage.ts            report a call, never throw
  fetch/
    build-page.ts       HTML -> CrawlPage: the one place a page shape is made
    http-mechanics.ts   body cap, safe redirect loop, Retry-After
    host-policy.ts      SSRF/DNS-rebinding — may we request this?
    robots-check.ts     robots.txt fetch + parse
    jina-fetch.ts       free keyless fallback
    local-render.ts     free local Chromium
    browser-render.ts   your own render service
    sitemap-discovery.ts
    feed-discovery.ts
    cheap-change-probe.ts
  extract/
    html-to-markdown.ts  main-content Markdown — the field to feed an LLM
    structured-summary.ts is any of this JSON-LD actually about the content?
    content-images.ts    flyer/poster candidates (finding is free, reading is not)
    content-diff.ts      what changed, not just that something did
    detail-link-picker.ts which link answers a still-missing field
    jsonld-event.ts · jsonld-address.ts
    content-region-hash.ts · spa-content-extract.ts
    pagination-discovery.ts · extraction-recipe.ts (replay only)
  guard/
    prompt-injection-guard.ts
  lanes/
    own/index.ts        the free ladder
    vendor/index.ts     Firecrawl, Apify
  search/index.ts       Serper, Tavily
```

---

**See also:** [DECISIONS](DECISIONS.md) — why the code is the way it is · [README](../README.md) · [LANES](LANES.md) — the rung ladder in order · [REFERENCE](REFERENCE.md) — every option and return field · [MIGRATION](MIGRATION.md) — where the code came from · [BACKLOG](BACKLOG.md) — known gaps
