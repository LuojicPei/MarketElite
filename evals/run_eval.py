from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import date, timedelta
from pathlib import Path
from typing import Any

# Ensure `backend/` is importable when invoked as standalone script
_REPO_ROOT = Path(__file__).resolve().parents[1]
_BACKEND_DIR = _REPO_ROOT / "backend"
if str(_BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(_BACKEND_DIR))

from app.agents.investigator import compute_tool_fingerprint, detect_trade_intent  # noqa: E402
from app.agents.risk_critic import _build_deterministic_critique  # noqa: E402
from app.agents.watchdog import classify_trade_quadrant  # noqa: E402
from app.quant.macro import compute_fear_greed_index, compute_net_liquidity_series  # noqa: E402
from app.quant.options import OptionContractInput, compute_estimated_gex  # noqa: E402
from app.quant.risk import RiskSizingRequest, compute_risk_sizing  # noqa: E402
from app.quant.technicals import (  # noqa: E402
    DailyBarInput,
    analyze_asset_technicals,
    classify_market_regime,
)
from app.rag.hybrid_search import reciprocal_rank_fusion  # noqa: E402

DATASET_PATH = _REPO_ROOT / "evals" / "datasets" / "golden_cases.json"
DEFAULT_REPORT_PATH = _REPO_ROOT / "evals" / "latest_report.json"


def _make_synthetic_bars(price_trend: str, volume_spike: float, count: int = 65) -> list[DailyBarInput]:
    bars: list[DailyBarInput] = []
    px = 100.0
    start = date(2026, 1, 2)
    for idx in range(count):
        dt = (start + timedelta(days=idx)).isoformat()
        is_last = idx == count - 1
        vol = 1_000_000.0 * (volume_spike if is_last else 1.0)
        if price_trend == "up_surge":
            px = px + (3.2 if is_last else 0.35)
        elif price_trend == "down_dump":
            px = px - (3.8 if is_last else 0.15)
        else:  # down_drift
            px = px - (1.4 if is_last else 0.1)
        bars.append(
            DailyBarInput(
                trade_date=dt,
                open=round(px - 0.5, 2),
                high=round(px + 1.0, 2),
                low=round(px - 1.0, 2),
                close=round(px, 2),
                volume=vol,
                vwap=round(px, 2),
            )
        )
    return bars


