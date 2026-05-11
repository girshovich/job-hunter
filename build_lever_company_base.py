#!/usr/bin/env python3
"""
build_lever_company_base.py

Builds a deduplicated Lever company registry from the
edwarddgao/open-apply-jobs HuggingFace dataset.

Usage:
    python build_lever_company_base.py --output lever_companies.csv
    python build_lever_company_base.py --limit 50 --skip-validation
    python build_lever_company_base.py --concurrency 20 --sleep 0.05
"""

import argparse
import asyncio
import csv
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import aiohttp
import duckdb
from tqdm import tqdm
from typing import Dict, List, Optional, Set, Tuple

# ── Constants ────────────────────────────────────────────────────────────────

HF_PARQUET = "hf://datasets/edwarddgao/open-apply-jobs/data/**/*.parquet"
SOURCE_DATASET = "open-apply-jobs"
LEVER_JOBS_BASE = "https://jobs.lever.co"
LEVER_API_BASE = "https://api.lever.co/v0/postings"
RAW_CHECKPOINT = "lever_slugs_raw.csv"

OUTPUT_COLUMNS = [
    "company_name",
    "lever_slug",
    "lever_jobs_url",
    "lever_api_url",
    "source_dataset",
    "first_seen_in_dataset",
    "last_seen_in_dataset",
    "job_count_in_dataset",
    "validated",
    "validated_at",
    "validation_status",
]

# ── Name derivation ──────────────────────────────────────────────────────────

def slug_to_name(slug: str) -> str:
    """Derive a readable company name from a Lever slug.

    superside      -> Superside
    brillio-2      -> Brillio
    cloudwalk      -> Cloudwalk
    ro             -> Ro
    """
    name = re.sub(r"-\d+$", "", slug)          # strip trailing -2, -3, ...
    name = name.replace("-", " ").replace("_", " ")
    return name.title()

# ── Dataset fetch ────────────────────────────────────────────────────────────

def fetch_raw_slugs(limit: Optional[int] = None) -> List[dict]:
    """Query HuggingFace Parquet via DuckDB and return one row per Lever slug."""
    conn = duckdb.connect()
    conn.execute("INSTALL httpfs; LOAD httpfs;")

    limit_clause = f"LIMIT {limit}" if limit else ""

    query = f"""
        WITH lever AS (
            SELECT
                LOWER(TRIM(source_slug)) AS slug,
                posted_at,
                date
            FROM read_parquet(
                '{HF_PARQUET}',
                hive_partitioning = 1,
                union_by_name   = true
            )
            WHERE source      = 'lever'
              AND source_slug IS NOT NULL
              AND TRIM(source_slug) != ''
        )
        SELECT
            slug,
            COUNT(*)                                                    AS job_count,
            MIN(COALESCE(posted_at, CAST(date AS VARCHAR)))             AS first_seen,
            MAX(COALESCE(posted_at, CAST(date AS VARCHAR)))             AS last_seen
        FROM lever
        GROUP BY slug
        ORDER BY slug
        {limit_clause}
    """

    rows = conn.execute(query).fetchall()
    conn.close()

    results = []
    for slug, job_count, first_seen, last_seen in rows:
        results.append({
            "company_name":          slug_to_name(slug),
            "lever_slug":            slug,
            "lever_jobs_url":        f"{LEVER_JOBS_BASE}/{slug}",
            "lever_api_url":         f"{LEVER_API_BASE}/{slug}?mode=json",
            "source_dataset":        SOURCE_DATASET,
            "first_seen_in_dataset": first_seen[:10] if first_seen else "",
            "last_seen_in_dataset":  last_seen[:10]  if last_seen  else "",
            "job_count_in_dataset":  job_count,
        })

    return results

# ── Checkpoint helpers ───────────────────────────────────────────────────────

