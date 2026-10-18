# AI Usage Triage

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

Two principles run through all of it: **no rule keys off employee or tool names,
or phrases inside the excerpts**, and **every spend threshold is derived from the
data**, so the same criteria hold at any cost scale and in any tenant's wording.
Excerpt text is normalized only to recognize repeated content and retries; it is
not interpreted as proof that content is safe or sensitive. The one place a name
is read is project grouping, which skips generic tags such as "Routine work".

1. **Validate** — drop rows missing an id, employee, parseable date or cost;
   de-duplicate on `request_id`. Both counts appear in the summary.
2. **Group** records into sessions by employee and session id.
3. **Derive the scale** — each department with 8+ sessions gets its own outlier
   fence (median absolute deviation in log space, k=2.75) and its own
   materiality bar (1% of that department's spend); smaller departments fall
   back to organization-wide patterns. Employee and department medians are
   computed leave-one-out, so a spike cannot normalise itself.
4. **Sensitive data** — blocked before sending is explained. Otherwise a signal
   sent from a personal or unknown account opens a case: **Investigate** when
   two or more personal signals, or one at ≥0.8 confidence, with no unknown
   accounts and no missing excerpts; **Review** otherwise.
5. **Spend** — a session above its department's fence, above department
   materiality, and 8× both the employee's and department's medians opens a
   case. Material failed retries have a second path based on failed cost versus
   department materiality and baseline. Completion explains a retry pattern but
   does not cancel a case that already qualifies. Uniform completed batches
   under one project tag across 3+ sessions are explained, and an employee whose
   unexplained total sits above the peer fence can also open a case.
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