def _evaluate_case(case: dict[str, Any]) -> tuple[bool, dict[str, Any]]:
    kind = case["evaluator"]
    inp = case["input"]
    exp = case["expected"]

    if kind == "regime_classify":
        res = classify_market_regime(
            net_liq_delta_20d=inp.get("net_liq_delta_20d"),
            hy_oas=inp.get("hy_oas"),
            vix_spot=inp.get("vix_spot"),
            vix_term_ratio=inp.get("vix_term_ratio"),
            spy_dist_50ma_pct=inp.get("spy_dist_50ma_pct"),
            pct_above_50ma=inp.get("pct_above_50ma"),
        )
        ok = True
        if "regime_label" in exp:
            ok = ok and res["regime_label"] == exp["regime_label"]
        if "regime_label_in" in exp:
            ok = ok and res["regime_label"] in exp["regime_label_in"]
        return ok, {"regime_label": res["regime_label"], "stress_score": res["stress_score"]}

    if kind == "net_liquidity":
        res_nl = compute_net_liquidity_series(
            [(date(2026, 11, 18), inp["walcl_mn"])],
            [(date(2026, 11, 18), inp["tga_mn"])],
            [(date(2026, 11, 18), inp["rrp_bn"])],
        )
        val = res_nl.get("latest_billions")
        ok = val is not None and abs(float(val) - float(exp["net_liq_bn"])) < 1e-6
        return ok, {"net_liq_bn": val}

    if kind == "fear_greed":
        res = compute_fear_greed_index(
            spy_dist_200ma_pct=inp.get("spy_dist_200ma_pct"),
            spy_20d_return_pct=inp.get("spy_20d_return_pct"),
            pct_above_50ma=inp.get("pct_above_50ma"),
            rsp_spy_20d_delta_pct=inp.get("rsp_spy_20d_delta_pct"),
            vix_spot=inp.get("vix_spot"),
            vix_vix3m_ratio=inp.get("vix_vix3m_ratio"),
            hy_oas=inp.get("hy_oas"),
        )
        score = res["score"]
        ok = score is not None and exp["min_score"] <= float(score) <= exp["max_score"]
        return ok, {"score": score, "label": res["label"]}

    if kind == "gex_calc":
        contracts = [
            OptionContractInput(
                contract_symbol=f"{inp['symbol']}{idx}{c['option_type'][0].upper()}{int(c['strike'])}",
                option_type=c["option_type"],
                strike=float(c["strike"]),
                open_interest=int(c["open_interest"]),
                gamma=float(c["gamma"]),
            )
            for idx, c in enumerate(inp["contracts"])
        ]
        res = compute_estimated_gex(inp["symbol"], inp["spot"], contracts)
        ok = True
        if exp.get("net_gex_negative"):
            ok = ok and res.net_gex < 0
        if exp.get("net_gex_positive"):
            ok = ok and res.net_gex > 0
        if "call_wall" in exp:
            ok = ok and res.call_wall == exp["call_wall"]
        if "put_wall" in exp:
            ok = ok and res.put_wall == exp["put_wall"]
        if "zero_gamma_between" in exp:
            lo, hi = exp["zero_gamma_between"]
            ok = ok and res.zero_gamma is not None and lo <= res.zero_gamma <= hi
        if "assumption_contains" in exp:
            ok = ok and exp["assumption_contains"] in res.assumption_label
        return ok, {
            "net_gex": res.net_gex,
            "call_wall": res.call_wall,
            "put_wall": res.put_wall,
            "zero_gamma": res.zero_gamma,
        }

    if kind == "technicals_rvol":
        bars = _make_synthetic_bars(inp["price_trend"], float(inp["volume_spike"]))
        tech = analyze_asset_technicals(bars)
        tag = str(tech.get("volume_price_tag", ""))
        ok = True
        if "volume_tag_contains" in exp:
            ok = ok and exp["volume_tag_contains"].upper() in tag.upper()
        if exp.get("has_rsi_and_ema20"):
            ok = ok and tech.get("rsi_14") is not None and tech.get("ema_20") is not None
        return ok, {"volume_price_tag": tag, "rvol_20": tech.get("rvol_20"), "rsi_14": tech.get("rsi_14")}

    if kind == "risk_sizing":
        res = compute_risk_sizing(RiskSizingRequest(**inp)).to_dict()
        ok = True
        if "was_capped_by_risk" in exp:
            ok = ok and res["was_capped_by_risk"] is exp["was_capped_by_risk"]
        if "max_recommended_qty" in exp:
            ok = ok and int(res["recommended_qty"]) <= int(exp["max_recommended_qty"])
        if "bracket_valid" in exp:
            ok = ok and res["bracket_valid"] is exp["bracket_valid"]
        if "min_rr" in exp:
            ok = ok and (res.get("risk_reward_ratio") or 0) >= exp["min_rr"]
        if exp.get("has_auto_levels"):
            ok = ok and res.get("stop_loss_price") is not None and res.get("take_profit_price") is not None
        return ok, {
            "recommended_qty": res["recommended_qty"],
            "was_capped_by_risk": res["was_capped_by_risk"],
            "bracket_valid": res["bracket_valid"],
        }

    if kind == "risk_critique":
        fake_state: dict[str, Any] = {
            "symbol": inp["symbol"],
            "side": inp["side"],
            "regime_label": inp["regime_label"],
            "zero_gamma": inp.get("zero_gamma"),
            "spot_price": inp.get("spot_price"),
            "upcoming_catalysts": inp.get("upcoming_catalysts", []),
            "existing_position": None,
            "risk_sizing": {
                "recommended_qty": 10,
                "risk_budget_pct": 1.0,
                "max_risk_dollars": 1000.0,
                "stop_loss_price": 565.0,
                "take_profit_price": 605.0,
                "risk_reward_ratio": 1.67,
                "was_capped_by_risk": False,
                "bracket_valid": True,
            },
        }
        crit = _build_deterministic_critique(fake_state)  # type: ignore[arg-type]
        ok = (
            crit["regime_alignment"] == exp["regime_alignment"]
            and len(crit["counter_arguments"]) >= exp["min_counter_args"]
            and crit["verdict"] in exp["verdict_in"]
        )
        return ok, {"verdict": crit["verdict"], "alignment": crit["regime_alignment"]}

    if kind == "quadrant_attr":
        attr = classify_trade_quadrant(**inp)
        ok = attr["quadrant"] == exp["quadrant"]
        if "min_process_score" in exp:
            ok = ok and attr["process_score"] >= exp["min_process_score"]
        return ok, {"quadrant": attr["quadrant"], "process_score": attr["process_score"]}

    if kind == "trade_intent":
        res = detect_trade_intent(inp["query"], inp.get("symbol"))
        ok = res.get("detected") is exp["detected"]
        if exp["detected"]:
            ok = (
                ok
                and res.get("symbol") == exp["symbol"]
                and res.get("side") == exp["side"]
                and float(res.get("proposed_qty", 0)) == float(exp["proposed_qty"])
            )
        return ok, res

    if kind == "fingerprint_dedup":
        h1 = compute_tool_fingerprint(inp["tool"], inp["args_a"])
        h2 = compute_tool_fingerprint(inp["tool"], inp["args_b"])
        ok = (h1 == h2) is exp["identical_hash"]
        return ok, {"hash_a": h1, "hash_b": h2}

    if kind == "rrf_fusion":
        chunks = reciprocal_rank_fusion(
            inp["vector_chunks"],
            inp["lexical_chunks"],
            query=inp["query"],
            top_k=3,
        )
        ok = bool(chunks) and chunks[0].chunk_id == exp["top_chunk_id"]
        return ok, {"top_chunk_id": chunks[0].chunk_id if chunks else None, "rrf": chunks[0].rrf_score if chunks else None}

    raise ValueError(f"Unknown evaluator kind: {kind}")