def write_csv(rows: List[dict], path: str, fieldnames: List[str]) -> None:
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def load_existing_output(path: str) -> Dict[str, dict]:
    """Return {lever_slug: row} for every row in an existing output CSV."""
    existing: Dict[str, dict] = {}
    p = Path(path)
    if not p.exists():
        return existing
    with open(p, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            existing[row["lever_slug"]] = row
    return existing

# ── Async validation ─────────────────────────────────────────────────────────

async def _validate_one(
    session: aiohttp.ClientSession,
    slug: str,
    semaphore: asyncio.Semaphore,
    sleep: float,
    max_retries: int,
) -> Tuple[str, bool, str]:
    """Return (slug, validated, validation_status)."""
    url = f"{LEVER_API_BASE}/{slug}?mode=json"
    timeout = aiohttp.ClientTimeout(total=15)

    for attempt in range(max_retries):
        async with semaphore:
            try:
                async with session.get(url, timeout=timeout) as resp:
                    if resp.status != 200:
                        if attempt < max_retries - 1:
                            await asyncio.sleep(sleep)
                            continue
                        return slug, False, "invalid_http_status"

                    try:
                        data = await resp.json(content_type=None)
                    except Exception:
                        return slug, False, "invalid_json"

                    if not isinstance(data, list):
                        return slug, False, "invalid_response_format"

                    await asyncio.sleep(sleep)
                    return slug, True, "valid"

            except asyncio.TimeoutError:
                if attempt < max_retries - 1:
                    await asyncio.sleep(sleep)
                    continue
                return slug, False, "timeout"

            except Exception:
                if attempt < max_retries - 1:
                    await asyncio.sleep(sleep)
                    continue
                return slug, False, "request_error"

    return slug, False, "request_error"


async def validate_all(
    rows: List[dict],
    sleep: float,
    max_retries: int,
    concurrency: int,
    skip_slugs: Set[str],
) -> Dict[str, Tuple[bool, str, str]]:
    """Return {lever_slug: (validated, validated_at, validation_status)}."""
    to_validate = [r for r in rows if r["lever_slug"] not in skip_slugs]
    results: Dict[str, Tuple[bool, str, str]] = {}

    if not to_validate:
        return results

    semaphore = asyncio.Semaphore(concurrency)
    now_str = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    connector = aiohttp.TCPConnector(limit=concurrency)
    async with aiohttp.ClientSession(connector=connector) as session:
        tasks = [
            _validate_one(session, r["lever_slug"], semaphore, sleep, max_retries)
            for r in to_validate
        ]

        with tqdm(total=len(tasks), desc="Validating", unit="slug") as pbar:
            for coro in asyncio.as_completed(tasks):
                slug, validated, status = await coro
                results[slug] = (validated, now_str, status)
                pbar.update(1)

    return results

# ── Output assembly ──────────────────────────────────────────────────────────

def assemble_output(
    rows: List[dict],
    validation_results: Dict[str, Tuple[bool, str, str]],
    existing: Dict[str, dict],
) -> List[dict]:
    output = []
    for row in rows:
        slug = row["lever_slug"]
        out = dict(row)

        if slug in validation_results:
            validated, validated_at, status = validation_results[slug]
            out["validated"]         = str(validated).lower()
            out["validated_at"]      = validated_at
            out["validation_status"] = status
        elif slug in existing and existing[slug].get("validated", "").lower() == "true":
            # Carry over a previously successful validation on resume
            prev = existing[slug]
            out["validated"]         = prev["validated"]
            out["validated_at"]      = prev["validated_at"]
            out["validation_status"] = prev["validation_status"]
        else:
            out["validated"]         = ""
            out["validated_at"]      = ""
            out["validation_status"] = ""

        output.append(out)

    return output

# ── CLI ──────────────────────────────────────────────────────────────────────

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Build a deduplicated Lever company base from open-apply-jobs."
    )
    p.add_argument("--output",          default="lever_companies.csv",
                   help="Output CSV path (default: lever_companies.csv)")
    p.add_argument("--skip-validation", action="store_true",
                   help="Skip live Lever API validation")
    p.add_argument("--sleep",           type=float, default=0.1,
                   help="Delay between API requests in seconds (default: 0.1)")
    p.add_argument("--max-retries",     type=int,   default=3,
                   help="Retry attempts per failed request (default: 3)")
    p.add_argument("--limit",           type=int,   default=None,
                   help="Process only the first N slugs, for testing")
    p.add_argument("--concurrency",     type=int,   default=10,
                   help="Concurrent validation requests (default: 10)")
    return p.parse_args()


def main() -> None:
    args = parse_args()

    # ── 1. Fetch and aggregate from HuggingFace ───────────────
    print("Fetching Lever slugs from HuggingFace dataset...")
    rows = fetch_raw_slugs(limit=args.limit)
    print(f"  {len(rows):,} unique Lever slugs found.")

    # ── 2. Write raw checkpoint ───────────────────────────────
    raw_fields = [k for k in rows[0].keys()]
    write_csv(rows, RAW_CHECKPOINT, raw_fields)
    print(f"  Raw checkpoint → {RAW_CHECKPOINT}")

    # ── 3. Load existing output for resume ────────────────────
    existing = load_existing_output(args.output)
    already_validated = {
        slug for slug, row in existing.items()
        if row.get("validated", "").lower() == "true"
    }
    if already_validated:
        print(f"  Resuming: {len(already_validated):,} slugs already validated, skipping.")

    # ── 4. Validate ───────────────────────────────────────────
    validation_results: Dict[str, Tuple[bool, str, str]] = {}
    if not args.skip_validation:
        remaining = len(rows) - len(already_validated)
        print(f"Validating {remaining:,} slugs "
              f"(concurrency={args.concurrency}, sleep={args.sleep}s)...")
        validation_results = asyncio.run(
            validate_all(rows, args.sleep, args.max_retries,
                         args.concurrency, already_validated)
        )
        valid_count = sum(1 for v, _, _ in validation_results.values() if v)
        print(f"  {valid_count:,} valid / {len(validation_results):,} checked.")
    else:
        print("Skipping validation (--skip-validation).")

    # ── 5. Assemble and write final output ────────────────────
    output_rows = assemble_output(rows, validation_results, existing)
    write_csv(output_rows, args.output, OUTPUT_COLUMNS)
    print(f"Output → {args.output}  ({len(output_rows):,} rows)")


if __name__ == "__main__":
    main()
