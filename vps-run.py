#!/usr/bin/env python3
"""VPS launcher for the Clock-Burst engine (EC2 / Oracle / any Ubuntu VM).

Usage (after `git clone <repo> bot && cd bot`):
    CFG_B64='<from manager>' ACC_B64='<from manager>' \\
        nohup python3 vps-run.py > burst.log 2>&1 &

Get the CFG_B64/ACC_B64 line from the manager:
  Clock-Burst panel -> "Copy VPS settings" button.

This writes bot.py (template + your settings) and execs it, so the
process you see in `ps` is the bot itself and Colab-style logs stream
to burst.log. Stop with:  kill <pid>  (or pkill -f bot.py)
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
TPL = os.path.join(HERE, "colab-clockburst.py")
OUT = os.path.join(HERE, "bot.py")


def main():
    cfg = os.environ.get("CFG_B64", "").strip().strip("'\"")
    acc = os.environ.get("ACC_B64", "").strip().strip("'\"")
    if not cfg or not acc or "__" in cfg or "__" in acc:
        print("Missing payloads. Run it like this:", flush=True)
        print("  CFG_B64='<copy from manager>' "
              "ACC_B64='<copy from manager>' python3 vps-run.py",
              flush=True)
        return 2
    if not os.path.exists(TPL):
        print(f"Template not found: {TPL}", flush=True)
        return 2
    tpl = open(TPL, encoding="utf-8").read()
    if "__CONFIG_B64__" not in tpl or "__ACCOUNTS_B64__" not in tpl:
        print("Template has no placeholders — update colab-clockburst.py",
              flush=True)
        return 2
    cell = tpl.replace("__CONFIG_B64__", cfg).replace(
        "__ACCOUNTS_B64__", acc)
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(cell)
    print(f"Wrote {OUT} ({len(cell) // 1024}KB) — starting bot...",
          flush=True)
    os.execv(sys.executable, [sys.executable, OUT])


if __name__ == "__main__":
    sys.exit(main())
