# AI Activity Review

A review queue for IT admins: it reads a CSV of employee AI usage, raises the
activity worth a look, explains the activity it deliberately did not raise, and
lets the reviewer act on either.

## Run

```bash
python3 -m http.server 4173
```

Then open http://localhost:4173. A server is required — `app.js` fetches
`assets/employee_ai_usage.csv`, which browsers block on `file://`.

## Files

| File | What it is |
|---|---|
| `index.html` | Page shell: topbar, case queue, assessment summary, detail drawer |
| `styles.css` | All styling; palette in `:root` |
| `app.js` | CSV parsing, the review criteria, and the UI |
| `assets/employee_ai_usage.csv` | The sample dataset |

Swapping in a different CSV with the same columns needs no code change. Column
order and CRLF line endings are both handled, as are quoted excerpts
containing commas.

## How a case is decided

Two principles run through all of it: **every rule reads columns, never prose**,
and **every threshold is derived from the data**, so the same criteria hold at
any cost scale and in any tenant's wording.

1. **Validate** — drop rows missing an id, employee, parseable date or cost;
   de-duplicate on `request_id`. Both counts appear in the summary.
2. **Group** records into sessions by employee and session id.
3. **Derive the scale** — each department with 8+ sessions gets its own outlier
   fence (median absolute deviation in log space, k=2.75) and its own
   materiality bar (1% of that department's spend). Employee and department
   medians are computed leave-one-out, so a spike cannot normalise itself.
4. **Sensitive data** — blocked before sending is explained. Otherwise a signal
   sent from a personal or unknown account opens a case: **Investigate** when
   two or more personal signals, or one at ≥0.8 confidence, with no unknown
   accounts and no missing excerpts; **Review** otherwise.
5. **Spend** — retry loops that completed, and uniform completed batches under
   one project tag across 3+ sessions, are explained. Otherwise a session above
   its department's fence, above department materiality, and 8× both the
   employee's and the department's medians opens a case — as does an employee
   whose total, counting only what no explanation covers, sits above the peer
   fence.
6. **Rank** — recommendation, then category (sensitive before spend: exposure is
   irreversible, spend is recoverable), then severity, then recency. Severity is
   how far past the bar a case got: cost ÷ fence for spend; distinct exposures ×
   peak confidence for sensitive, so repeating one template does not inflate it.

Content repeated near-identically across sessions is **grouped into a single
case and ranked lower** rather than suppressed — a template and the same
disclosure made repeatedly look identical in the data, so the reviewer decides.

## Acting on a case

Request context (drafts a message, records it locally — nothing is sent), add an
update, resolve with an outcome, or dismiss as not worth review. Anything the
assessment explained can be promoted into a case, and any dismissal can be
reopened; both appear in the assessment summary. Case state persists in
`localStorage`, keyed by a hash of the dataset, so loading a different CSV
starts clean. There is no backend.
