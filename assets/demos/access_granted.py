"""Fake intrusion sequence. Harmless: it only prints."""

import sys
import time

GREEN = "\033[38;5;46m"
DIM = "\033[38;5;22m"
OFF = "\033[0m"

STEPS = [
    ("resolving host", 0.9),
    ("handshaking", 0.7),
    ("enumerating ports", 1.2),
    ("bypassing firewall", 1.5),
    ("escalating privileges", 1.0),
    ("access granted", 0.6),
]


def bar(pct, width=28):
    fill = "#" * int(width * pct)
    empty = "." * (width - len(fill))
    return "[" + GREEN + fill + DIM + empty + OFF + "] " + str(round(pct * 100)) + "%"


print(DIM + "connecting to node 127.0.0.1" + OFF)
for label, dur in STEPS:
    for i in range(21):
        line = "  " + label.ljust(22) + bar(i / 20)
        sys.stdout.write("\r" + line)
        sys.stdout.flush()
        time.sleep(dur / 20)
    print()

total = sum(d for _, d in STEPS)
print()
print(GREEN + "ACCESS GRANTED" + OFF + " in " + str(round(total, 1)) + "s")
