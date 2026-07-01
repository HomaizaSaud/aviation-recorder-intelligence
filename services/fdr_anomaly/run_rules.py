"""CLI entry point: python3 -m services.fdr_anomaly.run_rules <path>"""
import argparse
import json

from services.fdr_anomaly.rules import evaluate_rules

parser = argparse.ArgumentParser(description="FDR rule-based anomaly detection")
parser.add_argument("path", help="Path to FDR CSV or Excel file")
args = parser.parse_args()

print(json.dumps(evaluate_rules(args.path), indent=2))
