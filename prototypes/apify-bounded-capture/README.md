# Throwaway bounded Apify capture utility

This prototype supported the 2026-10-18 capture pilot. It is not the production ingestion adapter. Measurements and limitations are in `docs/research/2026-10-18-apify-x-pilot.md`.

The code is retained separately from main. No private samples, captures, run identifiers, or credentials are included. The published copy replaces machine-specific data/credential paths with required environment variables; acquisition behavior otherwise matches the pilot utility.

Use Python 3 and provide `PILOT_DATA_DIR` outside the public checkout, plus `APIFY_TOKEN_FILE` pointing at a privately stored Actor-scoped token. A run requires a reviewed input JSON file and an explicitly approved monetary budget. The historical USD 2 approval does not authorize new runs.

```sh
python pilot_api.py start experiment-name --input /private/reviewed-input.json --cap 0.05
python pilot_api.py collect experiment-name
```

`collect` resumes by saved run identity; it never starts a new run. If the start request has an unknown outcome, reconcile the reservation against the provider rather than deleting the reservation and retrying. This filesystem guard assumes a single operator and is not a durable distributed workflow. The hard-coded aggregate reservation ceiling of USD 1.50 was a conservative guard for this pilot, not a general budget policy.

The utility pins build 1.12.394, memory and timeout, saves input/start metadata before polling, restricts each new run and default store, verifies anonymous read denial, and archives dataset pages and JSON diagnostics. Restriction occurs after creation and must not be represented as private-at-creation. The pilot did not exercise multi-page results, external cancellation, inaccessible anchors, or crash ambiguity.