def run_golden_eval(*, save_report: bool = True) -> dict[str, Any]:
    """Execute full Golden Evaluation suite and optionally persist latest_report.json."""
    t0 = time.perf_counter()
    cases: list[dict[str, Any]] = json.loads(DATASET_PATH.read_text(encoding="utf-8"))
    results: list[dict[str, Any]] = []
    by_category: dict[str, dict[str, int]] = {}

    passed_count = 0
    for case in cases:
        cat = str(case.get("category", "general"))
        bucket = by_category.setdefault(cat, {"total": 0, "passed": 0})
        bucket["total"] += 1

        ct0 = time.perf_counter()
        passed, observed = _evaluate_case(case)
        elapsed_ms = round((time.perf_counter() - ct0) * 1000.0, 2)
        if passed:
            passed_count += 1
            bucket["passed"] += 1

        results.append(
            {
                "id": case["id"],
                "category": cat,
                "name": case["name"],
                "passed": passed,
                "elapsed_ms": elapsed_ms,
                "observed": observed,
            }
        )

    total = len(cases)
    report: dict[str, Any] = {
        "status": "ok" if passed_count == total else "degraded",
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "total_cases": total,
        "passed_cases": passed_count,
        "pass_rate_pct": round((passed_count / total) * 100.0, 1) if total else 0.0,
        "duration_ms": round((time.perf_counter() - t0) * 1000.0, 2),
        "categories": {
            cat: {
                **counts,
                "pass_rate_pct": round((counts["passed"] / counts["total"]) * 100.0, 1)
                if counts["total"]
                else 0.0,
            }
            for cat, counts in by_category.items()
        },
        "results": results,
    }

    if save_report:
        DEFAULT_REPORT_PATH.write_text(
            json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
        )
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description="MarketElite Multi-Track Golden & Agent Benchmark Suite")
    parser.add_argument("--no-save", action="store_true", help="Do not overwrite latest_report.json")
    parser.add_argument(
        "--full",
        action="store_true",
        help="Run complete 4-Track evaluation suite (Golden + RAG + Agent Sandbox + Red-Team)",
    )
    parser.add_argument(
        "--pass-k",
        type=int,
        default=3,
        help="Number of repeated perturbation trials for Track 3 pass^k reliability check",
    )
    args = parser.parse_args()

    if args.full:
        import asyncio
        import os

        if os.name == "nt":
            asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

        from app.core.config import get_settings  # noqa: E402
        from app.services.eval_engine import run_full_eval_suite  # noqa: E402

        report = asyncio.run(
            run_full_eval_suite(
                settings=get_settings(),
                session_factory=None,
                pass_k_trials=args.pass_k,
                trigger_source="cli",
                save_file_report=not args.no_save,
            )
        )
        print(
            f"[MarketElite 4-Track Evals] {report['passed_cases']}/{report['total_cases']} passed "
            f"({report['pass_rate_pct']}%) in {report['duration_ms']}ms"
        )
        for tid, ts in report.get("tracks", {}).items():
            print(f"  - {tid}: {ts['passed']}/{ts['total']} ({ts['pass_rate_pct']}%)")
    else:
        report = run_golden_eval(save_report=not args.no_save)
        print(
            f"[MarketElite Evals] {report['passed_cases']}/{report['total_cases']} passed "
            f"({report['pass_rate_pct']}%) in {report['duration_ms']}ms"
        )
        for cat, stats in report["categories"].items():
            print(f"  - {cat}: {stats['passed']}/{stats['total']} ({stats['pass_rate_pct']}%)")

    if report["passed_cases"] != report["total_cases"]:
        sys.exit(1)


if __name__ == "__main__":
    main()
